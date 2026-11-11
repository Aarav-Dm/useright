// Batch 8 §3: the renewal tick (docs/batch-8.md and its binding Plan fixes 1-6). Called by POST /api/cron/tick (an
// external daily pinger) and by the demo panel. Idempotent: running it twice changes nothing.
//   1. An active licence within 7 days of its end gets one renewal: a new deal (source 'renewal', no AI) and a pending
//      version with the same scope, priced from the CURRENT rate card through gap(). The existing policy engine
//      decides: if the client opted in and R1-R5 pass, sendInvoice() sends it; otherwise it waits in Ask me ("Renew?").
//   2. An active licence past its end (no paid renewal, or the renewal would have superseded it) expires: downloads
//      stop, an Expired receipt and a revocation receipt are issued, and a ledger event is written. Unsent or unpaid
//      renewal invoices are left alone; paying one later re-licenses through the normal grant path.
// Every decision here uses clock.now() (real time + the demo offset in demo mode).
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Db, Queryable } from '../db/client';
import { creatorCard } from './briefs';
import { demoMode, now as clockNow, RENEWAL_WINDOW_MS } from './clock';
import { NOT_SEEDED_DEMO_SQL } from './demo';
import { scopeParts, shortDate } from './format';
import { gap } from './gap';
import { evaluate, lockCreator, RENEWAL_NEEDS_OK } from './policy';
import type { Scope } from './pricing';
import { issueExpiryReceipts } from './receipts';
import type { InvoiceApi } from './paypal/invoices';
import { sendInvoice, type SendResult } from './send';
import { versionHash } from './versions';

export { RENEWAL_WINDOW_MS };
type Env = Record<string, string | undefined>;

export type TickDeps = { db: Db; api: InvoiceApi; env?: Env; real?: () => number };
/** Review fix 9 (review 6, 9): `deals` are the briefs of renewals opened or sent by this tick, for the demo panel's link;
 * `seededExpired` counts the seeded demo licences inside `expired`, so the panel labels them Demo. */
export type TickResult = { now: string; renewals: { created: number; sent: number; held: number; cancelled: number }; expired: number; seededExpired: number; deals: string[] };

/**
 * B8 review fix 7 (review 4): tick events carry real time (the database's now()), so a payment that answers them later
 * sorts after them in the ledger and the bell. In demo mode the demo date goes in the detail (`demoDate`) and the text.
 */
async function event(q: Queryable, creatorId: string, kind: string, detail: Record<string, unknown> & { message: string }, at: Date, demo: boolean) {
  const d = demo ? { ...detail, demoDate: at.toISOString(), message: `${detail.message} Demo date: ${shortDate(at)}.` } : detail;
  await q.query(`insert into events (creator_id, kind, detail) values ($1, $2, $3)`, [creatorId, kind, JSON.stringify(d)]);
}

/** Seeded walkthrough licences (`SEED-DEMO-` payments) are display data: they are never renewed through PayPal, except
 * the one seeded to film a renewal (`SEED-DEMO-RENEW-`, review fix 8). */
const NOT_SEEDED_DEMO = NOT_SEEDED_DEMO_SQL;

/** Renewals due within the 7-day window, one per licence ever (unique index on renewal_of). */
const dueRenewals = (q: Queryable, creatorId: string, at: Date) => q.query<{ id: string }>(
  `select v.id from licence_versions v
    where v.creator_id = $1 and v.status = 'active' and v.end_at is not null and v.end_at - interval '7 days' <= $2
      and not exists (select 1 from licence_versions c where c.renewal_of = v.id) and ${NOT_SEEDED_DEMO}
    order by v.end_at`, [creatorId, at]);

/**
 * Review fix 3: an open renewal that never reached PayPal (no invoice row at all) is offered again when it never got
 * an answer (crash before evaluate: no policy), passed or was approved but was not sent (APP_SECRET missing), or was
 * held only because the client had not asked and has asked since. A renewal held on any other rule stays in Ask me.
 * One that reached PayPal and failed keeps its rows for Retry, which reconciles first, so nothing is ever resent blind
 * and a PayPal refusal is not retried on every tick.
 */
const renewalsToOfferAgain = (q: Queryable, creatorId: string) => q.query<{ id: string; brief_id: string }>(
  `select c.id, c.brief_id from licence_versions c join licence_versions p on p.id = c.renewal_of
    where c.creator_id = $1 and c.status = 'pending' and c.send_state in ('idle', 'failed') and c.withdrawn_at is null
      and not exists (select 1 from invoices i where i.version_id = c.id)
      and (c.policy is null or (c.policy->>'pass')::boolean or c.send_state = 'failed'
        or (p.renewal_opt_in
          and exists (select 1 from jsonb_array_elements(c.policy->'results') r where r->>'code' = $2 and not (r->>'pass')::boolean)
          and not exists (select 1 from jsonb_array_elements(c.policy->'results') r where r->>'code' <> $2 and not (r->>'pass')::boolean)))
    order by c.created_at`, [creatorId, RENEWAL_NEEDS_OK]);

/** Terms that ended and are still active. */
const endedLicences = (q: Queryable, creatorId: string, at: Date) => q.query<{ id: string }>(
  `select id from licence_versions where creator_id = $1 and status = 'active' and end_at is not null and end_at <= $2 order by end_at`, [creatorId, at]);

/**
 * review B8 re-review N2: the last tick left work undone at this clock, so the clock must not move until a tick finishes.
 * Read from the rows, so it survives a reload or a response that never arrived.
 */
export async function tickPending(q: Queryable, creatorId: string, at: Date): Promise<boolean> {
  return (await dueRenewals(q, creatorId, at)).length > 0 || (await renewalsToOfferAgain(q, creatorId)).length > 0 || (await endedLicences(q, creatorId, at)).length > 0;
}

export async function runTick(deps: TickDeps): Promise<TickResult> {
  const { db } = deps;
  const at = await clockNow(db, deps.env, deps.real);
  const out: TickResult = { now: at.toISOString(), renewals: { created: 0, sent: 0, held: 0, cancelled: 0 }, expired: 0, seededExpired: 0, deals: [] };
  const creators = await db.query<{ id: string }>(`select id from creators order by created_at`);
  for (const { id: creatorId } of creators) {
    // 1. Renewals due.
    const offered = new Set<string>();
    for (const { id } of await dueRenewals(db, creatorId, at)) {
      const renewal = await createRenewal(db, creatorId, id);
      if (!renewal) continue;
      offered.add(renewal.id);
      out.deals.push(renewal.briefId);
      out.renewals.created += 1;
      out.renewals[await offerRenewal(deps, renewal.id, at)] += 1;
    }
    // 1b. Renewals to offer again.
    for (const { id, brief_id } of await renewalsToOfferAgain(db, creatorId)) {
      if (offered.has(id)) continue;
      const o = await offerRenewal(deps, id, at);
      if (o !== 'held') out.renewals[o] += 1;
      if (o === 'sent') out.deals.push(brief_id);
    }
    // 2. Terms that ended.
    for (const { id } of await endedLicences(db, creatorId, at)) {
      const e = await expireVersion(db, creatorId, id, at, demoMode(deps.env));
      if (e) out.expired += 1;
      if (e === 'seeded') out.seededExpired += 1;
    }
  }
  return out;
}

/**
 * The renewal deal and version for an active licence, or null when one exists already (or the licence moved on).
 * Review fix 9 (review 8): the client's renewal choice is a standing one, so the renewal version starts with the parent's.
 */
async function createRenewal(db: Db, creatorId: string, parentId: string): Promise<{ id: string; briefId: string } | null> {
  return db.transaction(async (tx) => {
    await lockCreator(tx, creatorId);
    const [p] = await tx.query<{ id: string; client_id: string; asset_id: string; scope: Scope; version_no: number; status: string; end_at: Date; renewal_opt_in: boolean }>(
      `select id, client_id, asset_id, scope, version_no, status, end_at, renewal_opt_in from licence_versions where id = $1 for update`, [parentId]);
    if (!p || p.status !== 'active') return null;
    const [taken] = await tx.query(`select 1 from licence_versions where renewal_of = $1`, [parentId]);
    if (taken) return null;
    // Spec §3.2 "renewal at current card": the same scope priced through gap() against no licence at today's card.
    const card = await creatorCard(tx, creatorId);
    const priced = gap(p.scope, null, 0, card);
    const words = scopeParts(p.scope).map((x) => x.label).join(', ');
    const [brief] = await tx.query<{ id: string }>(
      `insert into briefs (creator_id, client_id, source, raw, asset_id, claimed_sender, state)
       values ($1, $2, 'renewal', $3, $4, null, 'extracted') returning id`,
      [creatorId, p.client_id, `Renewal of licence v${p.version_no} (${words}), which ends ${shortDate(p.end_at)}. Opened by the agent.`, p.asset_id]);
    const hash = versionHash({ scope: p.scope, totalCents: priced.totalCents, assetId: p.asset_id, clientId: p.client_id, parentId: p.id });
    const [v] = await tx.query<{ id: string }>(
      `insert into licence_versions
         (creator_id, client_id, asset_id, parent_id, renewal_of, version_no, scope, rate_card, total_cents, paid_cents, content_hash, status, brief_id, renewal_opt_in)
       values ($1, $2, $3, $4, $4, $5, $6, $7, $8, 0, $9, 'pending', $10, $11)
       on conflict (renewal_of) where renewal_of is not null do nothing
       returning id`,
      [creatorId, p.client_id, p.asset_id, p.id, p.version_no + 1, JSON.stringify(p.scope), JSON.stringify(card), priced.totalCents, hash, brief!.id, p.renewal_opt_in]);
    if (!v) throw new Error('createRenewal: a renewal appeared under the lock'); // rolls the brief back too
    return { id: v.id, briefId: brief!.id };
  });
}

/**
 * The existing policy engine, in autopilot mode at the tick's clock. All pass: sendInvoice() ('sent'). Otherwise the
 * stored failing policy puts it in Ask me ('held'); a client who did not opt in fails RENEW (plan fix 4). A renewal the
 * creator already approved is sent on the approval path, as retry() does (review fix 3).
 */
async function offerRenewal(deps: TickDeps, versionId: string, at: Date): Promise<'sent' | 'held' | 'cancelled'> {
  const { db, api } = deps;
  const demo = demoMode(deps.env);
  // The rules judge at the tick's clock; their ledger rows are stamped with real time (review fix 7).
  const rules = { mode: 'autopilot' as const, now: at, ...(demo ? { demoDate: at } : {}) };
  let ev = await evaluate(db, versionId, rules);
  if (!ev.ok) return 'held';
  const creatorId = ev.version.creator_id;
  const base = { briefId: ev.version.brief_id, versionId, parentId: ev.version.renewal_of, amountCents: ev.version.total_cents };
  let s: SendResult | null = null;
  if (ev.policy.pass) {
    s = await sendInvoice(db, api, versionId, { mode: 'autopilot' });
    if (!s.ok && (s.code === 'over_deal_cap' || s.code === 'renewal_opt_out')) {
      // As in runAutopilot: the cap dropped, or (review fix 1) the client unticked renewal, between evaluate() and
      // the send. Evaluate again so R2 or RENEW fails and it goes to Ask me.
      ev = await evaluate(db, versionId, rules);
      s = ev.ok && ev.policy.pass ? await sendInvoice(db, api, versionId, { mode: 'autopilot' }) : null;
    }
  }
  if (!s && ev.ok && !ev.policy.hardBlock && (await db.query(`select 1 from approvals where version_id = $1`, [versionId])).length > 0) {
    s = await sendInvoice(db, api, versionId, { mode: 'approval' }); // claim() re-checks hash, amount and recipient
  }
  if (s?.ok) {
    await event(db, creatorId, 'renewal.sent', { ...base, invoiceNumber: s.invoiceNumber, paypalInvoiceId: s.paypalInvoiceId,
      message: ev.ok && ev.policy.pass ? 'Renewal invoice sent: the client asked for one and every rule passed.' : 'Renewal invoice sent after your approval.' }, at, demo);
    return 'sent';
  }
  if (s && !s.ok) {
    if (s.code === 'renewal_stale') return 'cancelled'; // review fix 2: cancelled with its own ledger row
    if (s.code === 'app_secret_missing') {
      // Review fix 3: refused before any invoice row, so nothing else records it. Shown in Ask me; the next tick retries.
      await db.query(`update licence_versions set send_state = 'failed', send_error = $2 where id = $1 and send_state in ('idle', 'failed')`, [versionId, s.error]);
    }
    return 'held'; // a PayPal failure is already recorded and shown in Ask me with Retry
  }
  if (!ev.ok) return 'held';
  const held = ev.policy.results.filter((r) => !r.pass).map((r) => r.message);
  await event(db, creatorId, 'renewal.draft', { ...base,
    message: `Renewal waits for your OK in Ask me. ${held.join(' ')}`.trim() }, at, demo);
  return 'held';
}

/** Ends an active licence whose term is over: status expired, download links voided, two receipts, one event.
 * Returns 'seeded' for a seeded demo licence (its event is Demo-labelled), 'live' otherwise, null when nothing ended. */
async function expireVersion(db: Db, creatorId: string, versionId: string, at: Date, demoClock: boolean): Promise<'live' | 'seeded' | null> {
  return db.transaction(async (tx) => {
    await lockCreator(tx, creatorId);
    const [v] = await tx.query<{ status: string; end_at: Date | null; brief_id: string | null; demo: boolean }>(
      `select v.status, v.end_at, v.brief_id,
              exists (select 1 from payments p where p.version_id = v.id and p.paypal_txn_id like 'SEED-DEMO-%') as demo
         from licence_versions v where v.id = $1 for update`, [versionId]);
    if (!v || v.status !== 'active' || !v.end_at || new Date(v.end_at).getTime() > at.getTime()) return null;
    await tx.query(`update licence_versions set status = 'expired' where id = $1`, [versionId]);
    await tx.query(`update download_tokens set voided_at = now() where version_id = $1 and voided_at is null`, [versionId]);
    const receipts = await issueExpiryReceipts(tx, versionId);
    await event(tx, creatorId, 'expired', {
      versionId, briefId: v.brief_id, receiptId: receipts?.expired ?? null, revocationReceiptId: receipts?.revocation ?? null, demo: v.demo || undefined,
      message: 'The licence term ended without a paid renewal; downloads stopped.',
    }, at, demoClock);
    return v.demo ? 'seeded' : 'live';
  });
}

/**
 * POST /api/cron/tick auth: the CRON_SECRET header, compared in constant time. Missing secret = 503 (not set up),
 * wrong or absent header = 401. The secret is never logged or echoed.
 */
export function cronAuth(req: Request, env: Env = process.env): { ok: true } | { ok: false; status: 401 | 503; error: string } {
  const secret = env.CRON_SECRET;
  if (!secret) return { ok: false, status: 503, error: 'the tick is not configured' };
  const given = req.headers.get('x-cron-secret') ?? '';
  const digest = (s: string) => createHash('sha256').update(s, 'utf8').digest();
  if (!given || !timingSafeEqual(digest(given), digest(secret))) return { ok: false, status: 401, error: 'unauthorized' };
  return { ok: true };
}
