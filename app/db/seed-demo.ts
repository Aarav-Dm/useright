// Demo seed v2 (batch 7, 7A): enough deals for every dashboard state, so `npm run db:init` gives a full demo.
// Runs after seed() (Imani, her card, assets, Northwind's paid v1). Writes rows directly, through the same pure
// helpers the live path uses (runChecks, gap, versionHash, invoiceNumberFor, grantReceiptBody), so every row is
// one the read models already understand. Nothing here is PayPal evidence: invoice ids start `INV2-DEMO-`,
// transactions `SEED-DEMO-` (re-checks skip SEED- payments), and every event detail carries `demo: true`.
//
// Deals, oldest first (status as dealState() derives it):
//   Riverbend Outfitters · Rocky Beach   v1 paid then refunded              -> Refunded
//   Riverbend Outfitters · Rocky Beach   v2 print add-on, withdrawn by refund -> Invoice cancelled (+ Ask alert)
//   Quayside Press · Laptop Desk from Above            v1 paid, file unlocked              -> Paid, file unlocked
//   Pinecrest Hotels · Harbor Light            v1 paid, renewal requested ($300)   -> Paid (the filmed renewal, B8)
//   Saltmarsh Studio · Pebble Shore and Pines            TV quote the creator rejected       -> Rejected
//   Pinecrest Hotels · Vineyard Harvest      v1 invoice sent by autopilot        -> Invoiced
//   Northwind Coffee · Morning Pour            v2 billboard, $900, stopped by R2+R4 -> Ask me (needs approval)
//   unknown sender · Waterfall Over Boulders           request from someone not a client   -> Needs you
//   Orchard Lane Bakery · Laptop and Coffee Cup    read and priced, no quote yet        -> Ready
import type { Db, Queryable } from './client';
import { licensedFile } from '../lib/access';
import type { Transcript } from '../lib/ai/types';
import type { PolicyResult, RuleResult, StoredChecks } from '../lib/briefs';
import { runChecks } from '../lib/checks';
import { gap } from '../lib/gap';
import { printFile, webFile } from '../lib/placeholder-files';
import { unsellable } from '../lib/policy-flags';
import type { RateCard, Scope } from '../lib/pricing';
import { DEMO_INVOICE_PREFIX, DEMO_RENEWABLE_TXN_PREFIX, DEMO_TXN_PREFIX, NOT_SEEDED_DEMO_SQL } from '../lib/demo';
import { grantReceiptBody, type ReceiptBody } from '../lib/receipts';
import { sha256Bytes } from '../lib/storage';
import { newToken } from '../lib/tokens';
import { invoiceNumberFor, versionHash } from '../lib/versions';

export type DemoResult = { created: boolean; briefs: Record<string, string> };

const MARKER_EMAIL = 'hello@orchardlane.example';
const MODEL = 'demo-seed';

const DEMO_CLIENTS = [
  { key: 'orchard', name: 'Orchard Lane Bakery', email: MARKER_EMAIL, allowed: true },
  { key: 'pinecrest', name: 'Pinecrest Hotels', email: 'brand@pinecresthotels.example', allowed: true },
  { key: 'quayside', name: 'Quayside Press', email: 'licensing@quaysidepress.example', allowed: true },
  { key: 'riverbend', name: 'Riverbend Outfitters', email: 'marketing@riverbend.example', allowed: true },
  { key: 'saltmarsh', name: 'Saltmarsh Studio', email: 'studio@saltmarsh.example', allowed: false },
] as const;
type ClientKey = (typeof DEMO_CLIENTS)[number]['key'] | 'northwind';

type Use = { optionId: string; quote: string };
type Settings = { per_deal_cap_cents: number; daily_max_sends: number; rolling30_cap_cents: number; auto_channels: string[] };
type Client = { id: string; name: string; email: string; allowed: boolean };
type Asset = { id: string; title: string; index: number };
type Licence = { versionId: string; versionNo: number; scope: Scope; rateCard: RateCard; paidCents: number };

const usd = (c: number) => `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const hours = (n: number) => n * 3600_000;
const days = (n: number) => n * 24 * 3600_000;

function addMonths(d: Date, months: number): Date {
  const out = new Date(d);
  out.setUTCMonth(out.getUTCMonth() + months);
  return out;
}

async function one<T extends Record<string, unknown>>(tx: Queryable, text: string, params: unknown[]): Promise<T> {
  const rows = await tx.query<T>(text, params);
  if (!rows[0]) throw new Error(`seed-demo: no row returned for: ${text}`);
  return rows[0];
}

/** The rule results runRules() would store, from the same inputs. R3 counts no earlier autopilot sends. */
function policyFor(p: { total: number; client: Client; s: Settings; newOptionIds: string[]; checksClear: boolean; at: Date }): PolicyResult {
  const r = (rule: string, pass: boolean, code: string, message: string): RuleResult => ({ rule, pass, code, message });
  const results: RuleResult[] = [];
  results.push(p.client.allowed
    ? r('R1', true, 'client_allowed', 'The client is on your allowed list.')
    : r('R1', false, 'client_not_allowed', 'This client is not on your list of clients the agent may invoice.'));
  const cap = p.s.per_deal_cap_cents;
  results.push(p.total <= cap
    ? r('R2', true, 'under_deal_cap', `${usd(p.total)} is within your ${usd(cap)} per-deal cap.`)
    : r('R2', false, `over_deal_cap:${p.total}:${cap}`, `${usd(p.total)} exceeds your ${usd(cap)} per-deal cap.`));
  const rolling = p.s.rolling30_cap_cents;
  results.push(p.total > rolling
    ? r('R3', false, `rolling_cap_reached:${p.total}:${rolling}`, `This would bring the client to ${usd(p.total)} in 30 days, over your ${usd(rolling)} cap.`)
    : r('R3', true, 'within_send_limits', `0 of ${p.s.daily_max_sends} sends today; client at ${usd(p.total)} of ${usd(rolling)} in 30 days.`));
  const blocked = unsellable(p.newOptionIds, { autoChannels: p.s.auto_channels });
  if (blocked.length === 0) results.push(r('R4', true, 'all_sellable', 'Every new option is one the agent may sell on its own.'));
  for (const id of blocked) {
    const label = id === 'exclusive' ? 'Exclusive rights' : id === 'OOH' ? 'Out-of-home' : id[0]!.toUpperCase() + id.slice(1);
    results.push(r('R4', false, `needs_approval:${id}`, `${label} needs your approval.`));
  }
  results.push(p.checksClear
    ? r('R5', true, 'checks_clear', 'Every request check is clear.')
    : r('R5', false, 'checks_not_clear', 'The request checks are not all clear.'));
  return { pass: results.every((x) => x.pass), hardBlock: false, results, evaluatedAt: p.at.toISOString(), mode: 'autopilot' };
}

/**
 * Idempotent: does nothing once the demo deals and the filmed renewal exist. Requires seed() to have run.
 * review B8 re-review N1: a database seeded before B8 has the deals but not the renewal, so that one part is added alone.
 */
export async function seedDemo(db: Db, now: Date = new Date()): Promise<DemoResult> {
  return db.transaction(async (tx) => {
    const [creator] = await tx.query<{ id: string; name: string }>(`select id, name from creators where slug = 'imani'`);
    if (!creator) throw new Error('seed-demo: run seed() first (creator imani is missing)');
    const creatorId = creator.id;
    const [marker] = await tx.query(`select 1 from clients where creator_id = $1 and lower(email) = $2`, [creatorId, MARKER_EMAIL]);
    const [renewable] = await tx.query(`select 1 from payments where creator_id = $1 and paypal_txn_id like $2`, [creatorId, `${DEMO_RENEWABLE_TXN_PREFIX}%`]);
    if (marker && renewable) return { created: false, briefs: {} };

    const s = await one<Settings>(tx, `select per_deal_cap_cents, daily_max_sends, rolling30_cap_cents, auto_channels from creator_settings where creator_id = $1`, [creatorId]);
    const at = (msAgo: number) => new Date(now.getTime() - msAgo);

    // ---- clients and assets ----
    const clients = {} as Record<ClientKey, Client>;
    for (const c of DEMO_CLIENTS) {
      const [found] = await tx.query<{ id: string }>(`select id from clients where creator_id = $1 and lower(email) = $2`, [creatorId, c.email]);
      const { id } = found ?? await one<{ id: string }>(tx,
        `insert into clients (creator_id, name, email, allowed, created_at) values ($1, $2, $3, $4, $5) returning id`,
        [creatorId, c.name, c.email, c.allowed, at(days(30))]);
      clients[c.key] = { id, name: c.name, email: c.email, allowed: c.allowed };
    }
    clients.northwind = await one<Client>(tx, `select id, name, email, allowed from clients where creator_id = $1 and lower(email) = 'buying@northwind.example'`, [creatorId]);

    // A photo asset holds its photo's bytes; for the others, position in ensureAssetFiles' order decides the placeholder (and so a receipt's hash).
    const allAssets = await tx.query<{ id: string; title: string; creator_id: string }>(`select id, title, creator_id from assets order by created_at`);
    const asset = (title: string): Asset => {
      const index = allAssets.findIndex((a) => a.creator_id === creatorId && a.title === title);
      if (index < 0) throw new Error(`seed-demo: asset "${title}" is missing`);
      return { id: allAssets[index]!.id, title, index };
    };
    const fileSha = async (a: Asset, scope: Scope) =>
      sha256Bytes(await (licensedFile(scope).file === 'print' ? printFile : webFile)(a.title, a.index));

    const event = (kind: string, detail: Record<string, unknown>, when: Date, rule: string | null = null) =>
      tx.query(`insert into events (creator_id, kind, rule, detail, created_at) values ($1, $2, $3, $4, $5)`,
        [creatorId, kind, rule, JSON.stringify({ ...detail, demo: true }), when]);

    /** Brief + intake event + confirmed transcript + extraction, priced against `licence` (null for a v1). */
    async function request(p: { client: Client | null; asset: Asset; source: 'paste'; lines: Transcript['lines']; uses: Use[]; licence: Licence | null; when: Date; suggestedCents?: number }) {
      const raw = p.lines.map((l) => `${l.speaker}: ${l.text}`).join('\n');
      const { id: briefId } = await one<{ id: string }>(tx,
        `insert into briefs (creator_id, client_id, asset_id, source, raw, state, created_at) values ($1, $2, $3, $4, $5, 'extracted', $6) returning id`,
        [creatorId, p.client?.id ?? null, p.asset.id, p.source, raw, p.when]);
      await event('intake.created', { briefId, source: p.source, fixture: null }, p.when);
      const { id: transcriptId } = await one<{ id: string }>(tx,
        `insert into transcripts (creator_id, client_id, source, raw, brief_id, lines, confirmed_at, created_at) values ($1, $2, $3, $4, $5, $6, $7, $7) returning id`,
        [creatorId, p.client?.id ?? null, p.source, raw, briefId, JSON.stringify(p.lines), p.when]);
      const checks = runChecks({ transcript: { lines: p.lines }, extraction: { uses: p.uses, suggestedPriceCents: p.suggestedCents ?? null }, current: p.licence?.scope ?? null });
      let status = checks.status;
      let reasons = checks.reasons;
      if (!p.client) { status = 'needs_creator'; reasons = ['unknown_sender', ...reasons.filter((r) => r !== 'unknown_sender')]; }
      const stored: StoredChecks = { kept: checks.kept, dropped: checks.dropped, requested: checks.requested };
      const { id: extractionId } = await one<{ id: string }>(tx,
        `insert into extractions (creator_id, client_id, source, raw, brief_id, transcript_id, status, reasons, model, suggested_price_cents, clarifying_question, raw_model, created_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) returning id`,
        [creatorId, p.client?.id ?? null, p.source, JSON.stringify(stored), briefId, transcriptId, status, reasons, MODEL,
          p.suggestedCents ?? null, checks.clarifyingQuestion, JSON.stringify({ demo: true, uses: p.uses }), p.when]);
      if (status !== 'ready' && p.client) throw new Error(`seed-demo: request for ${p.asset.title} did not pass its checks: ${reasons.join(', ')}`);
      return { briefId, extractionId, requested: checks.requested, checksClear: status === 'ready' && reasons.length === 0 };
    }

    /** A pending version from gap(), its policy and one rule event per result. */
    async function quote(p: { briefId: string; extractionId: string; requested: Scope | null; checksClear: boolean; client: Client; asset: Asset; licence: Licence | null; card: RateCard; when: Date }) {
      if (!p.requested) throw new Error('seed-demo: nothing requested to price');
      const g = gap(p.requested, p.licence?.scope ?? null, p.licence?.paidCents ?? 0, p.licence?.rateCard ?? p.card);
      const parentId = p.licence?.versionId ?? null;
      const policy = policyFor({ total: g.totalCents, client: p.client, s, newOptionIds: g.newOptionIds, checksClear: p.checksClear, at: p.when });
      const hash = versionHash({ scope: g.combined, totalCents: g.totalCents, assetId: p.asset.id, clientId: p.client.id, parentId });
      const { id: versionId } = await one<{ id: string }>(tx,
        `insert into licence_versions
           (creator_id, client_id, asset_id, parent_id, version_no, scope, rate_card, total_cents, paid_cents, content_hash, status,
            brief_id, extraction_id, policy, created_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, 0, $9, 'pending', $10, $11, $12, $13) returning id`,
        [creatorId, p.client.id, p.asset.id, parentId, (p.licence?.versionNo ?? 0) + 1, JSON.stringify(g.combined),
          JSON.stringify(p.licence?.rateCard ?? p.card), g.totalCents, hash, p.briefId, p.extractionId, JSON.stringify(policy), p.when]);
      for (const r of policy.results) {
        await event('rule', { briefId: p.briefId, versionId, pass: r.pass, code: r.code, message: r.message, mode: policy.mode }, p.when, r.rule);
      }
      return { versionId, totalCents: g.totalCents, scope: g.combined, policy };
    }

    // Counted so ids added to an already-seeded database do not collide.
    let invoiceSeq = (await one<{ n: number }>(tx, `select count(*)::int as n from invoices where creator_id = $1 and paypal_invoice_id like $2`, [creatorId, `${DEMO_INVOICE_PREFIX}%`])).n;
    /** Autopilot send: invoice row, version marked sent, invoice.creating + invoice.sent events. */
    async function send(p: { briefId: string; versionId: string; totalCents: number; client: Client; when: Date }) {
      invoiceSeq += 1;
      const invoiceNumber = invoiceNumberFor(p.versionId);
      const paypalInvoiceId = `${DEMO_INVOICE_PREFIX}SEED-0000-${String(invoiceSeq).padStart(4, '0')}`;
      const { id: invoiceId } = await one<{ id: string }>(tx,
        `insert into invoices (creator_id, version_id, invoice_number, paypal_invoice_id, state, recipient_email, sent_at, created_at)
         values ($1, $2, $3, $4, 'sent', $5, $6, $6) returning id`,
        [creatorId, p.versionId, invoiceNumber, paypalInvoiceId, p.client.email, p.when]);
      await tx.query(`update licence_versions set rail = 'invoice', send_state = 'sent' where id = $1`, [p.versionId]);
      await event('invoice.creating', { briefId: p.briefId, versionId: p.versionId, invoiceNumber, mode: 'autopilot' }, p.when);
      await event('invoice.sent', { briefId: p.briefId, versionId: p.versionId, invoiceNumber, paypalInvoiceId, mode: 'autopilot', totalCents: p.totalCents }, new Date(p.when.getTime() + 2000));
      return { invoiceId, invoiceNumber, paypalInvoiceId };
    }

    let txnSeq = 0;
    /** What grantIfPaid records for a verified payment, with demo ids. Returns the licence it became. */
    async function pay(p: { briefId: string; versionId: string; versionNo: number; parentVersionNo: number | null; scope: Scope; card: RateCard; totalCents: number; parentPaid: number; client: Client; asset: Asset; invoice: { invoiceId: string; invoiceNumber: string; paypalInvoiceId: string }; when: Date; txnPrefix?: string }) {
      txnSeq += 1;
      const txnId = `${p.txnPrefix ?? DEMO_TXN_PREFIX}${String(txnSeq).padStart(4, '0')}`;
      const start = p.when;
      const end = addMonths(start, p.scope.durationMonths);
      await tx.query(
        `update licence_versions set status = 'active', start_at = $2, end_at = $3, paid_cents = $4 where id = $1`,
        [p.versionId, start, end, p.parentPaid + p.totalCents]);
      await tx.query(
        `insert into payments (creator_id, version_id, paypal_txn_id, amount_cents, currency, payer_email, paid_at, created_at) values ($1, $2, $3, $4, 'USD', null, $5, $5)`,
        [creatorId, p.versionId, txnId, p.totalCents, p.when]);
      await tx.query(`update invoices set state = 'paid' where id = $1`, [p.invoice.invoiceId]);
      const body = grantReceiptBody({
        creatorName: creator!.name, clientName: p.client.name, clientEmail: p.client.email, payerEmail: null, title: p.asset.title, scope: p.scope,
        startAt: start, endAt: end, versionNo: p.versionNo, parentVersionNo: p.parentVersionNo,
      }, { txnId, amountCents: p.totalCents, fileSha256: await fileSha(p.asset, p.scope), paypalInvoiceId: p.invoice.paypalInvoiceId, invoiceNumber: p.invoice.invoiceNumber }, p.when);
      const receiptId = newToken();
      await tx.query(`insert into receipts (creator_id, version_id, status, public_id, body, created_at) values ($1, $2, 'active', $3, $4, $5)`,
        [creatorId, p.versionId, receiptId, JSON.stringify(body), p.when]);
      await event('grant', {
        briefId: p.briefId, versionId: p.versionId, pass: true, code: 'paid', source: 'webhook', paypalTxnId: txnId, amountCents: p.totalCents,
        receiptId, invoiceNumber: p.invoice.invoiceNumber, paypalInvoiceId: p.invoice.paypalInvoiceId,
        message: `Demo seed: recorded as paid in full, transaction ${txnId}. Not a PayPal capture.`,
      }, p.when);
      const licence: Licence = { versionId: p.versionId, versionNo: p.versionNo, scope: p.scope, rateCard: p.card, paidCents: p.parentPaid + p.totalCents };
      return { txnId, body, licence };
    }

    const card = Object.fromEntries((await tx.query<{ option_id: string; cents: number }>(
      `select option_id, cents from rate_card_options where creator_id = $1`, [creatorId])).map((r) => [r.option_id, r.cents])) as RateCard;
    const briefs: Record<string, string> = {};

    if (!marker) {
      // ---- Riverbend · Rocky Beach: v1 paid, refunded; v2 (print) withdrawn by that refund ----
      {
        const client = clients.riverbend;
        const a = asset('Rocky Beach');
        const when = at(days(24));
        const line = 'We would like to post Rocky Beach on our Instagram for the fall coast series, US only, for six months.';
        const req = await request({ client, asset: a, source: 'paste', when, licence: null,
          lines: [{ speaker: 'client', text: `Hi Imani, Riverbend here. ${line}` }],
          uses: [{ optionId: 'social', quote: line }, { optionId: 'US', quote: line }, { optionId: '6mo', quote: line }] });
        const q = await quote({ ...req, client, asset: a, licence: null, card, when });
        const inv = await send({ briefId: req.briefId, versionId: q.versionId, totalCents: q.totalCents, client, when });
        const paid = await pay({ briefId: req.briefId, versionId: q.versionId, versionNo: 1, parentVersionNo: null, scope: q.scope, card, totalCents: q.totalCents, parentPaid: 0, client, asset: a, invoice: inv, when: at(days(22)) });
        briefs.refunded = req.briefId;

        const when2 = at(days(9));
        const line2 = 'We also want to use it on printed trail maps in our stores.';
        const req2 = await request({ client, asset: a, source: 'paste', when: when2, licence: paid.licence,
          lines: [{ speaker: 'client', text: `The Instagram posts went well. ${line2}` }, { speaker: 'creator', text: 'Happy to add print. I will send an updated licence.' }],
          uses: [{ optionId: 'print', quote: line2 }] });
        const q2 = await quote({ ...req2, client, asset: a, licence: paid.licence, card, when: when2 });
        const inv2 = await send({ briefId: req2.briefId, versionId: q2.versionId, totalCents: q2.totalCents, client, when: when2 });
        briefs.withdrawn = req2.briefId;

        // Refund of v1 (revokeVersion): v1 refunded, invoice refunded, revocation receipt, revoked event; v2 withdrawn.
        const refundAt = at(days(6));
        await tx.query(`update licence_versions set status = 'refunded' where id = $1`, [q.versionId]);
        await tx.query(`update invoices set state = 'refunded' where id = $1`, [inv.invoiceId]);
        const revocation: ReceiptBody = { ...paid.body, kind: 'revocation', status: 'refunded', issuedAt: refundAt.toISOString(), revokedReason: 'Payment refunded in PayPal (demo seed)' };
        await tx.query(`insert into receipts (creator_id, version_id, status, public_id, body, created_at) values ($1, $2, 'refunded', $3, $4, $5)`,
          [creatorId, q.versionId, newToken(), JSON.stringify(revocation), refundAt]);
        await event('revoked', {
          versionId: q.versionId, briefId: req.briefId, source: 'webhook', paypalTxnId: paid.txnId, captureStatus: 'REFUNDED', amountCents: q.totalCents,
          message: 'Demo seed: recorded as refunded; licence revoked and downloads stopped.',
        }, refundAt);
        await tx.query(
          `update licence_versions set status = 'superseded', withdrawn_at = $2, withdraw_state = 'done', send_state = 'idle' where id = $1`,
          [q2.versionId, refundAt]);
        await tx.query(`update invoices set state = 'cancelled' where id = $1`, [inv2.invoiceId]);
        await event('invoice.cancelled', { briefId: req2.briefId, versionId: q2.versionId, paypalInvoiceId: inv2.paypalInvoiceId, invoiceNumber: inv2.invoiceNumber, source: 'refund' }, new Date(refundAt.getTime() + 1000));
        await event('revoked_by_parent_refund', {
          versionId: q2.versionId, briefId: req2.briefId,
          message: 'This quote was withdrawn because the licence it built on was refunded. Re-quote the deal.',
        }, new Date(refundAt.getTime() + 2000));
      }

      // ---- Quayside Press · Laptop Desk from Above: paid, file unlocked ----
      {
        const client = clients.quayside;
        const a = asset('Laptop Desk from Above');
        const when = at(days(5));
        const line = 'We want Laptop Desk from Above on our website and our Instagram for the spring list launch.';
        const line2 = 'It is for the US only and six months covers it.';
        const req = await request({ client, asset: a, source: 'paste', when, licence: null,
          lines: [{ speaker: 'client', text: line }, { speaker: 'creator', text: 'Great choice. Where and for how long?' }, { speaker: 'client', text: line2 }],
          uses: [{ optionId: 'web', quote: line }, { optionId: 'social', quote: line }, { optionId: 'US', quote: line2 }, { optionId: '6mo', quote: line2 }] });
        const q = await quote({ ...req, client, asset: a, licence: null, card, when });
        const inv = await send({ briefId: req.briefId, versionId: q.versionId, totalCents: q.totalCents, client, when });
        await pay({ briefId: req.briefId, versionId: q.versionId, versionNo: 1, parentVersionNo: null, scope: q.scope, card, totalCents: q.totalCents, parentPaid: 0, client, asset: a, invoice: inv, when: at(days(3)) });
        briefs.paid = req.briefId;
      }

      // ---- Saltmarsh Studio · Pebble Shore and Pines: TV quote, rejected by the creator ----
      {
        const client = clients.saltmarsh;
        const a = asset('Pebble Shore and Pines');
        const when = at(days(4));
        const line = 'We would like Pebble Shore and Pines for a TV commercial airing in the US for twelve months.';
        const req = await request({ client, asset: a, source: 'paste', when, licence: null,
          lines: [{ speaker: 'client', text: line }],
          uses: [{ optionId: 'TV', quote: line }, { optionId: 'US', quote: line }, { optionId: '12mo', quote: line }] });
        const q = await quote({ ...req, client, asset: a, licence: null, card, when });
        const rejectedAt = at(days(3) + hours(2));
        await tx.query(`update licence_versions set status = 'draft', rejected_at = $2 where id = $1`, [q.versionId, rejectedAt]);
        await event('rejected', { briefId: req.briefId, versionId: q.versionId }, rejectedAt);
        briefs.rejected = req.briefId;
      }

      // ---- Pinecrest Hotels · Vineyard Harvest: invoice sent by autopilot, waiting for payment ----
      {
        const client = clients.pinecrest;
        const a = asset('Vineyard Harvest');
        const when = at(days(2));
        const line = 'We would love to use Vineyard Harvest on our website for a year, across our US hotels.';
        const req = await request({ client, asset: a, source: 'paste', when, licence: null,
          lines: [{ speaker: 'client', text: line }],
          uses: [{ optionId: 'web', quote: line }, { optionId: 'US', quote: line }, { optionId: '12mo', quote: line }] });
        const q = await quote({ ...req, client, asset: a, licence: null, card, when });
        await send({ briefId: req.briefId, versionId: q.versionId, totalCents: q.totalCents, client, when: new Date(when.getTime() + 4000) });
        briefs.invoiced = req.briefId;
      }

      // ---- Northwind Coffee · Morning Pour: billboard on top of the seeded social v1. $1,200 - $300 paid = $900 ----
      {
        const client = clients.northwind;
        const a = asset('Morning Pour');
        const [v1] = await tx.query<{ id: string; version_no: number; scope: Scope; rate_card: RateCard; paid_cents: number }>(
          `select id, version_no, scope, rate_card, paid_cents from licence_versions where client_id = $1 and asset_id = $2 and status = 'active'`, [client.id, a.id]);
        if (!v1) throw new Error('seed-demo: Northwind\'s seeded Morning Pour licence is missing');
        const licence: Licence = { versionId: v1.id, versionNo: v1.version_no, scope: v1.scope, rateCard: v1.rate_card, paidCents: v1.paid_cents };
        const when = at(hours(20));
        const line = 'We want to put the Morning Pour photo on a billboard on I-95 for the next six months.';
        const req = await request({ client, asset: a, source: 'paste', when, licence,
          lines: [{ speaker: 'client', text: line }],
          uses: [{ optionId: 'billboard', quote: line }, { optionId: '6mo', quote: line }] });
        await quote({ ...req, client, asset: a, licence, card, when });
        briefs.needsApproval = req.briefId;
      }

      // ---- unknown sender · Waterfall Over Boulders: priced, but not tied to a client yet ----
      {
        const a = asset('Waterfall Over Boulders');
        const when = at(hours(5));
        const line = 'Can our outdoor brand post Waterfall Over Boulders on social in the US for six months?';
        const req = await request({ client: null, asset: a, source: 'paste', when, licence: null,
          lines: [{ speaker: 'client', text: `Hey! Love your glacier shots. ${line}` }],
          uses: [{ optionId: 'social', quote: line }, { optionId: 'US', quote: line }, { optionId: '6mo', quote: line }] });
        briefs.needsYou = req.briefId;
      }

      // ---- Orchard Lane Bakery · Laptop and Coffee Cup: read and priced, the agent has not quoted yet ----
      {
        const client = clients.orchard;
        const a = asset('Laptop and Coffee Cup');
        const when = at(hours(2));
        const line = 'We would love to use Laptop and Coffee Cup on our Instagram for the autumn menu launch, US only, for six months.';
        const req = await request({ client, asset: a, source: 'paste', when, licence: null, suggestedCents: 25000,
          lines: [{ speaker: 'client', text: `Hi Imani, this is Orchard Lane Bakery. ${line}` }, { speaker: 'creator', text: 'Thank you! Let me check the details.' }],
          uses: [{ optionId: 'social', quote: line }, { optionId: 'US', quote: line }, { optionId: '6mo', quote: line }] });
        briefs.ready = req.briefId;
      }
    }

    // ---- Pinecrest Hotels · Harbor Light: social licence ($300, under the cap), renewal invoice requested ----
    // B8 review fix 8: the licence the demo films renewing. It ends before every other licence the tick renews, so
    // "Advance to the next renewal" lands on it, and with the box ticked and every rule passing the tick sends a real
    // PayPal renewal invoice with no click. Its own payment is seeded (Demo-labelled); only its renewal is live.
    // Seeded last, so the ids of the deals above stay as they were. On an older database it must still be the soonest
    // to renew, so it ends at least a day before any other licence the tick would renew.
    if (!renewable) {
      const client = clients.pinecrest;
      const a = asset('Harbor Light');
      const [soonest] = await tx.query<{ end_at: Date | null }>(
        `select min(v.end_at) as end_at from licence_versions v where v.creator_id = $1 and v.status = 'active' and ${NOT_SEEDED_DEMO_SQL}`, [creatorId]);
      const latestPaid = soonest?.end_at ? addMonths(new Date(new Date(soonest.end_at).getTime() - days(1)), -6) : null;
      const paidAt = latestPaid && latestPaid < at(days(20)) ? latestPaid : at(days(20));
      const when = new Date(paidAt.getTime() - days(1));
      const line = 'We would like to share Harbor Light on our hotels’ Instagram, US only, for six months.';
      const req = await request({ client, asset: a, source: 'paste', when, licence: null,
        lines: [{ speaker: 'client', text: `Hello from Pinecrest Hotels. ${line}` }],
        uses: [{ optionId: 'social', quote: line }, { optionId: 'US', quote: line }, { optionId: '6mo', quote: line }] });
      const q = await quote({ ...req, client, asset: a, licence: null, card, when });
      const inv = await send({ briefId: req.briefId, versionId: q.versionId, totalCents: q.totalCents, client, when });
      await pay({ briefId: req.briefId, versionId: q.versionId, versionNo: 1, parentVersionNo: null, scope: q.scope, card, totalCents: q.totalCents, parentPaid: 0, client, asset: a, invoice: inv, when: paidAt, txnPrefix: DEMO_RENEWABLE_TXN_PREFIX });
      // The client ticked "Send me a renewal invoice before this licence ends" on the pay page.
      await tx.query(`update licence_versions set renewal_opt_in = true where id = $1`, [q.versionId]);
      briefs.renewable = req.briefId;
    }

    return { created: true, briefs };
  });
}
