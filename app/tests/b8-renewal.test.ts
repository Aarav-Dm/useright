// Batch 8 (docs/batch-8.md + its binding Plan fixes): renewal opt-in (§2), the tick (§3) and the demo panel routes (§4). PayPal is the in-memory mock; routes run
// through their real handlers on PGlite.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderToString } from 'react-dom/server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { POST as tickPOST } from '@/app/api/cron/tick/route';
import { POST as clockPOST } from '@/app/api/demo/clock/route';
import { GET as demoGET } from '@/app/api/demo/route';
import { POST as demoTickPOST } from '@/app/api/demo/tick/route';
import { GET as healthGET } from '@/app/healthz/route';
import { POST as renewalPOST } from '@/app/api/pay/[token]/renewal/route';
import ReceiptPage from '@/app/r/[id]/page';
import { bellItems } from '@/components/creator/activity-bell';
import { openPglite, type Db } from '../db/client';
import { migrate } from '../db/migrate';
import { seed, type SeedResult } from '../db/seed';
import { createAdapter, fixtureProvider } from '../lib/ai/extract';
import { advanceToNextRenewal } from '../lib/clock';
import { getBriefView, type AiFor } from '../lib/briefs';
import { grantIfPaid, revokeVersion, termFromDay, type GrantDeps } from '../lib/grant';
import { intake, type IntakeDeps } from '../lib/intake';
import { listAsk, listLedger } from '../lib/ledger';
import { consumeDownload, issueDownload, payView } from '../lib/pay';
import { evaluate, localDay } from '../lib/policy';
import { cronAuth, runTick } from '../lib/renewal';
import { ensureAssetFiles } from '../lib/placeholder-files';
import { latestReceiptId, receiptView } from '../lib/receipts';
import { approve, retry, runAutopilot, sendInvoice } from '../lib/send';
import { setRouteDepsForTests } from '../lib/server';
import * as T from './fixtures/texts';
import { mockInvoiceApi } from './helpers/mock-paypal';

let db: Db;
let s: SeedResult;
let deps: IntakeDeps;
let uploadsDir: string;
let harborLight: string;
let m: ReturnType<typeof mockInvoiceApi>;
let g: GrantDeps;
const aiFor: AiFor = (fixture) => createAdapter(fixtureProvider(fixture ?? 'paste'));
const creator = { creator: true, sessionSlug: 'imani' };
let ipSeq = 0;

const ctx = (token: string) => ({ params: Promise.resolve({ token }) });
const choose = (token: string, body: unknown, origin = 'http://app.test') =>
  renewalPOST(new Request(`http://app.test/api/pay/${token}/renewal`, {
    method: 'POST', body: JSON.stringify(body),
    headers: { host: 'app.test', origin, 'content-type': 'application/json', 'x-forwarded-for': `198.51.100.${++ipSeq % 250}` },
  }), ctx(token));

/** Harbor Light web v1 (no licence yet), invoiced on autopilot. */
async function harborV1() {
  const r = await intake(deps, { source: 'paste', clientId: s.clientId, assetId: harborLight, text: T.SUGGESTS_PRICE, fixture: 'suggests-price' }, creator);
  if (!r.ok) throw new Error(r.error);
  expect(await runAutopilot(db, m.api, r.briefId)).toMatchObject({ action: 'sent' });
  const v = (await getBriefView(db, r.briefId))!.version!;
  return { briefId: r.briefId, versionId: v.id, paypalId: v.invoice!.paypalInvoiceId!, token: v.invoice!.payPath!.split('/').pop()! };
}
const optInOf = async (id: string) => (await db.query<{ renewal_opt_in: boolean }>(`select renewal_opt_in from licence_versions where id = $1`, [id]))[0]!.renewal_opt_in;

beforeAll(async () => {
  db = await openPglite();
  await migrate(db);
  s = await seed(db);
  harborLight = s.assetIds[1]!;
  uploadsDir = await mkdtemp(join(tmpdir(), 'ur-b8-'));
  await ensureAssetFiles(db, uploadsDir);
  deps = { db, aiFor, uploadsDir, env: { AI_PROVIDER: 'fixture', NODE_ENV: 'test' } as unknown as NodeJS.ProcessEnv };
  process.env.PUBLIC_BASE_URL ??= 'https://useright.example';
});
afterAll(async () => {
  setRouteDepsForTests(null);
  await db?.close();
  if (uploadsDir) await rm(uploadsDir, { recursive: true, force: true });
});
beforeEach(async () => {
  m = mockInvoiceApi();
  g = { db, pp: m.pp, uploadsDir };
  setRouteDepsForTests({ db, aiFor, invoices: m.api, payments: m.payments, uploadsDir });
  await db.query(`update autopilot_sends set status = 'released' where status in ('reserved', 'sent')`);
  await db.query(`update creator_settings set per_deal_cap_cents = 50000, daily_max_sends = 50, rolling30_cap_cents = 10000000, timezone = 'America/New_York' where creator_id = $1`, [s.creatorId]);
  await db.query(`update licence_versions set status = 'superseded' where status in ('active', 'pending') and id <> $1`, [s.v1Id]);
  await db.query(`update licence_versions set status = 'active' where id = $1`, [s.v1Id]);
  await db.query(`delete from rate_hits`);
});
afterEach(() => { setRouteDepsForTests(null); });

describe('§2 renewal opt-in on the pay page', () => {
  it('starts unticked, saves before payment, and survives payment', async () => {
    const d = await harborV1();
    expect((await payView(db, d.token))!.renewal).toEqual({ optIn: false, canChange: true });
    const res = await choose(d.token, { optIn: true });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { view: { renewal: unknown } }).view.renewal).toEqual({ optIn: true, canChange: true });
    expect(await optInOf(d.versionId)).toBe(true);
    m.pay(d.paypalId);
    expect((await grantIfPaid(g, d.versionId, 'test')).granted).toBe(true);
    expect((await payView(db, d.token))!.renewal).toEqual({ optIn: true, canChange: true });
    // Still changeable after payment.
    expect((await choose(d.token, { optIn: false })).status).toBe(200);
    expect(await optInOf(d.versionId)).toBe(false);
  });

  it('refuses another site, a bad body and an unknown link', async () => {
    const d = await harborV1();
    expect((await choose(d.token, { optIn: true }, 'https://evil.example')).status).toBe(403);
    expect((await choose(d.token, { optIn: 'yes' })).status).toBe(400);
    expect((await choose(d.token, { optIn: true, extra: 1 })).status).toBe(400);
    expect((await choose('A'.repeat(43), { optIn: true })).status).toBe(404);
    expect(await optInOf(d.versionId)).toBe(false);
  });

  it('locks once the renewal invoice is out', async () => {
    const d = await harborV1();
    m.pay(d.paypalId);
    await grantIfPaid(g, d.versionId, 'test');
    // A renewal child of this licence with an invoice out (the tick's job in §3; inserted directly here).
    const [p] = await db.query<{ version_no: number; scope: unknown; rate_card: unknown; total_cents: number }>(`select version_no, scope, rate_card, total_cents from licence_versions where id = $1`, [d.versionId]);
    const [c] = await db.query<{ id: string }>(
      `insert into licence_versions (creator_id, client_id, asset_id, parent_id, renewal_of, version_no, scope, rate_card, total_cents, content_hash, status, send_state)
       values ($1, $2, $3, $4, $4, $5, $6, $7, $8, 'h', 'pending', 'sent') returning id`,
      [s.creatorId, s.clientId, harborLight, d.versionId, p!.version_no + 1, JSON.stringify(p!.scope), JSON.stringify(p!.rate_card), p!.total_cents]);
    expect((await payView(db, d.token))!.renewal).toEqual({ optIn: false, canChange: false });
    const res = await choose(d.token, { optIn: true });
    expect(res.status).toBe(409);
    expect(await optInOf(d.versionId)).toBe(false);
    await db.query(`delete from licence_versions where id = $1`, [c!.id]);
  });

  it('the receipt says whether a renewal invoice was requested', async () => {
    const d = await harborV1();
    m.pay(d.paypalId);
    await grantIfPaid(g, d.versionId, 'test');
    const rid = (await latestReceiptId(db, d.versionId))!;
    const page = async () => renderToString(await ReceiptPage({ params: Promise.resolve({ id: rid }) }));
    expect((await receiptView(db, rid))!.renewalOptIn).toBe(false);
    expect(await page()).toContain('not requested');
    await choose(d.token, { optIn: true });
    const end = (await receiptView(db, rid))!.body.endAt!;
    const html = await page();
    expect(html).toContain('invoice from'); // review fix 9: the day it goes out, a week before the end
    expect(html).toContain(new Date(new Date(end).getTime() - 7 * DAY).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }));
  });
});

// ---------------------------------------------------------------- §3 tick

const DEMO = { DEMO_MODE: '1' };
const DAY = 24 * 3600 * 1000;
const tick = (at: number, env: Record<string, string> = DEMO) => runTick({ db, api: m.api, env, real: () => at });
const row = (id: string) => db.query<{ status: string; start_at: Date | null; end_at: Date | null; paid_cents: number; total_cents: number; renewal_of: string | null; brief_id: string | null; policy: { pass: boolean; results: { rule: string; code: string; pass: boolean }[] } | null; send_state: string }>(
  `select status, start_at, end_at, paid_cents, total_cents, renewal_of, brief_id, policy, send_state from licence_versions where id = $1`, [id]).then((r) => r[0]!);
const renewalOf = async (parentId: string) => (await db.query<{ id: string }>(`select id from licence_versions where renewal_of = $1`, [parentId]))[0]?.id ?? null;
const n = async (sql: string, params: unknown[]) => (await db.query<{ n: number }>(`select count(*)::int as n from ${sql}`, params))[0]!.n;

/** A paid Harbor Light v1 (term 2026-10-29 to 2027-04-29, New York), optionally opted in to renewal. */
async function paidHarbor(optIn: boolean) {
  const d = await harborV1();
  if (optIn) expect((await choose(d.token, { optIn: true })).status).toBe(200);
  m.pay(d.paypalId);
  expect((await grantIfPaid(g, d.versionId, 'test')).granted).toBe(true);
  const end = (await row(d.versionId)).end_at!.getTime();
  return { ...d, end };
}

describe('§3 tick: renewals', () => {
  it('opens a renewal only inside the 7-day window, once, however often it runs', async () => {
    const d = await paidHarbor(true);
    expect(await tick(d.end - 7 * DAY - 60_000)).toMatchObject({ renewals: { created: 0 } });
    expect(await renewalOf(d.versionId)).toBeNull();
    expect(await tick(d.end - 7 * DAY)).toMatchObject({ renewals: { created: 1, sent: 1 } });
    const r1 = await renewalOf(d.versionId);
    const invoices = m.count('create');
    expect(await tick(d.end - 7 * DAY)).toMatchObject({ renewals: { created: 0, sent: 0 }, expired: 0 });
    expect(await tick(d.end - 3 * DAY)).toMatchObject({ renewals: { created: 0, sent: 0 } });
    expect(await renewalOf(d.versionId)).toBe(r1);
    expect(m.count('create')).toBe(invoices);
    expect(await n(`licence_versions where renewal_of = $1`, [d.versionId])).toBe(1);
  });

  it('opted in: the same scope, its own deal, the policy engine, and sendInvoice()', async () => {
    const d = await paidHarbor(true);
    await tick(d.end - 6 * DAY);
    const rid = (await renewalOf(d.versionId))!;
    const r = await row(rid);
    expect(r).toMatchObject({ status: 'pending', renewal_of: d.versionId, send_state: 'sent' });
    expect(r.policy!.pass).toBe(true);
    expect(r.policy!.results.find((x) => x.rule === 'R5')).toMatchObject({ pass: true, code: 'renewal_same_scope' });
    const [brief] = await db.query<{ source: string; state: string; client_id: string; asset_id: string }>(`select source, state, client_id, asset_id from briefs where id = $1`, [r.brief_id]);
    expect(brief).toMatchObject({ source: 'renewal', state: 'extracted', client_id: s.clientId, asset_id: harborLight });
    const view = await getBriefView(db, r.brief_id!);
    expect(view!.status).toBe('invoiced');
    const ledger = await listLedger(db, s.creatorId);
    expect(ledger.find((x) => x.kind === 'renewal.sent' && x.versionId === rid)).toMatchObject({ label: 'Renewal sent' });
    expect(m.byNumber((await db.query<{ invoice_number: string }>(`select invoice_number from invoices where version_id = $1`, [rid]))[0]!.invoice_number)).toBeTruthy();
  });

  it('not opted in: a pending draft held by RENEW in Ask me, no PayPal call until the typed approval', async () => {
    const d = await paidHarbor(false);
    const before = m.count('create');
    expect(await tick(d.end - 6 * DAY)).toMatchObject({ renewals: { created: 1, sent: 0, held: 1 } });
    const rid = (await renewalOf(d.versionId))!;
    const r = await row(rid);
    expect(r).toMatchObject({ status: 'pending', send_state: 'idle' });
    expect(r.policy!.results.find((x) => x.rule === 'RENEW')).toMatchObject({ pass: false, code: 'renewal_needs_ok' });
    expect(m.count('create')).toBe(before);
    expect((await listAsk(db, s.creatorId)).find((a) => a.versionId === rid)).toMatchObject({ briefId: r.brief_id, totalCents: r.total_cents, renewal: true });
    expect((await listLedger(db, s.creatorId)).find((x) => x.kind === 'renewal.draft' && x.versionId === rid)).toBeTruthy();
    // Plan fix 2: no one-click; the existing approve path with the exact typed total.
    expect(await approve(db, m.api, s.creatorId, { versionId: rid }, '1.00')).toMatchObject({ ok: false, code: 'amount_mismatch' });
    expect(await approve(db, m.api, s.creatorId, { briefId: r.brief_id! }, (r.total_cents / 100).toFixed(2))).toMatchObject({ ok: true });
    expect(m.count('create')).toBe(before + 1);
    expect((await row(rid)).send_state).toBe('sent');
  });

  it('a client who opts in after the draft was made gets the invoice on the next tick', async () => {
    const d = await paidHarbor(false);
    await tick(d.end - 6 * DAY);
    const rid = (await renewalOf(d.versionId))!;
    expect((await row(rid)).send_state).toBe('idle');
    expect((await choose(d.token, { optIn: true })).status).toBe(200);
    expect(await tick(d.end - 5 * DAY)).toMatchObject({ renewals: { created: 0, sent: 1 } });
    expect((await row(rid)).send_state).toBe('sent');
  });

  it('prices at the CURRENT rate card, not the licence’s frozen one', async () => {
    const d = await paidHarbor(true);
    const paid = (await row(d.versionId)).total_cents;
    await db.query(`update rate_card_options set cents = cents + 5000 where creator_id = $1 and option_id = 'web'`, [s.creatorId]);
    try {
      await tick(d.end - 6 * DAY);
      const r = await row((await renewalOf(d.versionId))!);
      expect(r.total_cents).toBe(paid + 5000);
    } finally {
      await db.query(`update rate_card_options set cents = cents - 5000 where creator_id = $1 and option_id = 'web'`, [s.creatorId]);
    }
  });

  it('R5 passes structurally only for the same scope: a renewal with a changed scope fails R5', async () => {
    const d = await paidHarbor(true);
    await tick(d.end - 6 * DAY);
    const rid = (await renewalOf(d.versionId))!;
    await db.query(`update licence_versions set status = 'pending', send_state = 'idle' where id = $1`, [rid]);
    await db.query(`update invoices set state = 'cancelled' where version_id = $1`, [rid]);
    await db.query(`update licence_versions set scope = jsonb_set(scope, '{channels}', scope->'channels' || '["print"]'::jsonb) where id = $1`, [rid]);
    const ev = await evaluate(db, rid, { mode: 'autopilot' });
    expect(ev.ok && ev.policy.results.find((x) => x.rule === 'R5')).toMatchObject({ pass: false, code: 'checks_not_clear' });
  });

  it('live mode ignores a stored demo offset', async () => {
    const d = await paidHarbor(true);
    await db.query(`insert into demo_clock (id, offset_ms) values (true, $1) on conflict (id) do update set offset_ms = excluded.offset_ms`, [400 * DAY]);
    try {
      const realNow = d.end - 60 * DAY;
      expect(await tick(realNow, {})).toMatchObject({ renewals: { created: 0 }, expired: 0 });
      expect(await renewalOf(d.versionId)).toBeNull();
      await tick(realNow, DEMO); // +400 days in demo mode: inside the window
      expect(await renewalOf(d.versionId)).not.toBeNull();
    } finally {
      await db.query(`update demo_clock set offset_ms = 0`);
    }
  });
});

describe('§3 tick: renewal grant start date (plan fix 1)', () => {
  it('paid early: starts the day the licence ends, the parent is superseded, paid_cents is this payment only', async () => {
    const d = await paidHarbor(true);
    await tick(d.end - 6 * DAY);
    const rid = (await renewalOf(d.versionId))!;
    const inv = (await db.query<{ paypal_invoice_id: string }>(`select paypal_invoice_id from invoices where version_id = $1`, [rid]))[0]!.paypal_invoice_id;
    m.pay(inv, { date: '2027-04-23' });
    expect((await grantIfPaid(g, rid, 'test')).granted).toBe(true);
    const r = await row(rid);
    expect(r.status).toBe('active');
    expect(r.start_at!.toISOString()).toBe(new Date(d.end).toISOString()); // 2027-04-29 local midnight
    expect(r.end_at!.toISOString()).toBe(termFromDay('America/New_York', { y: 2027, m: 4, d: 29 }, 6).end.toISOString());
    expect(r.paid_cents).toBe(r.total_cents);
    expect((await row(d.versionId)).status).toBe('superseded');
    // A later tick does not expire anything: the parent is no longer active.
    expect(await tick(d.end + DAY)).toMatchObject({ expired: 0 });
  });

  it('paid after the licence expired: allowed, and starts on the payment day', async () => {
    const d = await paidHarbor(true);
    await tick(d.end - 6 * DAY);
    expect(await tick(d.end + DAY)).toMatchObject({ expired: 1 });
    expect((await row(d.versionId)).status).toBe('expired');
    const rid = (await renewalOf(d.versionId))!;
    const inv = (await db.query<{ paypal_invoice_id: string }>(`select paypal_invoice_id from invoices where version_id = $1`, [rid]))[0]!.paypal_invoice_id;
    m.pay(inv, { date: '2027-05-10' });
    expect((await grantIfPaid(g, rid, 'test')).granted).toBe(true);
    const r = await row(rid);
    expect(r.start_at!.toISOString()).toBe(termFromDay('America/New_York', { y: 2027, m: 5, d: 10 }, 6).start.toISOString());
    expect((await row(d.versionId)).status).toBe('expired'); // it was never re-activated
  });

  it('a non-renewal upgrade still refuses an expired parent', async () => {
    const d = await paidHarbor(true);
    expect(await tick(d.end + DAY)).toMatchObject({ expired: 1 });
    const up = await intake(deps, { source: 'paste', clientId: s.clientId, assetId: harborLight, text: T.PASTE, fixture: 'paste' }, creator);
    if (!up.ok) throw new Error(up.error);
    // With no active licence the request prices as a fresh v1, so it is not a child of the expired one at all.
    const v = (await getBriefView(db, up.briefId))!.version;
    expect(v?.id ? (await row(v.id)).renewal_of : null).toBeNull();
  });

  it('review fix 10 (review 7): paying an upgrade issued before the parent expired is refused; nothing unlocks', async () => {
    const d = await paidHarbor(false);
    const up = await intake(deps, { source: 'paste', clientId: s.clientId, assetId: harborLight, text: T.PASTE, fixture: 'paste' }, creator);
    if (!up.ok) throw new Error(up.error);
    const sent = (await runAutopilot(db, m.api, up.briefId)).action === 'sent';
    const v = (await getBriefView(db, up.briefId))!.version!;
    expect((await row(v.id)).renewal_of).toBeNull();
    expect((await db.query<{ parent_id: string }>(`select parent_id from licence_versions where id = $1`, [v.id]))[0]!.parent_id).toBe(d.versionId);
    if (!sent) {
      expect(await approve(db, m.api, s.creatorId, { versionId: v.id }, ((await row(v.id)).total_cents / 100).toFixed(2))).toMatchObject({ ok: true });
    }
    const inv = (await db.query<{ paypal_invoice_id: string }>(`select paypal_invoice_id from invoices where version_id = $1`, [v.id]))[0]!.paypal_invoice_id;
    expect(await tick(d.end + DAY)).toMatchObject({ expired: 1 });
    expect((await row(d.versionId)).status).toBe('expired');
    m.pay(inv);
    expect(await grantIfPaid(g, v.id, 'test')).toEqual({ granted: false, reason: 'stale_version' });
    expect((await row(v.id)).status).toBe('pending');
    expect((await row(d.versionId)).status).toBe('expired');
    expect(await n(`download_tokens where version_id = $1`, [v.id])).toBe(0);
  });

  it('review fix 10 (review 7): a second renewal of the same licence, inserted directly, fails on the unique index', async () => {
    const d = await paidHarbor(true);
    await tick(d.end - 6 * DAY);
    expect(await renewalOf(d.versionId)).not.toBeNull();
    const [p] = await db.query<{ version_no: number; scope: unknown; rate_card: unknown; total_cents: number }>(`select version_no, scope, rate_card, total_cents from licence_versions where id = $1`, [d.versionId]);
    await expect(db.query(
      `insert into licence_versions (creator_id, client_id, asset_id, parent_id, renewal_of, version_no, scope, rate_card, total_cents, content_hash, status)
       values ($1, $2, $3, $4, $4, $5, $6, $7, $8, 'dup', 'pending')`,
      [s.creatorId, s.clientId, harborLight, d.versionId, p!.version_no + 1, JSON.stringify(p!.scope), JSON.stringify(p!.rate_card), p!.total_cents])).rejects.toThrow(/unique|duplicate/i);
    expect(await n(`licence_versions where renewal_of = $1`, [d.versionId])).toBe(1);
  });

  it('a refund of the renewal restores the parent through the existing path', async () => {
    const d = await paidHarbor(true);
    await tick(d.end - 6 * DAY);
    const rid = (await renewalOf(d.versionId))!;
    const inv = (await db.query<{ paypal_invoice_id: string }>(`select paypal_invoice_id from invoices where version_id = $1`, [rid]))[0]!.paypal_invoice_id;
    const cap = m.pay(inv, { date: '2027-04-23' });
    await grantIfPaid(g, rid, 'test');
    m.refund(cap);
    expect(await revokeVersion(g, rid, { source: 'test', captureId: cap, captureStatus: 'REFUNDED' })).toMatchObject({ revoked: true });
    expect((await row(rid)).status).toBe('refunded');
    expect((await row(d.versionId)).status).toBe('active');
  });
});

describe('§3 tick: expiry', () => {
  it('ends an unrenewed licence: expired, download links voided, an Expired and a revocation receipt, one event; once', async () => {
    const d = await paidHarbor(false);
    const dl = await issueDownload(db, d.token);
    expect(dl.ok).toBe(true);
    expect(await tick(d.end + 60_000)).toMatchObject({ expired: 1 });
    expect((await row(d.versionId)).status).toBe('expired');
    expect(await n(`download_tokens where version_id = $1 and voided_at is null`, [d.versionId])).toBe(0);
    const receipts = await db.query<{ status: string; kind: string }>(
      `select status, body->>'kind' as kind from receipts where version_id = $1 and status = 'expired' order by seq`, [d.versionId]);
    expect(receipts).toEqual([{ status: 'expired', kind: 'expiry' }, { status: 'expired', kind: 'revocation' }]);
    expect((await listLedger(db, s.creatorId)).filter((x) => x.kind === 'expired' && x.versionId === d.versionId)).toHaveLength(1);
    expect((await payView(db, d.token))!.status).toBe('expired');
    expect((await issueDownload(db, d.token)).ok).toBe(false);
    // Idempotent.
    expect(await tick(d.end + 2 * DAY)).toMatchObject({ expired: 0 });
    expect(await n(`receipts where version_id = $1`, [d.versionId])).toBe(3);
    // The unsent renewal draft is left alone.
    expect((await row((await renewalOf(d.versionId))!)).status).toBe('pending');
  });

  it('the Expired receipt page names itself and shows the expired status', async () => {
    const d = await paidHarbor(false);
    await tick(d.end + 60_000);
    const [{ public_id }] = await db.query<{ public_id: string }>(`select public_id from receipts where version_id = $1 and body->>'kind' = 'expiry'`, [d.versionId]) as [{ public_id: string }];
    const html = renderToString(await ReceiptPage({ params: Promise.resolve({ id: public_id }) }));
    expect(html).toContain('Expired receipt');
    expect(html).toContain('Expired');
    expect(html).toContain('The licence term ended without a paid renewal.');
  });
});

describe('§3 cron auth and keep-alive', () => {
  const post = (secret?: string) => new Request('http://app.test/api/cron/tick', { method: 'POST', headers: secret === undefined ? {} : { 'x-cron-secret': secret } });
  it('503 without CRON_SECRET, 401 for a wrong or missing header, 200 with the right one; never echoes the secret', async () => {
    const saved = process.env.CRON_SECRET;
    try {
      delete process.env.CRON_SECRET;
      expect((await tickPOST(post('anything'))).status).toBe(503);
      process.env.CRON_SECRET = 'cron-secret-for-tests-0123456789';
      for (const bad of [undefined, '', 'wrong', 'cron-secret-for-tests-012345678']) {
        const res = await tickPOST(post(bad));
        expect(res.status).toBe(401);
        expect(await res.text()).not.toContain('cron-secret-for-tests');
      }
      const ok = await tickPOST(post('cron-secret-for-tests-0123456789'));
      expect(ok.status).toBe(200);
      expect(await ok.json()).toMatchObject({ renewals: { created: expect.any(Number) }, expired: expect.any(Number) });
    } finally {
      if (saved === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = saved;
    }
  });

  it('cronAuth compares the whole secret', () => {
    const env = { CRON_SECRET: 'abc' };
    expect(cronAuth(post('abc'), env)).toEqual({ ok: true });
    expect(cronAuth(post('abcd'), env)).toMatchObject({ ok: false, status: 401 });
    expect(cronAuth(post('ab'), env)).toMatchObject({ ok: false, status: 401 });
  });

  it('/healthz answers 200 without a database', async () => {
    setRouteDepsForTests(null);
    const res = healthGET();
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });
});

// ---------------------------------------------------------------- §4 demo panel routes

describe('§4 demo panel routes', () => {
  const TOKEN = 'b8-demo-creator-token';
  const req = (path: string, method = 'GET', o: { cookie?: boolean; origin?: string } = {}) =>
    new Request(`http://app.test${path}`, { method, headers: { host: 'app.test', origin: o.origin ?? 'http://app.test', ...(o.cookie === false ? {} : { cookie: `ur_creator=${TOKEN}` }) } });
  const saved = { token: process.env.CREATOR_TOKEN, demo: process.env.DEMO_MODE, origin: process.env.APP_ORIGIN };
  beforeAll(() => { process.env.CREATOR_TOKEN = TOKEN; delete process.env.APP_ORIGIN; });
  afterAll(() => {
    for (const [k, v] of [['CREATOR_TOKEN', saved.token], ['DEMO_MODE', saved.demo], ['APP_ORIGIN', saved.origin]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });
  afterEach(async () => { await db.query(`update demo_clock set offset_ms = 0`); });

  it('is hidden in live mode: 404 for the clock, the advance and the tick, and nothing moves', async () => {
    delete process.env.DEMO_MODE;
    expect((await demoGET(req('/api/demo'))).status).toBe(404);
    expect((await clockPOST(req('/api/demo/clock', 'POST'))).status).toBe(404);
    expect((await demoTickPOST(req('/api/demo/tick', 'POST'))).status).toBe(404);
    expect(await n(`demo_clock where offset_ms > 0`, [])).toBe(0);
  });

  it('needs the creator session and the same origin', async () => {
    process.env.DEMO_MODE = '1';
    expect((await clockPOST(req('/api/demo/clock', 'POST', { cookie: false }))).status).toBe(401);
    expect((await clockPOST(req('/api/demo/clock', 'POST', { origin: 'https://evil.example' }))).status).toBe(403);
    expect((await demoTickPOST(req('/api/demo/tick', 'POST', { origin: 'https://evil.example' }))).status).toBe(403);
    expect(await n(`demo_clock where offset_ms > 0`, [])).toBe(0);
  });

  it('Advance to the next renewal: one press lands on the soonest renewal window and runs the tick (review fix 6)', async () => {
    process.env.DEMO_MODE = '1';
    const d = await paidHarbor(true); // 6 months, ends 2027-04-29: the soonest active licence
    const res = await clockPOST(req('/api/demo/clock', 'POST'));
    expect(res.status).toBe(200);
    const body = await res.json() as { now: string; moved: boolean; days: number; offsetDays: number; tick: { renewals: { created: number; sent: number }; expired: number } };
    expect(body.moved).toBe(true);
    expect(body.tick).toMatchObject({ renewals: { created: 1, sent: 1 }, expired: 0 });
    expect(await renewalOf(d.versionId)).not.toBeNull();
    // The clock sits at the window's start: end minus 7 days (to the second; real time ran on a little).
    expect(Math.abs(new Date(body.now).getTime() - (d.end - 7 * DAY))).toBeLessThan(60_000);
    expect((await (await demoGET(req('/api/demo'))).json())).toMatchObject({ demoMode: true, offsetDays: body.offsetDays });
    expect((await listLedger(db, s.creatorId)).find((r) => r.kind === 'clock')?.message).toMatch(/^Demo clock moved forward \d+ days to /);
  });

  it('forward only: with no renewal window ahead, a press moves nothing and writes no event', async () => {
    process.env.DEMO_MODE = '1';
    const d = await paidHarbor(false);
    await clockPOST(req('/api/demo/clock', 'POST'));
    expect(await renewalOf(d.versionId)).not.toBeNull();
    const offset = async () => Number((await db.query<{ offset_ms: string }>(`select offset_ms from demo_clock`))[0]!.offset_ms);
    const [before, clocks] = [await offset(), await n(`events where kind = 'clock'`, [])];
    // Every other active licence already has its renewal or is ignored: nothing lies ahead.
    await db.query(`update licence_versions set status = 'superseded' where id = $1`, [s.v1Id]);
    const body = await (await clockPOST(req('/api/demo/clock', 'POST'))).json() as { moved: boolean };
    expect(body.moved).toBe(false);
    expect(await offset()).toBe(before);
    expect(await n(`events where kind = 'clock'`, [])).toBe(clocks);
  });

  it('a tick that fails after the advance: 200 with tickError, the clock moved once, and Run tick again does not move it', async () => {
    process.env.DEMO_MODE = '1';
    await paidHarbor(true);
    const failing: Db = {
      query: (text, params) => text.includes('from creators order by created_at') ? Promise.reject(new Error('database went away')) : db.query(text, params),
      transaction: (fn) => db.transaction(fn),
      close: () => Promise.resolve(),
    };
    setRouteDepsForTests({ db: failing, aiFor, invoices: m.api, payments: m.payments, uploadsDir });
    const res = await clockPOST(req('/api/demo/clock', 'POST'));
    expect(res.status).toBe(200);
    const body = await res.json() as { moved: boolean; tick: unknown; tickError: string };
    expect(body).toMatchObject({ moved: true, tick: null, tickError: expect.stringContaining('Run tick again') });
    const offset = async () => Number((await db.query<{ offset_ms: string }>(`select offset_ms from demo_clock`))[0]!.offset_ms);
    const moved = await offset();
    expect(moved).toBeGreaterThan(0);
    expect(await n(`events where kind = 'clock'`, [])).toBeGreaterThan(0);
    setRouteDepsForTests({ db, aiFor, invoices: m.api, payments: m.payments, uploadsDir });
    const again = await demoTickPOST(req('/api/demo/tick', 'POST'));
    expect(again.status).toBe(200);
    expect((await again.json() as { tick: { renewals: { created: number } } }).tick.renewals.created).toBe(1);
    expect(await offset()).toBe(moved);
  });

  it('review re-review N2: a tick that failed after opening the renewal: Advance is refused and the clock stays until a tick finishes', async () => {
    process.env.DEMO_MODE = '1';
    const d = await paidHarbor(true);
    const clock = async () => Number((await db.query<{ offset_ms: string }>(`select offset_ms from demo_clock`))[0]!.offset_ms);
    expect(await clockPOST(req('/api/demo/clock', 'POST'))).toMatchObject({ status: 200 });
    // The state a crash leaves: the renewal row exists, its offer never finished.
    const rid = (await renewalOf(d.versionId))!;
    await db.query(`delete from invoices where version_id = $1`, [rid]);
    await db.query(`delete from autopilot_sends where version_id = $1`, [rid]);
    await db.query(`update licence_versions set policy = null, send_state = 'idle', send_error = null where id = $1`, [rid]);
    const moved = await clock();
    expect(await (await demoGET(req('/api/demo', 'GET'))).json()).toMatchObject({ tickPending: true });
    const refused = await clockPOST(req('/api/demo/clock', 'POST'));
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ tickPending: true, error: expect.stringContaining('Run tick again') });
    expect(await clock()).toBe(moved);
    expect(await demoTickPOST(req('/api/demo/tick', 'POST'))).toMatchObject({ status: 200 });
    expect(await (await demoGET(req('/api/demo', 'GET'))).json()).toMatchObject({ tickPending: false });
  });

  it('Run tick now runs the same tick', async () => {
    process.env.DEMO_MODE = '1';
    const res = await demoTickPOST(req('/api/demo/tick', 'POST'));
    expect(res.status).toBe(200);
    expect((await res.json() as { tick: unknown }).tick).toMatchObject({ renewals: { created: expect.any(Number) }, expired: expect.any(Number) });
  });
});

// ---------------------------------------------------------------- B8 review fixes (docs/batch-8.md "Review fixes")

const invoicesOf = (versionId: string) => n(`invoices where version_id = $1`, [versionId]);

/** A paid upgrade of the Harbor Light licence (adds social), which supersedes the web licence. */
async function paidUpgrade() {
  const up = await intake(deps, { source: 'paste', clientId: s.clientId, assetId: harborLight, text: T.PASTE, fixture: 'paste' }, creator);
  if (!up.ok) throw new Error(up.error);
  const r = await runAutopilot(db, m.api, up.briefId);
  let v = (await getBriefView(db, up.briefId))!.version!;
  if (r.action !== 'sent') expect(await approve(db, m.api, s.creatorId, { versionId: v.id }, (v.totalCents / 100).toFixed(2))).toMatchObject({ ok: true });
  v = (await getBriefView(db, up.briefId))!.version!;
  return { briefId: up.briefId, versionId: v.id, paypalId: v.invoice!.paypalInvoiceId! };
}

describe('review fix 1: consent is re-read under the lock right before the send', () => {
  it('the client unticks after evaluate() reserved the send: no PayPal call, the reservation is released', async () => {
    const d = await paidHarbor(false);
    await tick(d.end - 6 * DAY);
    const rid = (await renewalOf(d.versionId))!;
    expect((await choose(d.token, { optIn: true })).status).toBe(200);
    const ev = await evaluate(db, rid, { mode: 'autopilot', now: new Date(d.end - 6 * DAY) });
    expect(ev.ok && ev.policy.pass).toBe(true);
    expect((await choose(d.token, { optIn: false })).status).toBe(200); // between evaluate() and claim()
    const before = m.count('create');
    expect(await sendInvoice(db, m.api, rid, { mode: 'autopilot' })).toMatchObject({ ok: false, code: 'renewal_opt_out' });
    expect(m.count('create')).toBe(before);
    expect(await invoicesOf(rid)).toBe(0);
    expect(await n(`autopilot_sends where version_id = $1 and status = 'reserved'`, [rid])).toBe(0);
    expect((await row(rid))).toMatchObject({ status: 'pending', send_state: 'idle' });
    // The creator's typed approval still sends it: her OK replaces the client's.
    const total = ((await row(rid)).total_cents / 100).toFixed(2);
    expect(await approve(db, m.api, s.creatorId, { versionId: rid }, total)).toMatchObject({ ok: true });
    expect(m.count('create')).toBe(before + 1);
  });
});

describe('review fix 2: a renewal whose parent is no longer current is cancelled, never sent', () => {
  it('parent superseded by a paid upgrade: the typed approval sends nothing and cancels the renewal with a ledger row', async () => {
    const d = await paidHarbor(false);
    await tick(d.end - 6 * DAY);
    const rid = (await renewalOf(d.versionId))!;
    const up = await paidUpgrade();
    m.pay(up.paypalId);
    expect((await grantIfPaid(g, up.versionId, 'test')).granted).toBe(true);
    expect((await row(d.versionId)).status).toBe('superseded');
    const before = m.count('create');
    const total = ((await row(rid)).total_cents / 100).toFixed(2);
    expect(await approve(db, m.api, s.creatorId, { versionId: rid }, total)).toMatchObject({ ok: false, code: 'renewal_stale' });
    expect(m.count('create')).toBe(before);
    expect(await invoicesOf(rid)).toBe(0);
    expect((await row(rid)).status).toBe('superseded');
    expect((await listLedger(db, s.creatorId)).find((x) => x.kind === 'renewal.cancelled' && x.versionId === rid)).toMatchObject({ label: 'Renewal cancelled' });
  });

  /** A renewal whose PayPal draft exists but was never sent: reading the draft back failed, so the row stays. */
  async function unsentRenewalDraft(d: { end: number; versionId: string }) {
    m.failNext('get', 'timeout');
    await tick(d.end - 6 * DAY);
    const rid = (await renewalOf(d.versionId))!;
    const [inv] = await db.query<{ state: string; paypal_invoice_id: string }>(`select state, paypal_invoice_id from invoices where version_id = $1`, [rid]);
    expect(inv!.state).toBe('created');
    return { rid, draft: inv!.paypal_invoice_id };
  }

  it('review re-review 3: Retry of an unsent renewal draft whose parent was superseded sends nothing and cancels the draft', async () => {
    const d = await paidHarbor(true);
    const { rid, draft } = await unsentRenewalDraft(d);
    const up = await paidUpgrade();
    m.pay(up.paypalId);
    expect((await grantIfPaid(g, up.versionId, 'test')).granted).toBe(true);
    const sends = m.count('send');
    await db.query(`update invoices set attempt_at = now() - interval '1 hour' where version_id = $1`, [rid]);
    expect(await retry(db, m.api, s.creatorId, (await row(rid)).brief_id!)).toMatchObject({ ok: false, code: 'renewal_stale' });
    expect(m.count('send')).toBe(sends);
    expect(m.calls.some((c) => c.op === 'remove' && c.arg === draft)).toBe(true);
    expect((await db.query<{ state: string }>(`select state from invoices where version_id = $1`, [rid]))[0]!.state).toBe('cancelled');
    expect((await row(rid)).status).toBe('superseded');
    expect((await listLedger(db, s.creatorId)).find((x) => x.kind === 'renewal.cancelled' && x.versionId === rid)).toBeTruthy();
  });

  it('review re-review 3: Retry of an unsent renewal draft whose parent is still current sends it', async () => {
    const d = await paidHarbor(true);
    const { rid } = await unsentRenewalDraft(d);
    await db.query(`update invoices set attempt_at = now() - interval '1 hour' where version_id = $1`, [rid]);
    expect(await retry(db, m.api, s.creatorId, (await row(rid)).brief_id!)).toMatchObject({ ok: true });
    expect((await db.query<{ state: string }>(`select state from invoices where version_id = $1`, [rid]))[0]!.state).toBe('sent');
  });

  it('on autopilot the tick cancels it too, with no PayPal call', async () => {
    const d = await paidHarbor(false);
    await tick(d.end - 6 * DAY);
    const rid = (await renewalOf(d.versionId))!;
    const up = await paidUpgrade();
    m.pay(up.paypalId);
    expect((await grantIfPaid(g, up.versionId, 'test')).granted).toBe(true);
    await db.query(`update licence_versions set renewal_opt_in = true where id = $1`, [d.versionId]); // the old licence's box, ticked late
    const before = m.count('create');
    expect(await tick(d.end - 5 * DAY)).toMatchObject({ renewals: { cancelled: 1 } });
    expect(m.count('create')).toBe(before);
    expect(await invoicesOf(rid)).toBe(0);
    expect((await row(rid)).status).toBe('superseded');
    expect(await n(`events where kind = 'renewal.cancelled' and detail->>'versionId' = $1`, [rid])).toBe(1);
  });

  it('parent expired but another licence for the same photo and client is active: cancelled', async () => {
    const d = await paidHarbor(false);
    await tick(d.end - 6 * DAY);
    const rid = (await renewalOf(d.versionId))!;
    await tick(d.end + DAY);
    expect((await row(d.versionId)).status).toBe('expired');
    // A newer licence for the same client and photo (inserted directly; the one-active index allows it now).
    const [p] = await db.query<{ scope: unknown; rate_card: unknown }>(`select scope, rate_card from licence_versions where id = $1`, [d.versionId]);
    const [o] = await db.query<{ id: string }>(
      `insert into licence_versions (creator_id, client_id, asset_id, version_no, scope, rate_card, total_cents, content_hash, status)
       values ($1, $2, $3, 1, $4, $5, 100, 'h2', 'active') returning id`, [s.creatorId, s.clientId, harborLight, JSON.stringify(p!.scope), JSON.stringify(p!.rate_card)]);
    try {
      const total = ((await row(rid)).total_cents / 100).toFixed(2);
      expect(await approve(db, m.api, s.creatorId, { versionId: rid }, total)).toMatchObject({ ok: false, code: 'renewal_stale' });
      expect(await invoicesOf(rid)).toBe(0);
    } finally {
      await db.query(`update licence_versions set status = 'superseded' where id = $1`, [o!.id]);
    }
  });
});

describe('review fix 3: renewals that did not reach PayPal are recovered; Retry and the payer link work without an extraction', () => {
  const withoutSecret = async <T>(f: () => Promise<T>) => {
    const saved = process.env.APP_SECRET;
    delete process.env.APP_SECRET;
    try { return await f(); } finally { process.env.APP_SECRET = saved; }
  };

  it('APP_SECRET missing during the tick: shown as failed in Ask me, then sent exactly once by a later tick', async () => {
    const d = await paidHarbor(true);
    const before = m.count('create');
    expect(await withoutSecret(() => tick(d.end - 6 * DAY))).toMatchObject({ renewals: { created: 1, sent: 0 } });
    const rid = (await renewalOf(d.versionId))!;
    expect(m.count('create')).toBe(before);
    expect(await row(rid)).toMatchObject({ status: 'pending', send_state: 'failed' });
    expect((await listAsk(db, s.creatorId)).find((a) => a.versionId === rid)?.sendError).toMatch(/APP_SECRET/);
    expect(await tick(d.end - 5 * DAY)).toMatchObject({ renewals: { created: 0, sent: 1 } });
    expect(await tick(d.end - 5 * DAY)).toMatchObject({ renewals: { created: 0, sent: 0 } });
    expect(m.count('create')).toBe(before + 1);
    expect(await invoicesOf(rid)).toBe(1);
    expect((await row(rid)).send_state).toBe('sent');
  });

  it('a crash between creating the renewal and offering it (no policy stored): the next tick offers it once', async () => {
    const d = await paidHarbor(true);
    await withoutSecret(() => tick(d.end - 6 * DAY));
    const rid = (await renewalOf(d.versionId))!;
    // What a crash right after createRenewal() leaves: a pending child, never evaluated, nothing reserved.
    await db.query(`update licence_versions set policy = null, send_state = 'idle', send_error = null where id = $1`, [rid]);
    await db.query(`delete from autopilot_sends where version_id = $1`, [rid]);
    const before = m.count('create');
    expect(await tick(d.end - 5 * DAY)).toMatchObject({ renewals: { sent: 1 } });
    expect(await tick(d.end - 4 * DAY)).toMatchObject({ renewals: { sent: 0 } });
    expect(m.count('create')).toBe(before + 1);
  });

  it('an approved renewal whose send never reached PayPal is sent on the approval path by the next tick', async () => {
    const d = await paidHarbor(false);
    await tick(d.end - 6 * DAY);
    const rid = (await renewalOf(d.versionId))!;
    const total = ((await row(rid)).total_cents / 100).toFixed(2);
    expect(await withoutSecret(() => approve(db, m.api, s.creatorId, { versionId: rid }, total))).toMatchObject({ ok: false, code: 'app_secret_missing' });
    const before = m.count('create');
    expect(await tick(d.end - 5 * DAY)).toMatchObject({ renewals: { sent: 1 } });
    expect(m.count('create')).toBe(before + 1);
    expect((await row(rid)).send_state).toBe('sent');
  });

  it('PayPal refuses the create: the tick leaves it for Retry, and Retry on the renewal deal sends it', async () => {
    const d = await paidHarbor(true);
    m.failNext('create', 422, 'VALIDATION_ERROR');
    await tick(d.end - 6 * DAY);
    const rid = (await renewalOf(d.versionId))!;
    const r = await row(rid);
    expect(r.send_state).toBe('failed');
    const before = m.count('create');
    expect(await tick(d.end - 5 * DAY)).toMatchObject({ renewals: { sent: 0 } }); // no hourly retry against PayPal
    expect(m.count('create')).toBe(before);
    expect(await retry(db, m.api, s.creatorId, r.brief_id!)).toMatchObject({ ok: true, already: false });
    expect(m.count('create')).toBe(before + 1);
    expect((await row(rid)).send_state).toBe('sent');
  });

  it('a sent renewal with a missing payer link: Retry re-reads it with one GET and never makes a second invoice', async () => {
    const d = await paidHarbor(true);
    await tick(d.end - 6 * DAY);
    const rid = (await renewalOf(d.versionId))!;
    await db.query(`update invoices set payer_url = null where version_id = $1`, [rid]);
    const creates = m.count('create');
    const res = await retry(db, m.api, s.creatorId, (await row(rid)).brief_id!);
    expect(res).toMatchObject({ ok: true, already: true, payerUrl: expect.stringContaining('paypal.com') });
    expect(m.count('create')).toBe(creates);
    expect(await invoicesOf(rid)).toBe(1);
    expect((await db.query<{ payer_url: string | null }>(`select payer_url from invoices where version_id = $1`, [rid]))[0]!.payer_url).toBeTruthy();
  });
});

describe('review fix 4: R4 checks the whole renewed channel set', () => {
  it('an opted-in billboard licence with a high cap: the renewal fails R4 and waits for typed approval, no PayPal call', async () => {
    const morningPour = s.assetIds[0]!;
    const r = await intake(deps, { source: 'paste', clientId: s.clientId, assetId: morningPour, text: T.BILLBOARD, fixture: 'billboard' }, creator);
    if (!r.ok) throw new Error(r.error);
    await runAutopilot(db, m.api, r.briefId);
    let v = (await getBriefView(db, r.briefId))!.version!;
    expect(await approve(db, m.api, s.creatorId, { versionId: v.id }, (v.totalCents / 100).toFixed(2))).toMatchObject({ ok: true });
    v = (await getBriefView(db, r.briefId))!.version!;
    m.pay(v.invoice!.paypalInvoiceId!);
    expect((await grantIfPaid(g, v.id, 'test')).granted).toBe(true);
    await db.query(`update licence_versions set renewal_opt_in = true where id = $1`, [v.id]);
    await db.query(`update creator_settings set per_deal_cap_cents = 10000000 where creator_id = $1`, [s.creatorId]);
    const end = (await row(v.id)).end_at!.getTime();
    const before = m.count('create');
    expect(await tick(end - 6 * DAY)).toMatchObject({ renewals: { created: 1, sent: 0, held: 1 } });
    const rid = (await renewalOf(v.id))!;
    expect(m.count('create')).toBe(before);
    const p = (await row(rid)).policy!;
    expect(p.results.filter((x) => !x.pass).map((x) => x.code)).toEqual(['needs_approval:billboard']);
    expect((await listAsk(db, s.creatorId)).find((a) => a.versionId === rid)).toMatchObject({ renewal: true });
    // A later tick does not send it either.
    expect(await tick(end - 5 * DAY)).toMatchObject({ renewals: { sent: 0 } });
    expect(m.count('create')).toBe(before);
  });
});

describe('review fix 5: in demo mode the grant, refund and pay/download guards read the demo clock', () => {
  const savedDemo = process.env.DEMO_MODE;
  /** Puts the demo clock at instant `at` (offset from real time) and turns demo mode on or off for lib code. */
  const demoAt = async (at: number, on = true) => {
    if (on) process.env.DEMO_MODE = '1'; else delete process.env.DEMO_MODE;
    await db.query(`insert into demo_clock (id, offset_ms) values (true, $1) on conflict (id) do update set offset_ms = excluded.offset_ms`, [Math.max(0, at - Date.now())]);
  };
  afterEach(async () => {
    if (savedDemo === undefined) delete process.env.DEMO_MODE; else process.env.DEMO_MODE = savedDemo;
    await db.query(`update demo_clock set offset_ms = 0`);
  });
  const renewalInvoice = async (rid: string) => (await db.query<{ paypal_invoice_id: string }>(`select paypal_invoice_id from invoices where version_id = $1`, [rid]))[0]!.paypal_invoice_id;

  it('refund of an early-paid renewal after the demo clock passed the parent’s end: the parent stays ended, no download', async () => {
    const d = await paidHarbor(true);
    await tick(d.end - 6 * DAY);
    const rid = (await renewalOf(d.versionId))!;
    const cap = m.pay(await renewalInvoice(rid), { date: '2027-04-23' });
    expect((await grantIfPaid(g, rid, 'test')).granted).toBe(true);
    await demoAt(d.end + 2 * DAY);
    m.refund(cap);
    expect(await revokeVersion(g, rid, { source: 'test', captureId: cap, captureStatus: 'REFUNDED' })).toMatchObject({ revoked: true });
    expect((await row(d.versionId)).status).not.toBe('active');
    expect((await issueDownload(db, d.token)).ok).toBe(false);
  });

  it('a renewal paid late on the demo clock starts on the demo day; the real PayPal date stays the evidence', async () => {
    const d = await paidHarbor(true);
    await tick(d.end - 6 * DAY);
    const rid = (await renewalOf(d.versionId))!;
    const demoNow = d.end + 30 * DAY;
    await demoAt(demoNow);
    m.pay(await renewalInvoice(rid), { date: '2026-11-02' });
    expect((await grantIfPaid(g, rid, 'test')).granted).toBe(true);
    const tz = 'America/New_York';
    const term = termFromDay(tz, localDay(tz, new Date(demoNow)), 6);
    expect((await row(rid)).start_at!.toISOString()).toBe(term.start.toISOString());
    expect((await row(rid)).end_at!.toISOString()).toBe(term.end.toISOString());
    const [p] = await db.query<{ paid_at: Date }>(`select paid_at from payments where version_id = $1`, [rid]);
    expect(localDay(tz, p!.paid_at)).toEqual({ y: 2026, m: 11, d: 2 });
    // Not born expired: the next demo tick leaves it active.
    await runTick({ db, api: m.api, env: DEMO, real: () => Date.now() + DAY }); // the demo clock, a day later
    expect((await row(rid)).status).toBe('active');
  });

  it('live mode is unchanged: a stored offset is ignored by the grant term', async () => {
    const d = await paidHarbor(true);
    await tick(d.end - 6 * DAY);
    const rid = (await renewalOf(d.versionId))!;
    await demoAt(d.end + 30 * DAY, false);
    m.pay(await renewalInvoice(rid), { date: '2026-11-02' });
    expect((await grantIfPaid(g, rid, 'test')).granted).toBe(true);
    expect((await row(rid)).start_at!.toISOString()).toBe(new Date(d.end).toISOString()); // the parent's end day, as before
  });

  it('pay page and downloads: a term over on the demo clock is expired before any tick runs; live mode still real time', async () => {
    const d = await paidHarbor(false);
    expect((await issueDownload(db, d.token)).ok).toBe(true);
    await demoAt(d.end + DAY);
    expect((await payView(db, d.token))!.status).toBe('expired');
    expect((await issueDownload(db, d.token)).ok).toBe(false);
    await demoAt(d.end + DAY, false);
    expect((await payView(db, d.token))!.status).toBe('paid');
    expect((await issueDownload(db, d.token)).ok).toBe(true);
  });

  it('a download token minted before the demo end stops working once the demo clock passes the end', async () => {
    const d = await paidHarbor(false);
    const dl = await issueDownload(db, d.token);
    if (!dl.ok) throw new Error(dl.error);
    const t = dl.url.split('/').pop()!;
    await demoAt(d.end + DAY);
    expect(await consumeDownload(db, uploadsDir, t, { head: true })).toMatchObject({ ok: false, status: 410 });
    await demoAt(d.end + DAY, false);
    expect(await consumeDownload(db, uploadsDir, t, { head: true })).toMatchObject({ ok: true });
  });
});

describe('review fix 7: ledger and bell events carry real time; the demo date goes in the detail text', () => {
  const savedDemo = process.env.DEMO_MODE;
  afterEach(async () => {
    if (savedDemo === undefined) delete process.env.DEMO_MODE; else process.env.DEMO_MODE = savedDemo;
    await db.query(`update demo_clock set offset_ms = 0`);
  });

  it('advance, then pay the renewal: the grant is the newest ledger row and the bell counts 1 new', async () => {
    process.env.DEMO_MODE = '1';
    // Earlier tests in this file call evaluate() directly with a future `now`; those rows are not product behaviour.
    await db.query(`delete from events where created_at > now() + interval '1 minute'`);
    const d = await paidHarbor(true);
    expect(await advanceToNextRenewal(db, s.creatorId, DEMO)).toMatchObject({ ok: true, moved: true });
    expect(await runTick({ db, api: m.api, env: DEMO })).toMatchObject({ renewals: { sent: 1 } });
    const rid = (await renewalOf(d.versionId))!;
    const before = await listLedger(db, s.creatorId);
    const realNow = Date.now() + 1000;
    // Nothing from this advance and tick is stamped in the demo future.
    expect(before.filter((r) => r.versionId === rid || r.kind === 'clock').every((r) => new Date(r.createdAt).getTime() <= realNow)).toBe(true);
    const sent = before.find((r) => r.kind === 'renewal.sent' && r.versionId === rid)!;
    expect(sent.message).toMatch(/ Demo date: [A-Z][a-z]{2} \d{1,2}, 2027\.$/);
    const [brief] = await db.query<{ created_at: Date }>(`select created_at from briefs where id = $1`, [(await row(rid)).brief_id]);
    expect(brief!.created_at.getTime()).toBeLessThanOrEqual(realNow);
    const seen = Math.max(...bellItems(before).map((i) => new Date(i.row.createdAt).getTime()));

    m.pay((await db.query<{ paypal_invoice_id: string }>(`select paypal_invoice_id from invoices where version_id = $1`, [rid]))[0]!.paypal_invoice_id, { date: '2026-11-02' });
    expect((await grantIfPaid(g, rid, 'test')).granted).toBe(true);
    const after = await listLedger(db, s.creatorId);
    expect(after[0]).toMatchObject({ kind: 'grant', versionId: rid });
    expect(bellItems(after).filter((i) => !i.row.demo && new Date(i.row.createdAt).getTime() > seen)).toHaveLength(1);
  });

  it('rule rows from the demo tick are stamped real time and name the demo date', async () => {
    process.env.DEMO_MODE = '1';
    const d = await paidHarbor(false);
    await advanceToNextRenewal(db, s.creatorId, DEMO);
    await runTick({ db, api: m.api, env: DEMO });
    const rid = (await renewalOf(d.versionId))!;
    const rules = await db.query<{ created_at: Date; demo_date: string | null }>(
      `select created_at, detail->>'demoDate' as demo_date from events where kind = 'rule' and detail->>'versionId' = $1`, [rid]);
    expect(rules.length).toBeGreaterThan(0);
    for (const r of rules) {
      expect(r.created_at.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
      expect(new Date(r.demo_date!).getTime()).toBeGreaterThan(Date.now() + 100 * DAY);
    }
  });
});
