// Batch-6 review fixes (docs/reviews/b6-final-fixes.md F1-F22): one block per fix, each with its required test.
// PayPal is the in-memory mock; routes run through their real handlers on PGlite.
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderToString } from 'react-dom/server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST as decidePOST } from '@/app/api/briefs/[id]/decide/route';
import { GET as ledgerGET } from '@/app/api/ledger/route';
import { GET as payGET } from '@/app/api/pay/[token]/route';
import { POST as checkPOST } from '@/app/api/pay/[token]/check/route';
import { POST as dlIssuePOST } from '@/app/api/pay/[token]/download/route';
import { GET as previewGET } from '@/app/api/pay/[token]/preview/route';
import { POST as webhookPOST } from '@/app/api/paypal/webhook/route';
import { GET as downloadGET, HEAD as downloadHEAD } from '@/app/download/[token]/route';
import ReceiptPage, { metadata as receiptMetadata } from '@/app/r/[id]/page';
import { openPglite, type Db } from '../db/client';
import { initialize } from '../db/init';
import { migrate } from '../db/migrate';
import { seed, type SeedResult } from '../db/seed';
import { createAdapter, fixtureProvider } from '../lib/ai/extract';
import { confirmTranscript, getBriefView, type AiFor } from '../lib/briefs';
import { checkInvoicePaid, effectivePayment, grantIfPaid, licenceTerm, paymentReasonWords, recheck, revokeFromCapture, revokeVersion, termFromDay, type GrantDeps } from '../lib/grant';
import { hashToken as intakeHashToken, intake, type IntakeDeps } from '../lib/intake';
import { listAlerts, listLedger } from '../lib/ledger';
import { getOverview, listPaidVersions, moneyTotals } from '../lib/overview';
import { isCascadedRevoke, ledgerSentence } from '@/components/creator/deal-extras';
import { bellText } from '@/components/creator/activity-bell';
import { consumeDownload, issueDownload, PAY_LIMITS, payView, rotatePayLink } from '../lib/pay';
import { RawJson, type PayPalClient } from '../lib/paypal/client';
import type { InvoiceJson } from '../lib/paypal/payments';
import { restPaymentsApi } from '../lib/paypal/payments';
import { ensureAssetFiles } from '../lib/placeholder-files';
import { localDay } from '../lib/policy';
import { ipHashOf, rateLimit } from '../lib/rate-limit';
import { normalizeReceiptBody, receiptView } from '../lib/receipts';
import { cancelAndRequote, runAutopilot } from '../lib/send';
import { setRouteDepsForTests } from '../lib/server';
import { assetPath, readAsset, sha256Bytes } from '../lib/storage';
import { AppSecretError, decryptToken, encryptToken, hashToken, newToken } from '../lib/tokens';
import { handleWebhook } from '../lib/webhooks';
import * as T from './fixtures/texts';
import { mockInvoiceApi } from './helpers/mock-paypal';

let db: Db;
let s: SeedResult;
let deps: IntakeDeps;
let uploadsDir: string;
let emptyDir: string;
let morningPour: string;
let harborLight: string;
let m: ReturnType<typeof mockInvoiceApi>;
let g: GrantDeps;
const aiFor: AiFor = (fixture) => createAdapter(fixtureProvider(fixture ?? 'paste'));
const creator = { creator: true, sessionSlug: 'imani' };
const TOKEN = 'b6-fixes-creator-token';
const HOOK_ENV = { PAYPAL_WEBHOOK_ID: 'WH-TEST-0001' } as unknown as NodeJS.ProcessEnv;
const saved = { token: process.env.CREATOR_TOKEN, hook: process.env.PAYPAL_WEBHOOK_ID, origin: process.env.APP_ORIGIN, base: process.env.PUBLIC_BASE_URL };
let ipSeq = 0;
let evSeq = 0;

const ctx = <K extends string>(k: K, v: string) => ({ params: Promise.resolve({ [k]: v } as Record<K, string>) });
const pub = (path: string, method = 'GET', ip = `192.0.2.${++ipSeq % 250}`, origin = 'http://app.test') =>
  new Request(`http://app.test${path}`, { method, headers: { host: 'app.test', origin, 'x-forwarded-for': ip } });
const creatorPost = (path: string, body: unknown, cookie = true) =>
  new Request(`http://app.test${path}`, { method: 'POST', body: JSON.stringify(body), headers: { host: 'app.test', origin: 'http://app.test', ...(cookie ? { cookie: `ur_creator=${TOKEN}` } : {}), 'content-type': 'application/json' } });
const hookHeaders = (sig = 'good') => new Headers({
  'paypal-auth-algo': 'SHA256withRSA', 'paypal-cert-url': 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1',
  'paypal-transmission-id': `t-${++evSeq}`, 'paypal-transmission-sig': sig, 'paypal-transmission-time': new Date().toISOString(),
});
const eventId = () => `WH-B6FIX-${String(++evSeq).padStart(6, '0')}`;
const paidEvent = (invoiceId: string, number: string, id = eventId()) => JSON.stringify({ id, event_type: 'INVOICING.INVOICE.PAID', resource: { invoice: { id: invoiceId, detail: { invoice_number: number } } } });
const refundEvent = (captureId: string, id = eventId(), refundId = 'REF123456') => JSON.stringify({ id, event_type: 'PAYMENT.CAPTURE.REFUNDED', resource: { id: refundId, status: 'COMPLETED', links: [{ rel: 'up', href: `https://api.sandbox.paypal.com/v2/payments/captures/${captureId}` }] } });
const reversedEvent = (captureId: string, id = eventId()) => JSON.stringify({ id, event_type: 'PAYMENT.CAPTURE.REVERSED', resource: { id: captureId, status: 'REVERSED' } });
const hookReq = (body: string | ReadableStream<Uint8Array>, headers = hookHeaders()) =>
  new Request('http://app.test/api/paypal/webhook', { method: 'POST', body, headers, ...(typeof body === 'string' ? {} : { duplex: 'half' }) } as RequestInit);

async function paste(fixture: string, text: string, assetId: string) {
  const r = await intake(deps, { source: 'paste', clientId: s.clientId, assetId, text, fixture }, creator);
  if (!r.ok) throw new Error(r.error);
  return r.briefId;
}
async function deal(briefId: string) {
  const v = (await getBriefView(db, briefId))!.version!;
  const token = v.invoice!.payPath!.split('/').pop()!;
  return { briefId, versionId: v.id, paypalId: v.invoice!.paypalInvoiceId!, number: v.invoice!.invoiceNumber, token };
}
/** The $420 demo deal (print added to the seeded social v1), invoiced on autopilot. */
async function demoInvoiced() {
  const png = await readFile(join(import.meta.dirname, 'fixtures', 'demo-dm.png'));
  const r = await intake(deps, { source: 'screenshot', clientId: s.clientId, assetId: morningPour, fixture: 'demo-dm', image: { mime: 'image/png', base64: png.toString('base64') } }, creator);
  if (!r.ok) throw new Error(r.error);
  await confirmTranscript(db, aiFor, r.briefId, T.DEMO_DM);
  expect(await runAutopilot(db, m.api, r.briefId)).toMatchObject({ action: 'sent' });
  return deal(r.briefId);
}
async function paidDemo() {
  const d = await demoInvoiced();
  const txn = m.pay(d.paypalId);
  expect((await grantIfPaid(g, d.versionId, 'test')).granted).toBe(true);
  return { ...d, txn };
}
/** Harbor Light web v1 (no licence yet), invoiced. */
async function harborV1() {
  const id = await paste('suggests-price', T.SUGGESTS_PRICE, harborLight);
  expect(await runAutopilot(db, m.api, id)).toMatchObject({ action: 'sent' });
  return deal(id);
}
/** A Harbor Light social upgrade on top of the current licence, invoiced. */
async function harborUpgrade() {
  const id = await paste('paste', T.PASTE, harborLight);
  expect(await runAutopilot(db, m.api, id)).toMatchObject({ action: 'sent' });
  return deal(id);
}
const versionRow = (id: string) => db.query<{ status: string; paid_cents: number; version_no: number; start_at: Date | null; end_at: Date | null; withdrawn_at: Date | null; withdraw_state: string | null; locked_capture_id: string | null }>(
  `select status, paid_cents, version_no, start_at, end_at, withdrawn_at, withdraw_state, locked_capture_id from licence_versions where id = $1`, [id]).then((r) => r[0]!);
const count = async (sql: string, params: unknown[]) => (await db.query<{ n: number }>(`select count(*)::int as n from ${sql}`, params))[0]!.n;
const dlToken = (url: string) => url.split('/').pop()!;
/** A payments API whose invoice reads are rewritten (for evidence the mock cannot produce by itself). */
const bend = (fn: (inv: InvoiceJson) => InvoiceJson): GrantDeps => ({
  ...g, pp: { ...g.pp, payments: { ...m.payments, getInvoice: async (id: string) => fn(await m.payments.getInvoice(id)) } },
});

beforeAll(async () => {
  db = await openPglite();
  await migrate(db);
  s = await seed(db);
  [morningPour, harborLight] = s.assetIds as [string, string];
  uploadsDir = await mkdtemp(join(tmpdir(), 'ur-b6fix-'));
  emptyDir = await mkdtemp(join(tmpdir(), 'ur-b6fix-empty-'));
  await ensureAssetFiles(db, uploadsDir);
  deps = { db, aiFor, uploadsDir, env: { AI_PROVIDER: 'fixture', NODE_ENV: 'test' } as unknown as NodeJS.ProcessEnv };
  process.env.CREATOR_TOKEN = TOKEN;
  process.env.PAYPAL_WEBHOOK_ID = 'WH-TEST-0001';
  process.env.PUBLIC_BASE_URL = 'https://useright.example';
  delete process.env.APP_ORIGIN;
});
afterAll(async () => {
  setRouteDepsForTests(null);
  for (const [k, v] of [['CREATOR_TOKEN', saved.token], ['PAYPAL_WEBHOOK_ID', saved.hook], ['APP_ORIGIN', saved.origin], ['PUBLIC_BASE_URL', saved.base]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await db?.close();
  for (const d of [uploadsDir, emptyDir]) if (d) await rm(d, { recursive: true, force: true });
});
beforeEach(async () => {
  m = mockInvoiceApi();
  g = { db, pp: m.pp, uploadsDir };
  setRouteDepsForTests({ db, aiFor, invoices: m.api, payments: m.payments, uploadsDir });
  await db.query(`update autopilot_sends set status = 'released' where status in ('reserved', 'sent')`);
  await db.query(`update creator_settings set per_deal_cap_cents = 50000, daily_max_sends = 50, rolling30_cap_cents = 10000000, timezone = 'America/New_York' where creator_id = $1`, [s.creatorId]);
  // Each test starts with the seed's v1 as the only current licence; open quotes from earlier tests are closed.
  await db.query(`update licence_versions set status = 'superseded' where status in ('active', 'pending') and id <> $1`, [s.v1Id]);
  await db.query(`update licence_versions set status = 'active' where id = $1`, [s.v1Id]);
  await db.query(`delete from rate_hits`);
});
afterEach(() => {
  setRouteDepsForTests(null);
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------- F1

describe('F1: refunding a parent invalidates its pending descendants', () => {
  it('cancel fails, then PayPal shows the child paid: the child never activates; a retried root event finishes cleanup once', async () => {
    const d1 = await harborV1();
    const txn1 = m.pay(d1.paypalId);
    expect((await grantIfPaid(g, d1.versionId, 'test')).granted).toBe(true);
    const paid1 = (await versionRow(d1.versionId)).paid_cents;
    const d2 = await harborUpgrade();
    m.refund(txn1);
    m.failNext('get', 500); // cancelAndRequote's PayPal read fails: the child cannot be cancelled now
    const body = refundEvent(txn1);
    const first = await webhookPOST(hookReq(body));
    expect(first.status).toBe(503); // cleanup unfinished: PayPal must retry
    expect((await versionRow(d1.versionId)).status).toBe('refunded');
    const child = await versionRow(d2.versionId);
    expect(child).toMatchObject({ status: 'pending', withdraw_state: null });
    expect(child.withdrawn_at).not.toBeNull();
    expect((await listAlerts(db, s.creatorId)).some((a) => a.kind === 'withdraw_failed' && a.briefId === d2.briefId)).toBe(true);
    expect((await payView(db, d2.token))!.status).toBe('cancelled');

    // The client pays the child anyway: no activation and no refunded credit.
    m.pay(d2.paypalId);
    expect(await grantIfPaid(g, d2.versionId, 'test')).toEqual({ granted: false, reason: 'stale_version' });
    expect(await versionRow(d2.versionId)).toMatchObject({ status: 'pending' });
    expect((await versionRow(d2.versionId)).paid_cents).toBe(0);
    expect(await count(`payments where version_id = $1`, [d2.versionId])).toBe(0);
    expect(paid1).toBeGreaterThan(0);

    // PayPal retries the root event: cleanup runs again, finds the child paid -> alert, no duplicate receipts.
    const again = await webhookPOST(hookReq(body));
    expect(again.status).toBe(200);
    expect((await versionRow(d2.versionId)).withdraw_state).toBe('paid');
    expect((await listAlerts(db, s.creatorId)).some((a) => a.kind === 'withdraw_paid' && a.briefId === d2.briefId)).toBe(true);
    expect(await count(`receipts where version_id = $1 and status = 'refunded'`, [d1.versionId])).toBe(1);
    expect(await count(`receipts where version_id = $1`, [d2.versionId])).toBe(0);
    // A third delivery is a processed duplicate.
    expect((await (await webhookPOST(hookReq(body))).json())).toMatchObject({ duplicate: true });
  });

  it('cancel fails once, the retry cancels at PayPal and releases the reservation exactly once', async () => {
    const d1 = await harborV1();
    const txn1 = m.pay(d1.paypalId);
    await grantIfPaid(g, d1.versionId, 'test');
    const d2 = await harborUpgrade();
    m.refund(txn1);
    m.failNext('get', 'timeout');
    const body = refundEvent(txn1);
    expect((await handleWebhook(g, hookHeaders(), body, HOOK_ENV)).status).toBe(503);
    expect(await db.query(`select status from autopilot_sends where version_id = $1`, [d2.versionId])).toEqual([{ status: 'sent' }]);
    expect((await handleWebhook(g, hookHeaders(), body, HOOK_ENV)).status).toBe(200);
    expect(m.invoices.get(d2.paypalId)!.status).toBe('CANCELLED');
    expect(await versionRow(d2.versionId)).toMatchObject({ status: 'superseded', withdraw_state: 'done' });
    expect(await db.query(`select status from autopilot_sends where version_id = $1`, [d2.versionId])).toEqual([{ status: 'released' }]);
    expect(await count(`events where kind = 'revoked_by_parent_refund' and detail->>'versionId' = $1`, [d2.versionId])).toBe(1);
    expect(await count(`receipts where version_id = $1 and status = 'refunded'`, [d1.versionId])).toBe(1);
  });
});

// ---------------------------------------------------------------- F2

describe('F2: PayPal delivery retries (503 / 200 / 400 ruling)', () => {
  it('verification network rejection -> 503 and nothing stored', async () => {
    const body = paidEvent('INV2-NONE-0001', 'UR-0000000000000000000000');
    m.failNext('verifyWebhook', 'network');
    const res = await webhookPOST(hookReq(body));
    expect(res.status).toBe(503);
    expect(await count(`webhook_events where event_id = $1`, [JSON.parse(body).id])).toBe(0);
  });

  it('verification PayPal 4xx is an outage, not a bad signature -> 503', async () => {
    m.failNext('verifyWebhook', 401);
    expect((await webhookPOST(hookReq(paidEvent('INV2-NONE-0002', 'UR-0000000000000000000000')))).status).toBe(503);
  });

  it('invoice re-fetch fails -> 503, processed_at null; the same event id later processes once', async () => {
    const d = await demoInvoiced();
    m.pay(d.paypalId);
    const body = paidEvent(d.paypalId, d.number);
    m.failNext('getInvoice', 503);
    expect((await webhookPOST(hookReq(body))).status).toBe(503);
    expect(await db.query(`select processed_at, error from webhook_events where event_id = $1`, [JSON.parse(body).id])).toEqual([{ processed_at: null, error: 'paypal_unavailable' }]);
    const ok = await webhookPOST(hookReq(body));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ result: 'granted' });
    const dup = await webhookPOST(hookReq(body));
    expect(dup.status).toBe(200);
    expect(await dup.json()).toMatchObject({ duplicate: true });
    expect(await count(`payments where version_id = $1`, [d.versionId])).toBe(1);
    expect(await count(`receipts where version_id = $1`, [d.versionId])).toBe(1);
  });

  it('capture re-fetch fails -> 503 and the licence stays until the retry revokes it', async () => {
    const d = await paidDemo();
    m.refund(d.txn);
    const body = refundEvent(d.txn);
    m.failNext('getCapture', 500);
    expect((await webhookPOST(hookReq(body))).status).toBe(503);
    expect((await versionRow(d.versionId)).status).toBe('active');
    const ok = await webhookPOST(hookReq(body));
    expect(ok.status).toBe(200);
    expect((await versionRow(d.versionId)).status).toBe('refunded');
  });

  it('bad signature -> 400, nothing stored; irrelevant event -> 200', async () => {
    const body = paidEvent('INV2-NONE-0003', 'UR-0000000000000000000000');
    expect((await webhookPOST(hookReq(body, hookHeaders('bad')))).status).toBe(400);
    expect(await count(`webhook_events where event_id = $1`, [JSON.parse(body).id])).toBe(0);
    const other = JSON.stringify({ id: eventId(), event_type: 'CUSTOMER.DISPUTE.CREATED', resource: { id: 'PP-D-1' } });
    const res = await webhookPOST(hookReq(other));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ result: 'ignored' });
    expect(await count(`webhook_events where event_id = $1 and processed_at is not null`, [JSON.parse(other).id])).toBe(1);
  });
});

// ---------------------------------------------------------------- F3

describe('F3: one current licence branch', () => {
  it('two pending siblings of v1 paid concurrently: one active successor, unique numbers, no double credit, a stale alert', async () => {
    const d1 = await harborV1();
    m.pay(d1.paypalId);
    await grantIfPaid(g, d1.versionId, 'test');
    const paid1 = (await versionRow(d1.versionId)).paid_cents;
    const a = await harborUpgrade();
    const b = await harborUpgrade();
    m.pay(a.paypalId);
    m.pay(b.paypalId);
    const [ra, rb] = await Promise.all([grantIfPaid(g, a.versionId, 'test'), grantIfPaid(g, b.versionId, 'test')]);
    const results = [ra, rb];
    expect(results.filter((r) => r.granted)).toHaveLength(1);
    expect(results.filter((r) => !r.granted && r.reason === 'stale_version')).toHaveLength(1);
    const winner = ra.granted ? a : b;
    const loser = ra.granted ? b : a;
    expect(await count(`licence_versions where client_id = $1 and asset_id = $2 and status = 'active'`, [s.clientId, harborLight])).toBe(1);
    const w = await versionRow(winner.versionId);
    expect(w.status).toBe('active');
    expect(w.paid_cents).toBe(paid1 + (await db.query<{ amount_cents: number }>(`select amount_cents from payments where version_id = $1`, [winner.versionId]))[0]!.amount_cents);
    expect((await versionRow(loser.versionId)).status).toBe('pending');
    expect(await count(`payments where version_id = $1`, [loser.versionId])).toBe(0);
    // Unique numbers on this branch (a root is always v1 by the schema check, so earlier roots also hold 1).
    const nos = await db.query<{ version_no: number }>(
      `select version_no from licence_versions where (id = $1 or parent_id = $1) and status in ('active', 'superseded', 'refunded', 'expired')`, [d1.versionId]);
    expect(nos.length).toBe(2);
    expect(new Set(nos.map((n) => n.version_no)).size).toBe(nos.length);
    expect((await listAlerts(db, s.creatorId)).some((x) => x.kind === 'paid_on_stale_version' && x.briefId === loser.briefId)).toBe(true);
  });

  it('a refunded parent (no withdrawal recorded) still refuses its child at grant', async () => {
    const d1 = await harborV1();
    m.pay(d1.paypalId);
    await grantIfPaid(g, d1.versionId, 'test');
    const d2 = await harborUpgrade();
    await db.query(`update licence_versions set status = 'refunded' where id = $1`, [d1.versionId]);
    m.pay(d2.paypalId);
    expect(await grantIfPaid(g, d2.versionId, 'test')).toEqual({ granted: false, reason: 'stale_version' });
    expect((await versionRow(d2.versionId)).status).toBe('pending');
    expect((await listAlerts(db, s.creatorId)).some((x) => x.kind === 'paid_on_stale_version' && x.briefId === d2.briefId)).toBe(true);
  });

  it('two root (v1) quotes paid concurrently: one active, the other a stale alert', async () => {
    const a = await harborV1();
    const b = await harborV1();
    m.pay(a.paypalId);
    m.pay(b.paypalId);
    const res = await Promise.all([grantIfPaid(g, a.versionId, 'test'), grantIfPaid(g, b.versionId, 'test')]);
    expect(res.filter((r) => r.granted)).toHaveLength(1);
    expect(await count(`licence_versions where client_id = $1 and asset_id = $2 and status = 'active'`, [s.clientId, harborLight])).toBe(1);
    const loser = res[0]!.granted ? b : a;
    expect((await listAlerts(db, s.creatorId)).some((x) => x.kind === 'paid_on_stale_version' && x.briefId === loser.briefId)).toBe(true);
    expect(await count(`payments where version_id = any($1::uuid[])`, [[a.versionId, b.versionId]])).toBe(1);
    // A root is v1 by the schema check (version_no = 1 exactly when there is no parent); only one v1 is current.
    expect(await count(`licence_versions where client_id = $1 and asset_id = $2 and status = 'active' and version_no = 1`, [s.clientId, harborLight])).toBe(1);
  });

  it('database backstop: a second active licence for one client + photo is refused', async () => {
    await expect(db.query(
      `insert into licence_versions (creator_id, client_id, asset_id, parent_id, version_no, scope, rate_card, total_cents, status)
       select creator_id, client_id, asset_id, null, 1, scope, rate_card, 0, 'active' from licence_versions where id = $1`, [s.v1Id])).rejects.toThrow(/duplicate|unique/);
  });
});

// ---------------------------------------------------------------- F4

describe('F4: early payments and out-of-order refunds', () => {
  it('PAID before local markSent (in flight): exactly one payment and receipt, no extra invoice', async () => {
    const id = await paste('suggests-price', T.SUGGESTS_PRICE, harborLight);
    const send = m.api.send.bind(m.api);
    let delivered: { status: number } | null = null;
    m.api.send = async (paypalId: string) => {
      await send(paypalId);
      m.pay(paypalId);
      const [row] = await db.query<{ invoice_number: string; state: string }>(`select invoice_number, state from invoices where paypal_invoice_id = $1`, [paypalId]);
      expect(row!.state).toBe('created');
      delivered = await handleWebhook(g, hookHeaders(), paidEvent(paypalId, row!.invoice_number), HOOK_ENV);
    };
    expect(await runAutopilot(db, m.api, id)).toMatchObject({ action: 'sent' });
    expect(delivered).toMatchObject({ status: 200 });
    const v = (await getBriefView(db, id))!.version!;
    expect(await versionRow(v.id)).toMatchObject({ status: 'active' });
    expect(v.invoice!.state).toBe('paid');
    expect(await count(`payments where version_id = $1`, [v.id])).toBe(1);
    expect(await count(`receipts where version_id = $1`, [v.id])).toBe(1);
    expect(m.count('create')).toBe(1);
    expect(m.count('findByNumber')).toBe(0);
    expect(await db.query(`select status from autopilot_sends where version_id = $1 and status = 'sent'`, [v.id])).toHaveLength(1);
  });

  it('PAID after a crash before markSent (row left created): recovered once, Retry creates nothing', async () => {
    const d = await harborV1();
    await db.query(`update invoices set state = 'created', sent_at = null where paypal_invoice_id = $1`, [d.paypalId]);
    await db.query(`update licence_versions set send_state = 'sending' where id = $1`, [d.versionId]);
    m.pay(d.paypalId);
    expect(await handleWebhook(g, hookHeaders(), paidEvent(d.paypalId, d.number), HOOK_ENV)).toMatchObject({ status: 200, body: { result: 'granted' } });
    expect(await count(`payments where version_id = $1`, [d.versionId])).toBe(1);
    expect(await db.query(`select state from invoices where version_id = $1`, [d.versionId])).toEqual([{ state: 'paid' }]);
    const r = await decidePOST(creatorPost(`/api/briefs/${d.briefId}/decide`, { action: 'retry' }), ctx('id', d.briefId));
    expect(r.status).toBeGreaterThanOrEqual(200);
    expect(m.count('create')).toBe(1);
  });

  it('a verified refund before the payment mapping commits: no usable licence or download survives', async () => {
    const d = await demoInvoiced();
    const txn = m.pay(d.paypalId);
    m.reverse(txn); // PayPal's invoice still reads PAID; the capture is reversed
    expect(await handleWebhook(g, hookHeaders(), reversedEvent(txn), HOOK_ENV)).toMatchObject({ status: 200, body: { result: 'stored_unmapped' } });
    expect(await grantIfPaid(g, d.versionId, 'test')).toEqual({ granted: false, reason: 'refunded_before_grant' });
    // Fix round 2 (review major 1): PayPal shows the money returned, so the quote is closed rather than left pending.
    expect(await versionRow(d.versionId)).toMatchObject({ status: 'superseded', withdraw_state: 'refunded', locked_capture_id: txn });
    expect((await payView(db, d.token))!.status).toBe('refunded');
    expect(await issueDownload(db, d.token)).toMatchObject({ ok: false, status: 409 });
    expect((await listAlerts(db, s.creatorId)).some((a) => a.kind === 'refunded_before_grant')).toBe(true);
  });

  it('a duplicate PAID after local revocation does not report or restore a live grant', async () => {
    const d = await paidDemo();
    m.refund(d.txn);
    await handleWebhook(g, hookHeaders(), refundEvent(d.txn), HOOK_ENV);
    expect((await versionRow(d.versionId)).status).toBe('refunded');
    expect(await grantIfPaid(g, d.versionId, 'test')).toEqual({ granted: false, reason: 'refunded' });
    expect(await handleWebhook(g, hookHeaders(), paidEvent(d.paypalId, d.number), HOOK_ENV)).toMatchObject({ status: 200, body: { result: 'not_granted:refunded' } });
    expect((await versionRow(d.versionId)).status).toBe('refunded');
  });

  it('INVOICE.REFUNDED for a payment not recorded yet keeps the reversal evidence and is processed (review #5)', async () => {
    const d = await demoInvoiced();
    const txn = m.pay(d.paypalId);
    m.refund(txn);
    const body = JSON.stringify({ id: eventId(), event_type: 'INVOICING.INVOICE.REFUNDED', resource: { invoice: { id: d.paypalId, detail: { invoice_number: d.number } } } });
    // review final (5bae423 check new #1): the quote is closed rather than left pending forever.
    expect(await handleWebhook(g, hookHeaders(), body, HOOK_ENV)).toMatchObject({ status: 200, body: { result: 'locked_closed' } });
    expect(await db.query(`select status from capture_reversals where capture_id = $1`, [txn])).toEqual([{ status: 'REFUNDED' }]);
    expect(await versionRow(d.versionId)).toMatchObject({ status: 'superseded', withdraw_state: 'refunded' });
    expect(await grantIfPaid(g, d.versionId, 'test')).toMatchObject({ granted: false });
    expect(await count(`payments where version_id = $1`, [d.versionId])).toBe(0);
    // Even a bent read that still says PAID cannot unlock the closed quote.
    expect(await grantIfPaid(bend((inv) => ({ ...inv, status: 'PAID' })), d.versionId, 'test')).toMatchObject({ granted: false });
    expect(await count(`payments where version_id = $1`, [d.versionId])).toBe(0);
  });
});

// ---------------------------------------------------------------- F5

describe('F5: creator Re-check reads recorded captures', () => {
  it('a PAID invoice with a REVERSED capture revokes', async () => {
    const d = await paidDemo();
    m.reverse(d.txn);
    const r = await recheck(g, d.versionId, 'creator');
    expect(r).toMatchObject({ checked: true, outcome: 'revoked' });
    expect((await versionRow(d.versionId)).status).toBe('refunded');
  });

  it('a refund of superseded v1 revokes v1 and its descendant v2', async () => {
    const d1 = await harborV1();
    const txn1 = m.pay(d1.paypalId);
    await grantIfPaid(g, d1.versionId, 'test');
    const d2 = await harborUpgrade();
    m.pay(d2.paypalId);
    await grantIfPaid(g, d2.versionId, 'test');
    expect((await versionRow(d1.versionId)).status).toBe('superseded');
    m.reverse(txn1);
    expect(await recheck(g, d2.versionId, 'creator')).toMatchObject({ outcome: 'revoked' });
    expect((await versionRow(d1.versionId)).status).toBe('refunded');
    expect((await versionRow(d2.versionId)).status).toBe('refunded');
  });

  it('an unavailable capture read changes nothing and says so; an intact capture says unchanged', async () => {
    const d = await paidDemo();
    m.failNext('getCapture', 500);
    expect(await recheck(g, d.versionId, 'creator')).toMatchObject({ checked: true, outcome: 'unavailable' });
    expect((await versionRow(d.versionId)).status).toBe('active');
    expect(await recheck(g, d.versionId, 'creator')).toMatchObject({ checked: true, outcome: 'unchanged' });
  });
});

// ---------------------------------------------------------------- F6, F20 (rate budgets)

describe('F6 + F20: polling cannot exhaust the download budget', () => {
  it('three full 2-minute polling sessions from one address, then a paid download issues and serves', async () => {
    const d = await paidDemo();
    const ip = '203.0.113.77';
    m.reset();
    for (let session = 0; session < 3; session++) {
      for (let i = 0; i < 40; i++) expect((await payGET(pub(`/api/pay/${d.token}`, 'GET', ip), ctx('token', d.token))).status).toBe(200);
      for (let i = 0; i < 3; i++) expect((await checkPOST(pub(`/api/pay/${d.token}/check`, 'POST', ip), ctx('token', d.token))).status).toBe(200);
    }
    const issued = await dlIssuePOST(pub(`/api/pay/${d.token}/download`, 'POST', ip), ctx('token', d.token));
    expect(issued.status).toBe(200);
    const t = dlToken((await issued.json()).url);
    expect((await downloadGET(pub(`/download/${t}`, 'GET', ip), ctx('token', t))).status).toBe(200);
  });

  it('each budget still rejects its own excess, and only its own', async () => {
    const d = await paidDemo();
    const ip = '203.0.113.88';
    const fill = (kind: keyof typeof PAY_LIMITS) =>
      db.query(`insert into rate_hits (kind, ip_hash, at) select $1, $2, now() - interval '1 minute' from generate_series(1, $3)`, [kind, ipHashOf(ip), PAY_LIMITS[kind]]);
    await fill('pay_read');
    expect((await payGET(pub(`/api/pay/${d.token}`, 'GET', ip), ctx('token', d.token))).status).toBe(429);
    expect((await checkPOST(pub(`/api/pay/${d.token}/check`, 'POST', ip), ctx('token', d.token))).status).toBe(200);
    await fill('pay_check');
    expect((await checkPOST(pub(`/api/pay/${d.token}/check`, 'POST', ip), ctx('token', d.token))).status).toBe(429);
    const issued = await dlIssuePOST(pub(`/api/pay/${d.token}/download`, 'POST', ip), ctx('token', d.token));
    expect(issued.status).toBe(200);
    const t = dlToken((await issued.json()).url);
    await fill('download_issue');
    expect((await dlIssuePOST(pub(`/api/pay/${d.token}/download`, 'POST', ip), ctx('token', d.token))).status).toBe(429);
    expect((await downloadGET(pub(`/download/${t}`, 'GET', ip), ctx('token', t))).status).toBe(200);
    await fill('download_serve');
    expect((await downloadGET(pub(`/download/${t}`, 'GET', ip), ctx('token', t))).status).toBe(429);
    await fill('pay_preview');
    expect((await previewGET(pub(`/api/pay/${d.token}/preview`, 'GET', ip), ctx('token', d.token))).status).toBe(429);
  });

  it('rapid focus / button checks cause one PayPal call per 10 s', async () => {
    const d = await demoInvoiced();
    m.reset();
    for (let i = 0; i < 6; i++) await checkPOST(pub(`/api/pay/${d.token}/check`, 'POST'), ctx('token', d.token));
    expect(m.count('getInvoice')).toBe(1);
  });
});

// ---------------------------------------------------------------- F7

describe('F7: download authorization after file preparation; rotation revokes', () => {
  it('a refund committed while the file is being prepared -> no bytes, no use taken', async () => {
    const d = await paidDemo();
    const dl = await issueDownload(db, d.token);
    if (!dl.ok) throw new Error(dl.error);
    m.refund(d.txn);
    const r = await consumeDownload(db, uploadsDir, dlToken(dl.url), {
      beforeAuthorize: async () => { await handleWebhook(g, hookHeaders(), refundEvent(d.txn), HOOK_ENV); },
    });
    expect(r).toMatchObject({ ok: false, status: 410 });
    expect(await db.query(`select uses from download_tokens where token_hash = $1`, [hashToken(dlToken(dl.url))])).toEqual([{ uses: 0 }]);
  });

  it('rotating the pay link voids downloads issued from the old link', async () => {
    const d = await paidDemo();
    const dl = await issueDownload(db, d.token);
    if (!dl.ok) throw new Error(dl.error);
    const rot = await rotatePayLink(db, s.creatorId, d.briefId);
    expect(rot.ok).toBe(true);
    expect(await db.query(`select voided_at is not null as voided from download_tokens where token_hash = $1`, [hashToken(dlToken(dl.url))])).toEqual([{ voided: true }]);
    expect(await consumeDownload(db, uploadsDir, dlToken(dl.url))).toMatchObject({ ok: false, status: 410 });
    expect(await issueDownload(db, d.token)).toMatchObject({ ok: false, status: 404 });
  });

  it('issuance racing rotation never yields a valid token from the old credential', async () => {
    const d = await paidDemo();
    const [issued] = await Promise.all([issueDownload(db, d.token), rotatePayLink(db, s.creatorId, d.briefId)]);
    if (issued.ok) expect(await consumeDownload(db, uploadsDir, dlToken(issued.url))).toMatchObject({ ok: false, status: 410 });
    else expect(issued.status).toBe(404);
  });

  it('concurrent requests at uses=2: exactly one success; HEAD after exhaustion refused and free', async () => {
    const d = await paidDemo();
    const dl = await issueDownload(db, d.token);
    if (!dl.ok) throw new Error(dl.error);
    const t = dlToken(dl.url);
    await db.query(`update download_tokens set uses = 2 where token_hash = $1`, [hashToken(t)]);
    const res = await Promise.all([1, 2, 3].map(() => consumeDownload(db, uploadsDir, t)));
    expect(res.filter((r) => r.ok)).toHaveLength(1);
    expect((await downloadHEAD(pub(`/download/${t}`, 'HEAD'), ctx('token', t))).status).toBe(410);
    expect(await db.query(`select uses from download_tokens where token_hash = $1`, [hashToken(t)])).toEqual([{ uses: 3 }]);
  });
});

// ---------------------------------------------------------------- F8

describe('F8: the receipt hashes the exact licensed file', () => {
  it('fresh initialization prepares every asset file', async () => {
    const fresh = await openPglite();
    const dir = await mkdtemp(join(tmpdir(), 'ur-b6fix-init-'));
    try {
      const r = await initialize(fresh, dir);
      expect(r.filesWritten).toBeGreaterThan(0);
      const assets = await fresh.query<{ key_web: string; key_print: string; key_preview: string }>(`select key_web, key_print, key_preview from assets`);
      for (const a of assets) for (const k of [a.key_web, a.key_print, a.key_preview]) expect(await readAsset(dir, k)).not.toBeNull();
      expect((await initialize(fresh, dir)).filesWritten).toBe(0);
    } finally {
      await fresh.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('print and web grants record the hash of the bytes the download serves', async () => {
    const p = await paidDemo(); // print in scope
    const w = await harborV1();
    m.pay(w.paypalId);
    await grantIfPaid(g, w.versionId, 'test');
    for (const d of [p, w]) {
      const dl = await issueDownload(db, d.token);
      if (!dl.ok) throw new Error(dl.error);
      const served = await consumeDownload(db, uploadsDir, dlToken(dl.url));
      if (!served.ok) throw new Error(served.error);
      const [rc] = await db.query<{ sha: string; file: string }>(`select body->'asset'->>'sha256' as sha, body->'asset'->>'file' as file from receipts where version_id = $1`, [d.versionId]);
      expect(rc!.sha).toBe(sha256Bytes(served.bytes!));
      expect(served.filename).toContain(`-${rc!.file}.`);
    }
  });

  it('a missing file issues no receipt and no guessed hash; recovery succeeds once', async () => {
    const d = await demoInvoiced();
    m.pay(d.paypalId);
    const missing = { ...g, uploadsDir: emptyDir };
    expect(await grantIfPaid(missing, d.versionId, 'test')).toEqual({ granted: false, reason: 'file_unavailable' });
    expect(await count(`payments where version_id = $1`, [d.versionId])).toBe(0);
    expect(await count(`receipts where version_id = $1`, [d.versionId])).toBe(0);
    expect((await versionRow(d.versionId)).status).toBe('pending');
    expect((await handleWebhook(missing, hookHeaders(), paidEvent(d.paypalId, d.number), HOOK_ENV)).status).toBe(503);
    expect(await grantIfPaid(g, d.versionId, 'test')).toEqual({ granted: true, already: false });
    expect(await grantIfPaid(g, d.versionId, 'test')).toEqual({ granted: true, already: true });
    expect(await count(`payments where version_id = $1`, [d.versionId])).toBe(1);
    expect(await count(`receipts where version_id = $1`, [d.versionId])).toBe(1);
  });
});

// ---------------------------------------------------------------- F10

describe('F10: the webhook body is bounded before buffering and verified raw', () => {
  const LIMIT = 256 * 1024;
  it('oversized chunked, non-ASCII and unending bodies stop at the limit with no PayPal call', async () => {
    m.reset();
    let pulled = 0;
    const unending = new ReadableStream<Uint8Array>({ pull(c) { pulled++; c.enqueue(new Uint8Array(16 * 1024)); } });
    expect((await webhookPOST(hookReq(unending))).status).toBe(413);
    expect(pulled * 16 * 1024).toBeLessThanOrEqual(LIMIT + 3 * 16 * 1024);
    const chunked = new ReadableStream<Uint8Array>({ start(c) { for (let i = 0; i < 20; i++) c.enqueue(new Uint8Array(16 * 1024)); c.close(); } });
    expect((await webhookPOST(hookReq(chunked))).status).toBe(413);
    // 100k three-byte characters: under the limit in characters, over it in bytes.
    const wide = JSON.stringify({ id: eventId(), event_type: 'X.Y', pad: '€'.repeat(100_000) });
    expect(wide.length).toBeLessThan(LIMIT);
    expect((await webhookPOST(hookReq(wide))).status).toBe(413);
    expect(m.calls).toHaveLength(0);
  });

  it('fix round 2: invalid UTF-8 is refused 400 before any PayPal call', async () => {
    m.reset();
    const bad = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array([0x7b, 0xff, 0xfe, 0x7d])); c.close(); } });
    expect((await webhookPOST(hookReq(bad))).status).toBe(400);
    expect(m.calls).toHaveLength(0);
  });

  it('the REST adapter embeds the exact raw event (whitespace kept) and the webhook id; only SUCCESS verifies', async () => {
    const sent: { path: string; body: unknown }[] = [];
    let reply: Record<string, unknown> = { verification_status: 'SUCCESS' };
    const client = { credentials: () => ({}) as never, api: async (_m: string, path: string, body?: unknown) => { sent.push({ path, body }); return { status: 200, ok: true, json: reply, debugId: null }; } } as PayPalClient;
    const api = restPaymentsApi(client);
    const raw = '{ "id" : "WH-RAW-0001",\n  "event_type":"INVOICING.INVOICE.PAID" , "resource": {"amount": 1.10} }';
    const h = { authAlgo: 'A', certUrl: 'https://api.sandbox.paypal.com/c', transmissionId: 'T', transmissionSig: 'S', transmissionTime: 'now' };
    expect(await api.verifyWebhook(h, raw, 'WH-ID-1234')).toBe('SUCCESS');
    expect(sent[0]!.path).toBe('/v1/notifications/verify-webhook-signature');
    const text = (sent[0]!.body as RawJson).text;
    expect(sent[0]!.body).toBeInstanceOf(RawJson);
    expect(text.endsWith(`"webhook_event":${raw}}`)).toBe(true);
    expect(JSON.parse(text)).toMatchObject({ webhook_id: 'WH-ID-1234', transmission_sig: 'S' });
    for (const r of [{ verification_status: 'FAILURE' }, {}]) {
      reply = r;
      const verdict = await api.verifyWebhook(h, raw, 'WH-ID-1234');
      expect(verdict).not.toBe('SUCCESS');
      const hookG = { ...g, pp: { ...g.pp, payments: { ...m.payments, verifyWebhook: () => api.verifyWebhook(h, raw, 'WH-ID-1234') } } };
      expect((await handleWebhook(hookG, hookHeaders(), paidEvent('INV2-RAW-0001', 'UR-0000000000000000000000'), HOOK_ENV)).status).toBe(400);
    }
  });
});

// ---------------------------------------------------------------- F11

describe('F11: no implicit encryption key', () => {
  it('without APP_SECRET token operations fail and no unusable invoice is sent', async () => {
    expect(() => encryptToken('abc', {} as NodeJS.ProcessEnv)).toThrow(AppSecretError);
    const id = await paste('suggests-price', T.SUGGESTS_PRICE, harborLight);
    const secret = process.env.APP_SECRET;
    delete process.env.APP_SECRET;
    try {
      const r = await runAutopilot(db, m.api, id);
      expect(r).toMatchObject({ action: 'failed' });
      expect(m.count('create')).toBe(0);
      expect(m.count('send')).toBe(0);
      await import('../lib/tokens'); // importing without a secret is fine (build)
    } finally {
      process.env.APP_SECRET = secret;
    }
  });

  it('an explicit secret round-trips; another secret cannot decrypt', () => {
    const a = { APP_SECRET: 'secret-a' } as unknown as NodeJS.ProcessEnv;
    const b = { APP_SECRET: 'secret-b' } as unknown as NodeJS.ProcessEnv;
    const enc = encryptToken('pay-token-123', a);
    expect(decryptToken(enc, a)).toBe('pay-token-123');
    expect(decryptToken(enc, b)).toBeNull();
  });
});

// ---------------------------------------------------------------- F12

describe('F12: licence terms in the creator calendar', () => {
  const iso = (d: Date) => d.toISOString();
  it.each([
    ['Pacific/Auckland', '2026-10-29', 6, '2026-10-28T11:00:00.000Z', '2027-04-28T12:00:00.000Z'],
    ['Pacific/Kiritimati', '2026-10-29', 6, '2026-10-28T10:00:00.000Z', '2027-04-28T10:00:00.000Z'],
    ['America/Los_Angeles', '2026-10-29', 6, '2026-10-29T07:00:00.000Z', '2027-04-29T07:00:00.000Z'],
    ['America/New_York', '2026-08-31', 6, '2026-08-31T04:00:00.000Z', '2027-02-28T05:00:00.000Z'],
    ['America/New_York', '2026-10-31', 1, '2026-10-31T04:00:00.000Z', '2026-11-30T05:00:00.000Z'],
  ])('%s day %s + %i months', (tz, day, months, start, end) => {
    const eff = effectivePayment(tz, { day }, new Date());
    const t = termFromDay(tz, eff.day, months);
    expect([iso(t.start), iso(t.end)]).toEqual([start, end]);
    expect(eff.at.getTime()).toBe(t.start.getTime());
  });

  it('Auckland Oct 29 plus six months ends on local Apr 29', () => {
    const t = termFromDay('Pacific/Auckland', { y: 2026, m: 10, d: 29 }, 6);
    expect(localDay('Pacific/Auckland', t.end)).toEqual({ y: 2027, m: 4, d: 29 });
    // A timestamp is its own local day: 11:30 UTC Oct 29 is Oct 30 in Auckland.
    expect(localDay('Pacific/Auckland', licenceTerm('Pacific/Auckland', new Date('2026-10-29T11:30:00Z'), 6).start)).toEqual({ y: 2026, m: 10, d: 30 });
  });

  it('a grant in Auckland stores one effective date for payment and term; a missing date uses the verification time', async () => {
    await db.query(`update creator_settings set timezone = 'Pacific/Auckland' where creator_id = $1`, [s.creatorId]);
    const d = await demoInvoiced();
    m.pay(d.paypalId);
    await grantIfPaid(g, d.versionId, 'test');
    const v = await versionRow(d.versionId);
    const [p] = await db.query<{ paid_at: Date }>(`select paid_at from payments where version_id = $1`, [d.versionId]);
    expect(iso(v.start_at!)).toBe('2026-10-28T11:00:00.000Z');
    expect(iso(v.end_at!)).toBe('2027-04-28T12:00:00.000Z');
    expect(iso(p!.paid_at)).toBe(iso(v.start_at!));

    await db.query(`update creator_settings set timezone = 'America/New_York' where creator_id = $1`, [s.creatorId]);
    const e = await harborV1();
    m.pay(e.paypalId, { date: null });
    const now = new Date('2026-11-02T15:00:00Z');
    await grantIfPaid({ ...g, now: () => now }, e.versionId, 'test');
    const [pe] = await db.query<{ paid_at: Date }>(`select paid_at from payments where version_id = $1`, [e.versionId]);
    expect(iso(pe!.paid_at)).toBe(iso(now));
    expect(iso((await versionRow(e.versionId)).start_at!)).toBe('2026-11-02T05:00:00.000Z');
    expect(await count(`events where kind = 'grant' and detail->>'versionId' = $1 and detail->>'paymentDateSource' = 'verified_at'`, [e.versionId])).toBe(1);
  });
});

// ---------------------------------------------------------------- F13 + F21 (pure check)

describe('F13 + F21: incomplete or unsupported payment evidence', () => {
  const v = { totalCents: 42000, invoiceNumber: 'UR-0123456789abcdef012345', recipientEmail: 'buying@northwind.example' };
  const tx = (id = '95T72312DE468711M') => ({ payment_id: id, method: 'PAYPAL', payment_date: '2026-10-29', amount: { currency_code: 'USD', value: '420.00' } });
  const paid = (over: Record<string, unknown> = {}): InvoiceJson => ({
    status: 'PAID', detail: { invoice_number: v.invoiceNumber, currency_code: 'USD' },
    primary_recipients: [{ billing_info: { email_address: 'buying@northwind.example' } }],
    due_amount: { currency_code: 'USD', value: '0.00' },
    payments: { paid_amount: { currency_code: 'USD', value: '420.00' }, transactions: [tx()] },
    ...over,
  });
  it('a valid one-capture $420 payment passes', () => {
    expect(checkInvoicePaid(paid(), v)).toMatchObject({ ok: true, txnId: '95T72312DE468711M', amountCents: 42000 });
  });
  it.each([
    ['malformed due amount', paid({ due_amount: { currency_code: 'USD', value: 'abc' } }), 'amount_due'],
    ['due amount in another currency', paid({ due_amount: { currency_code: 'EUR', value: '0.00' } }), 'currency_mismatch'],
    ['missing paid currency', paid({ payments: { paid_amount: { value: '420.00' }, transactions: [tx()] } }), 'currency_mismatch'],
    ['non-USD paid', paid({ payments: { paid_amount: { currency_code: 'CAD', value: '420.00' }, transactions: [tx()] } }), 'currency_mismatch'],
    ['zero transactions', paid({ payments: { paid_amount: { currency_code: 'USD', value: '420.00' }, transactions: [] } }), 'no_transactions'],
    ['empty transaction id', paid({ payments: { paid_amount: { currency_code: 'USD', value: '420.00' }, transactions: [tx('')] } }), 'no_transactions'],
    ['two captures', paid({ payments: { paid_amount: { currency_code: 'USD', value: '420.00' }, transactions: [tx('CAPA0001'), tx('CAPB0002')] } }), 'multiple_transactions'],
    ['transaction in another currency', paid({ payments: { paid_amount: { currency_code: 'USD', value: '420.00' }, transactions: [{ ...tx(), amount: { currency_code: 'EUR', value: '420.00' } }] } }), 'currency_mismatch'],
  ])('%s -> locked (%s)', (_n, inv, reason) => {
    expect(checkInvoicePaid(inv, v)).toEqual({ ok: false, reason });
  });

  it('F21: a missing recipient email or due amount passes when number, status, USD and amount all match', () => {
    expect(checkInvoicePaid(paid({ primary_recipients: undefined }), v)).toMatchObject({ ok: true });
    expect(checkInvoicePaid(paid({ primary_recipients: [{ billing_info: {} }] }), v)).toMatchObject({ ok: true });
    expect(checkInvoicePaid(paid({ due_amount: undefined }), v)).toMatchObject({ ok: true });
    expect(checkInvoicePaid(paid({ primary_recipients: [{ billing_info: { email_address: 'someone@else.example' } }] }), v)).toEqual({ ok: false, reason: 'recipient_mismatch' });
    expect(checkInvoicePaid(paid({ primary_recipients: undefined, payments: { paid_amount: { currency_code: 'USD', value: '419.00' }, transactions: [tx()] } }), v))
      .toEqual({ ok: false, reason: 'amount_mismatch:41900:42000' });
  });

  it('refused multi-capture evidence is visible on the pay page and creates no payment record', async () => {
    const d = await demoInvoiced();
    m.pay(d.paypalId);
    const twice = bend((inv) => {
      const p = inv.payments as { transactions: unknown[] };
      return { ...inv, payments: { ...p, transactions: [...p.transactions, { ...(p.transactions[0] as object), payment_id: 'CAPSECOND0001' }] } };
    });
    expect(await grantIfPaid(twice, d.versionId, 'test')).toEqual({ granted: false, reason: 'multiple_transactions' });
    expect(await count(`payments where version_id = $1`, [d.versionId])).toBe(0);
    expect((await payView(db, d.token))!.refusal).toBe(paymentReasonWords('multiple_transactions'));
  });
});

// ---------------------------------------------------------------- F15

describe('F15: verified payer identity, separate from the recipient', () => {
  it('a distinct payer is stored and both addresses are masked publicly; nothing logs the payer', async () => {
    const logs: unknown[] = [];
    for (const k of ['log', 'warn', 'error', 'info'] as const) vi.spyOn(console, k).mockImplementation((...a: unknown[]) => { logs.push(a); });
    const d = await demoInvoiced();
    m.pay(d.paypalId, { payer: 'payer.person@other.example' });
    await grantIfPaid(g, d.versionId, 'test');
    expect(await db.query(`select payer_email from payments where version_id = $1`, [d.versionId])).toEqual([{ payer_email: 'payer.person@other.example' }]);
    const rid = (await payView(db, d.token))!.receiptPath!.split('/').pop()!;
    const html = renderToString(await ReceiptPage({ params: Promise.resolve({ id: rid }) }));
    expect(html).toContain('p***********@other.example');
    expect(html).toContain('b*****@northwind.example');
    expect(html).not.toContain('payer.person@other.example');
    expect(html).not.toContain('buying@northwind.example');
    expect(JSON.stringify(logs)).not.toContain('payer.person@other.example');
  });

  it('a missing payer stays null and its receipt row is left out (batch 12)', async () => {
    const d = await demoInvoiced();
    m.pay(d.paypalId);
    await grantIfPaid(g, d.versionId, 'test');
    expect(await db.query(`select payer_email from payments where version_id = $1`, [d.versionId])).toEqual([{ payer_email: null }]);
    const rid = (await payView(db, d.token))!.receiptPath!.split('/').pop()!;
    expect((await receiptView(db, rid))!.body.licensee.payerEmail).toBeNull();
    const html = renderToString(await ReceiptPage({ params: Promise.resolve({ id: rid }) }));
    expect(html).not.toContain('PayPal payer');
    expect(html).toContain('Invoice');
  });
});

// ---------------------------------------------------------------- F16

describe('F16: partial-refund alerts are distinct and actionable', () => {
  const partials = (txn: string) => count(`events where kind = 'refund_partial' and detail->>'paypalTxnId' = $1`, [txn]);
  it('repeated identical evidence -> one alert, access kept; new evidence alerts; a full refund still revokes', async () => {
    const d = await paidDemo();
    m.refund(d.txn, false);
    for (let i = 0; i < 3; i++) expect(await handleWebhook(g, hookHeaders(), refundEvent(d.txn, eventId(), 'REFPART0001'), HOOK_ENV)).toMatchObject({ body: { result: 'partial' } });
    await recheck(g, d.versionId, 'creator');
    await recheck(g, d.versionId, 'creator');
    expect(await partials(d.txn)).toBe(1);
    expect((await versionRow(d.versionId)).status).toBe('active');
    const [a] = (await listAlerts(db, s.creatorId)).filter((x) => x.kind === 'refund_partial');
    expect(a!.briefId).toBe(d.briefId);
    expect(a!.message).toContain(d.txn);
    await handleWebhook(g, hookHeaders(), refundEvent(d.txn, eventId(), 'REFPART0002'), HOOK_ENV);
    expect(await partials(d.txn)).toBe(2);
    m.refund(d.txn, true);
    expect(await handleWebhook(g, hookHeaders(), refundEvent(d.txn, eventId(), 'REFFULL0003'), HOOK_ENV)).toMatchObject({ body: { result: 'refunded' } });
    expect((await versionRow(d.versionId)).status).toBe('refunded');
  });

  it('a status-only alert from Re-check is not repeated by the webhook for the same refund', async () => {
    const d = await paidDemo();
    m.refund(d.txn, false);
    await recheck(g, d.versionId, 'creator');
    await handleWebhook(g, hookHeaders(), refundEvent(d.txn, eventId(), 'REFPART0009'), HOOK_ENV);
    await handleWebhook(g, hookHeaders(), refundEvent(d.txn, eventId(), 'REFPART0009'), HOOK_ENV);
    expect(await partials(d.txn)).toBe(1);
  });
});

// ---------------------------------------------------------------- F17 (server side)

describe('F17: copied and emailed links use the configured public origin', () => {
  it('the deal room link and the PayPal invoice note carry the same PUBLIC_BASE_URL link', async () => {
    const d = await demoInvoiced();
    const inv = (await getBriefView(db, d.briefId))!.version!.invoice!;
    expect(inv.payUrl).toBe(`https://useright.example/pay/${d.token}`);
    expect(m.invoices.get(d.paypalId)!.draft.note).toContain(inv.payUrl!);
  });
});

// ---------------------------------------------------------------- F18

describe('F18: access boundaries', () => {
  it('unauthenticated creator Re-check is refused', async () => {
    const d = await demoInvoiced();
    const res = await decidePOST(creatorPost(`/api/briefs/${d.briefId}/decide`, { action: 'recheck' }, false), ctx('id', d.briefId));
    expect(res.status).toBe(401);
  });

  it('foreign-origin public mutations are refused', async () => {
    const d = await paidDemo();
    for (const [fn, path] of [[dlIssuePOST, 'download'], [checkPOST, 'check']] as const) {
      expect((await fn(pub(`/api/pay/${d.token}/${path}`, 'POST', undefined, 'https://evil.example'), ctx('token', d.token))).status).toBe(403);
    }
  });

  it('preview serves only the watermarked bytes, with safe headers; missing files and traversal are refused', async () => {
    const d = await demoInvoiced();
    const res = await previewGET(pub(`/api/pay/${d.token}/preview`), ctx('token', d.token));
    expect(res.status).toBe(200);
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('content-type')).toBe('image/jpeg'); // B9 9.1: Morning Pour's preview comes from its photo
    const bytes = Buffer.from(await res.arrayBuffer());
    const [a] = await db.query<{ key_preview: string; key_web: string; key_print: string; key_original: string }>(`select key_preview, key_web, key_print, key_original from assets where id = $1`, [morningPour]);
    expect(bytes.equals((await readAsset(uploadsDir, a!.key_preview))!)).toBe(true);
    for (const k of [a!.key_web, a!.key_print, a!.key_original]) expect(bytes.equals((await readAsset(uploadsDir, k))!)).toBe(false);
    expect(() => assetPath(uploadsDir, '../secret.png')).toThrow();
    expect(() => assetPath(uploadsDir, 'imani/../../x')).toThrow();
    setRouteDepsForTests({ db, aiFor, invoices: m.api, payments: m.payments, uploadsDir: emptyDir });
    expect((await previewGET(pub(`/api/pay/${d.token}/preview`), ctx('token', d.token))).status).toBe(404);
  });

  it('revocation voids download tokens in the database', async () => {
    const d = await paidDemo();
    const dl = await issueDownload(db, d.token);
    if (!dl.ok) throw new Error(dl.error);
    m.refund(d.txn);
    await handleWebhook(g, hookHeaders(), refundEvent(d.txn), HOOK_ENV);
    expect(await db.query(`select voided_at is not null as voided from download_tokens where version_id = $1`, [d.versionId])).toEqual([{ voided: true }]);
  });

  it('pay, receipt and download responses send no-referrer and leak no private ids', async () => {
    const d = await paidDemo();
    const res = await payGET(pub(`/api/pay/${d.token}`), ctx('token', d.token));
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(receiptMetadata.referrer).toBe('no-referrer');
    const issued = await dlIssuePOST(pub(`/api/pay/${d.token}/download`, 'POST'), ctx('token', d.token));
    expect(issued.headers.get('referrer-policy')).toBe('no-referrer');
    const t = dlToken((await issued.json()).url);
    const file = await downloadGET(pub(`/download/${t}`), ctx('token', t));
    expect(file.headers.get('referrer-policy')).toBe('no-referrer');
    expect(file.headers.get('x-content-type-options')).toBe('nosniff');
    const text = await res.text();
    for (const secret of [d.versionId, s.creatorId, 'imani/morning-pour']) expect(text).not.toContain(secret);
  });
});

// ---------------------------------------------------------------- F19

describe('F19: shared helpers and bounded rate-hit retention', () => {
  it('token, verification and address hashes keep their stored formats', () => {
    expect(hashToken('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(intakeHashToken).toBe(hashToken);
    expect(ipHashOf('198.51.100.7')).toBe(createHash('sha256').update('ip:198.51.100.7').digest('hex'));
  });

  it('pruning removes expired rows and keeps the current window', async () => {
    const ip = ipHashOf('198.51.100.200');
    await db.query(`insert into rate_hits (kind, ip_hash, at) values ('pay_read', $1, now() - interval '2 hours'), ('pay_read', $1, now() - interval '30 minutes')`, [ip]);
    expect(await db.transaction((tx) => rateLimit(tx, 'pay_read', ip, 2))).toBe(true);
    expect(await count(`rate_hits where ip_hash = $1 and at < now() - interval '1 hour'`, [ip])).toBe(0);
    expect(await count(`rate_hits where ip_hash = $1`, [ip])).toBe(2);
    expect(await db.transaction((tx) => rateLimit(tx, 'pay_read', ip, 2))).toBe(false);
  });
});

// ---------------------------------------------------------------- F22

describe('F22: ledger shows PayPal transaction id and amount on grant and revoke', () => {
  it('grant and revoke rows carry txn id, amount and their labels', async () => {
    const d = await paidDemo();
    m.refund(d.txn);
    await handleWebhook(g, hookHeaders(), refundEvent(d.txn), HOOK_ENV);
    const rows = (await listLedger(db, s.creatorId)).filter((r) => r.versionId === d.versionId);
    expect(rows.find((r) => r.kind === 'grant' && r.result === 'pass')).toMatchObject({ label: 'Granted', paypalTxnId: d.txn, amountCents: 42000 });
    expect(rows.find((r) => r.kind === 'revoked')).toMatchObject({ label: 'Revoked', paypalTxnId: d.txn, amountCents: 42000 });
  });
});

// ---------------------------------------------------------------- Fix round 2 (review R1-R4, review fix check of 5a32095)

describe('fix round 2: review R1-R3 (probes turned into tests)', () => {
  it('R1: an older in-flight partial read never overwrites stored reversal evidence; nothing unlocks', async () => {
    const d = await demoInvoiced();
    const txn = m.pay(d.paypalId);
    let release!: () => void;
    let began!: () => void;
    const paused = new Promise<void>((r) => { release = r; });
    const started = new Promise<void>((r) => { began = r; });
    let calls = 0;
    const raced: GrantDeps = { ...g, pp: { ...g.pp, payments: { ...m.payments, getCapture: async () => {
      if (++calls === 1) { began(); await paused; return { id: txn, status: 'PARTIALLY_REFUNDED' }; }
      return { id: txn, status: 'REVERSED' };
    } } } };
    const older = revokeFromCapture(raced, txn, 'webhook');
    await started;
    // review: the read happens under the capture lock, so the second handler cannot even ask PayPal until the first is done.
    const newer = revokeFromCapture(raced, txn, 'webhook');
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toBe(1);
    release();
    await Promise.all([older, newer]);
    expect(calls).toBe(2);
    expect(await db.query(`select status from capture_reversals where capture_id = $1`, [txn])).toEqual([{ status: 'REVERSED' }]);
    expect(await grantIfPaid(g, d.versionId, 'test')).toEqual({ granted: false, reason: 'refunded_before_grant' });
    expect(await count(`receipts where version_id = $1`, [d.versionId])).toBe(0);
    expect(await count(`payments where version_id = $1`, [d.versionId])).toBe(0);
    expect(await issueDownload(db, d.token)).toMatchObject({ ok: false });
  });

  it('R1: a later weaker webhook read does not downgrade REFUNDED either', async () => {
    const d = await demoInvoiced();
    const txn = m.pay(d.paypalId);
    m.refund(txn);
    expect(await handleWebhook(g, hookHeaders(), refundEvent(txn), HOOK_ENV)).toMatchObject({ status: 200, body: { result: 'stored_unmapped' } });
    m.captures.set(txn, { id: txn, status: 'COMPLETED' }); // a stale replica answers
    await handleWebhook(g, hookHeaders(), refundEvent(txn), HOOK_ENV);
    expect(await db.query(`select status from capture_reversals where capture_id = $1`, [txn])).toEqual([{ status: 'REFUNDED' }]);
  });

  it('R2: a token that expires during file preparation is refused and takes no use', async () => {
    const d = await paidDemo();
    const dl = await issueDownload(db, d.token);
    if (!dl.ok) throw new Error(dl.error);
    const start = new Date();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(start);
    try {
      const out = await consumeDownload(db, uploadsDir, dlToken(dl.url), { beforeAuthorize: async () => { vi.setSystemTime(new Date(start.getTime() + 6 * 60 * 1000)); } });
      expect(out).toMatchObject({ ok: false, status: 410 });
    } finally {
      vi.useRealTimers();
    }
    expect(await db.query(`select uses from download_tokens where token_hash = $1`, [hashToken(dlToken(dl.url))])).toEqual([{ uses: 0 }]);
  });

  it('R2: a licence that ends during preparation is refused, for GET and HEAD', async () => {
    const d = await paidDemo();
    const dl = await issueDownload(db, d.token);
    if (!dl.ok) throw new Error(dl.error);
    const start = new Date();
    await db.query(`update licence_versions set end_at = $2 where id = $1`, [d.versionId, new Date(start.getTime() + 2 * 60 * 1000)]);
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      for (const head of [true, false]) {
        vi.setSystemTime(start);
        const out = await consumeDownload(db, uploadsDir, dlToken(dl.url), { head, beforeAuthorize: async () => { vi.setSystemTime(new Date(start.getTime() + 3 * 60 * 1000)); } });
        expect(out).toMatchObject({ ok: false, status: 410 });
      }
    } finally {
      vi.useRealTimers();
    }
    expect(await db.query(`select uses from download_tokens where token_hash = $1`, [hashToken(dlToken(dl.url))])).toEqual([{ uses: 0 }]);
  });

  it('R3: a cascaded revoke row names the payment that bought that version, in the API and the ledger route', async () => {
    const root = await harborV1();
    const rt = m.pay(root.paypalId);
    await grantIfPaid(g, root.versionId, 'test');
    const child = await harborUpgrade();
    const ct = m.pay(child.paypalId);
    await grantIfPaid(g, child.versionId, 'test');
    const childAmount = (await db.query<{ amount_cents: number }>(`select amount_cents from payments where version_id = $1`, [child.versionId]))[0]!.amount_cents;
    await revokeVersion(g, root.versionId, { source: 'test', captureId: rt, captureStatus: 'REFUNDED' });
    const rows = await listLedger(db, s.creatorId);
    expect(rows.find((r) => r.kind === 'revoked' && r.versionId === child.versionId)).toMatchObject({ label: 'Revoked', paypalTxnId: ct, amountCents: childAmount });
    expect(rows.find((r) => r.kind === 'revoked' && r.versionId === root.versionId)).toMatchObject({ paypalTxnId: rt });
    const [ev] = await db.query<{ caused: string }>(`select detail->>'causedByTxnId' as caused from events where kind = 'revoked' and detail->>'versionId' = $1`, [child.versionId]);
    expect(ev!.caused).toBe(rt);
    const res = await ledgerGET(new Request('http://app.test/api/ledger', { headers: { host: 'app.test', cookie: `ur_creator=${TOKEN}` } }));
    const api = ((await res.json()) as { rows: { kind: string; versionId: string; paypalTxnId: string | null }[] }).rows;
    expect(api.find((r) => r.kind === 'revoked' && r.versionId === child.versionId)!.paypalTxnId).toBe(ct);
  });

  it('review B7C-2 finding 1: a cascaded revoke keeps its money; only the refunded head counts as refunded', async () => {
    const root = await harborV1();
    const rt = m.pay(root.paypalId);
    await grantIfPaid(g, root.versionId, 'test');
    const child = await harborUpgrade();
    m.pay(child.paypalId);
    await grantIfPaid(g, child.versionId, 'test');
    await revokeVersion(g, root.versionId, { source: 'test', captureId: rt, captureStatus: 'REFUNDED' });
    const amount = async (v: string) => (await db.query<{ amount_cents: number }>(`select amount_cents from payments where version_id = $1`, [v]))[0]!.amount_cents;
    const [rootCents, childCents] = [await amount(root.versionId), await amount(child.versionId)];
    const paid = (await listPaidVersions(db, s.creatorId)).filter((p) => p.versionId === root.versionId || p.versionId === child.versionId);
    expect(paid.find((p) => p.versionId === root.versionId)).toMatchObject({ refunded: true, revokedKept: false, demo: false });
    expect(paid.find((p) => p.versionId === child.versionId)).toMatchObject({ refunded: false, revokedKept: true, demo: false });
    const t = moneyTotals(paid);
    expect(t.refunded).toEqual({ liveCents: rootCents, liveCount: 1, demoCents: 0, demoCount: 0 });
    expect(t.earned).toEqual({ liveCents: childCents, liveCount: 1, demoCents: 0, demoCount: 0 });
    expect(t.revokedKept).toEqual({ liveCents: childCents, liveCount: 1, demoCents: 0, demoCount: 0 });
    const childRow = (await listLedger(db, s.creatorId)).find((r) => r.kind === 'revoked' && r.versionId === child.versionId)!;
    expect(ledgerSentence(childRow)).toBe('Revoked because an earlier licence it built on was refunded.');
    expect(bellText(childRow)).toBe('Licence revoked: an earlier licence it built on was refunded');
    // review final N3: the UI check (message, isCascadedRevoke) and the money check (causedByTxnId, listPaidVersions)
    // must agree on every revoked row; this fails if lib/grant.ts rewords the cascade message.
    const rootRow = (await listLedger(db, s.creatorId)).find((r) => r.kind === 'revoked' && r.versionId === root.versionId)!;
    expect(isCascadedRevoke(childRow)).toBe(true);
    expect(isCascadedRevoke(rootRow)).toBe(false);
    const kept = new Map((await listPaidVersions(db, s.creatorId)).map((p) => [p.versionId, p.revokedKept]));
    for (const r of (await listLedger(db, s.creatorId)).filter((x) => x.kind === 'revoked' && x.versionId && kept.has(x.versionId))) {
      expect(isCascadedRevoke(r)).toBe(kept.get(r.versionId!));
    }
    // review B7C-2 findings 3 and 8, on live (non-seeded) money: the refunded root keeps its grant receipt for the
    // grant row and gets a revocation receipt for the revoked row.
    const o = await getOverview(db, s.creatorId);
    const kind = async (id: string | undefined) => (await db.query<{ kind: string }>(`select coalesce(body->>'kind', 'grant') as kind from receipts where public_id = $1`, [id ?? '']))[0]?.kind;
    expect(await kind(o.receipts[root.versionId]?.grant)).toBe('grant');
    expect(await kind(o.receipts[root.versionId]?.revocation)).toBe('revocation');
    expect(await kind(o.receipts[child.versionId]?.grant)).toBe('grant');
  });

  it('review final N4: a cascaded version later refunded on its own moves to Refunded, once, through the webhook route', async () => {
    const root = await harborV1();
    const rt = m.pay(root.paypalId);
    await grantIfPaid(g, root.versionId, 'test');
    const child = await harborUpgrade();
    const ct = m.pay(child.paypalId);
    await grantIfPaid(g, child.versionId, 'test');
    const amount = async (v: string) => (await db.query<{ amount_cents: number }>(`select amount_cents from payments where version_id = $1`, [v]))[0]!.amount_cents;
    const [rootCents, childCents] = [await amount(root.versionId), await amount(child.versionId)];
    const mine = async () => (await listPaidVersions(db, s.creatorId)).filter((p) => p.versionId === root.versionId || p.versionId === child.versionId);
    const snapshot = async () => ({
      events: await count(`events where kind = 'revoked' and detail->>'versionId' = $1`, [child.versionId]),
      receipts: await count(`receipts where version_id = $1`, [child.versionId]),
      status: (await versionRow(child.versionId)).status,
    });

    // 1. PayPal refunds v1: v2 is revoked with it but keeps its money.
    m.refund(rt);
    expect((await webhookPOST(hookReq(refundEvent(rt)))).status).toBe(200);
    expect(moneyTotals(await mine())).toMatchObject({
      refunded: { liveCents: rootCents, liveCount: 1 }, earned: { liveCents: childCents, liveCount: 1 }, revokedKept: { liveCents: childCents, liveCount: 1 },
    });
    const afterCascade = await snapshot();
    expect(afterCascade).toEqual({ events: 1, receipts: 2, status: 'refunded' }); // grant + revocation receipt

    // 2. PayPal refunds v2's own payment: one more revoked event, no status change, no new receipt; money moves.
    m.refund(ct);
    const body = refundEvent(ct);
    expect((await webhookPOST(hookReq(body))).status).toBe(200);
    expect(await snapshot()).toEqual({ ...afterCascade, events: 2 });
    expect((await mine()).find((p) => p.versionId === child.versionId)).toMatchObject({ refunded: true, revokedKept: false });
    expect(moneyTotals(await mine())).toMatchObject({
      refunded: { liveCents: rootCents + childCents, liveCount: 2 }, earned: { liveCents: 0, liveCount: 0 }, revokedKept: { liveCents: 0, liveCount: 0 },
    });
    const row = (await listLedger(db, s.creatorId)).find((r) => r.kind === 'revoked' && r.versionId === child.versionId)!;
    expect(row).toMatchObject({ paypalTxnId: ct, amountCents: childCents });
    expect(isCascadedRevoke(row)).toBe(false);
    expect(bellText(row)).toBe('Refunded in PayPal, licence revoked');

    // 3. Replays change nothing: the same delivery, a new delivery for the same capture, and a direct call.
    expect((await (await webhookPOST(hookReq(body))).json())).toMatchObject({ duplicate: true });
    expect((await webhookPOST(hookReq(refundEvent(ct)))).status).toBe(200);
    expect(await revokeVersion(g, child.versionId, { source: 'test', captureId: ct, captureStatus: 'REFUNDED' })).toMatchObject({ revoked: false, reason: 'already_refunded' });
    expect(await snapshot()).toEqual({ ...afterCascade, events: 2 });

    // 4. Replaying v1's refund adds nothing for v2 either (its own refund is already on record).
    expect((await webhookPOST(hookReq(refundEvent(rt)))).status).toBe(200);
    expect(await snapshot()).toEqual({ ...afterCascade, events: 2 });
  });
});

describe('fix round 2: review major 1 (paid quotes that cannot unlock are not stuck; only PAID is paid)', () => {
  it('a paid stale sibling is locked to its capture; INVOICE.REFUNDED or CAPTURE.REFUNDED closes it and is processed', async () => {
    const d1 = await harborV1();
    m.pay(d1.paypalId);
    await grantIfPaid(g, d1.versionId, 'test');
    const a = await harborUpgrade();
    const b = await harborUpgrade();
    const c = await harborUpgrade();
    m.pay(a.paypalId);
    const tb = m.pay(b.paypalId);
    const tc = m.pay(c.paypalId);
    expect((await grantIfPaid(g, a.versionId, 'test')).granted).toBe(true);
    expect(await grantIfPaid(g, b.versionId, 'test')).toEqual({ granted: false, reason: 'stale_version' });
    expect(await grantIfPaid(g, c.versionId, 'test')).toEqual({ granted: false, reason: 'stale_version' });
    expect(await versionRow(b.versionId)).toMatchObject({ status: 'pending', locked_capture_id: tb });

    m.refund(tb);
    const inv = JSON.stringify({ id: eventId(), event_type: 'INVOICING.INVOICE.REFUNDED', resource: { invoice: { id: b.paypalId, detail: { invoice_number: b.number } } } });
    expect(await handleWebhook(g, hookHeaders(), inv, HOOK_ENV)).toMatchObject({ status: 200, body: { result: 'locked_closed' } });
    expect(await count(`webhook_events where event_id = $1 and processed_at is not null`, [JSON.parse(inv).id])).toBe(1);
    expect(await versionRow(b.versionId)).toMatchObject({ status: 'superseded', withdraw_state: 'refunded' });
    expect(await db.query(`select state from invoices where version_id = $1`, [b.versionId])).toEqual([{ state: 'refunded' }]);
    expect((await payView(db, b.token))!.status).toBe('refunded');

    m.refund(tc);
    expect(await handleWebhook(g, hookHeaders(), refundEvent(tc), HOOK_ENV)).toMatchObject({ status: 200, body: { result: 'locked_closed' } });
    expect((await versionRow(c.versionId)).status).toBe('superseded');
    expect((await listLedger(db, s.creatorId)).some((r) => r.kind === 'locked_payment_refunded' && r.versionId === c.versionId && r.paypalTxnId === tc)).toBe(true);
    expect((await versionRow(a.versionId)).status).toBe('active'); // the winner is untouched
  });

  it('creator Re-check closes a locked quote once PayPal shows its payment refunded', async () => {
    const d1 = await harborV1();
    m.pay(d1.paypalId);
    await grantIfPaid(g, d1.versionId, 'test');
    const a = await harborUpgrade();
    const b = await harborUpgrade();
    m.pay(a.paypalId);
    const tb = m.pay(b.paypalId);
    await grantIfPaid(g, a.versionId, 'test');
    await grantIfPaid(g, b.versionId, 'test');
    m.reverse(tb);
    expect(await recheck(g, b.versionId, 'creator')).toMatchObject({ checked: true, outcome: 'revoked' });
    expect((await versionRow(b.versionId)).status).toBe('superseded');
  });

  it('review pre-review: a PAID withdrawn child whose capture cannot be read stays retryable; the retry locks it and its refund closes it', async () => {
    const d1 = await harborV1();
    const t1 = m.pay(d1.paypalId);
    await grantIfPaid(g, d1.versionId, 'test');
    const d2 = await harborUpgrade();
    const t2 = m.pay(d2.paypalId);
    m.refund(t1);
    m.failNext('getInvoice', 500); // the read that would record the child's capture id
    const body = refundEvent(t1);
    expect((await handleWebhook(g, hookHeaders(), body, HOOK_ENV)).status).toBe(503);
    expect(await versionRow(d2.versionId)).toMatchObject({ status: 'pending', withdraw_state: null, locked_capture_id: null });
    expect((await handleWebhook(g, hookHeaders(), body, HOOK_ENV)).status).toBe(200);
    expect(await versionRow(d2.versionId)).toMatchObject({ status: 'pending', withdraw_state: 'paid', locked_capture_id: t2 });
    m.refund(t2);
    expect(await handleWebhook(g, hookHeaders(), refundEvent(t2), HOOK_ENV)).toMatchObject({ status: 200, body: { result: 'locked_closed' } });
    expect(await versionRow(d2.versionId)).toMatchObject({ status: 'superseded', withdraw_state: 'refunded' });
  });

  it('a withdrawn child with PAYMENT_PENDING is retried (503), never recorded as paid', async () => {
    const d1 = await harborV1();
    const t1 = m.pay(d1.paypalId);
    await grantIfPaid(g, d1.versionId, 'test');
    const d2 = await harborUpgrade();
    m.pay(d2.paypalId, { status: 'PAYMENT_PENDING' });
    m.refund(t1);
    expect((await handleWebhook(g, hookHeaders(), refundEvent(t1), HOOK_ENV)).status).toBe(503);
    expect(await versionRow(d2.versionId)).toMatchObject({ status: 'pending', withdraw_state: null });
    expect((await listAlerts(db, s.creatorId)).some((x) => x.kind === 'withdraw_paid' && x.briefId === d2.briefId)).toBe(false);
  });

  it('a withdrawn child MARKED_AS_PAID is not called paid and does not make PayPal redeliver', async () => {
    const d1 = await harborV1();
    const t1 = m.pay(d1.paypalId);
    await grantIfPaid(g, d1.versionId, 'test');
    const d2 = await harborUpgrade();
    m.markPaidManually(d2.paypalId);
    m.refund(t1);
    expect((await handleWebhook(g, hookHeaders(), refundEvent(t1), HOOK_ENV)).status).toBe(200);
    expect(await versionRow(d2.versionId)).toMatchObject({ status: 'pending', withdraw_state: null });
    const alerts = (await listAlerts(db, s.creatorId)).filter((x) => x.briefId === d2.briefId);
    expect(alerts.some((x) => x.kind === 'withdraw_paid')).toBe(false);
    expect(alerts.some((x) => x.kind === 'withdraw_failed' && /marked as paid by hand/.test(x.message))).toBe(true);
  });

  it('creator Cancel and re-quote: PAYMENT_PENDING and MARKED_AS_PAID get their own answers, not "paid"', async () => {
    const a = await demoInvoiced();
    m.pay(a.paypalId, { status: 'PAYMENT_PENDING' });
    expect(await cancelAndRequote(db, m.api, s.creatorId, a.briefId)).toMatchObject({ ok: false, code: 'payment_pending' });
    await db.query(`update licence_versions set status = 'superseded' where id = $1`, [a.versionId]);
    const b = await demoInvoiced();
    m.markPaidManually(b.paypalId);
    expect(await cancelAndRequote(db, m.api, s.creatorId, b.briefId)).toMatchObject({ ok: false, code: 'marked_paid' });
    expect(m.count('cancel')).toBe(0);
  });
});

describe('fix round 2: review minors #3 #4 #6 #11', () => {
  it('#3: children of a root refunded before migration 007 are withdrawn when the refund is seen again', async () => {
    const d1 = await harborV1();
    const t1 = m.pay(d1.paypalId);
    await grantIfPaid(g, d1.versionId, 'test');
    const d2 = await harborUpgrade();
    await db.query(`update licence_versions set status = 'refunded' where id = $1`, [d1.versionId]); // refunded, child never marked
    expect((await versionRow(d2.versionId)).withdrawn_at).toBeNull();
    m.refund(t1);
    expect(await handleWebhook(g, hookHeaders(), refundEvent(t1), HOOK_ENV)).toMatchObject({ status: 200, body: { result: 'already_refunded' } });
    expect(m.invoices.get(d2.paypalId)!.status).toBe('CANCELLED');
    expect(await versionRow(d2.versionId)).toMatchObject({ status: 'superseded', withdraw_state: 'done' });
  });

  it('#4: a withdrawn quote with no brief is cancelled at PayPal by its own invoice before its reservation is released', async () => {
    const d1 = await harborV1();
    const t1 = m.pay(d1.paypalId);
    await grantIfPaid(g, d1.versionId, 'test');
    const d2 = await harborUpgrade();
    await db.query(`update licence_versions set brief_id = null where id = $1`, [d2.versionId]);
    m.refund(t1);
    expect((await handleWebhook(g, hookHeaders(), refundEvent(t1), HOOK_ENV)).status).toBe(200);
    expect(m.invoices.get(d2.paypalId)!.status).toBe('CANCELLED');
    expect(await versionRow(d2.versionId)).toMatchObject({ status: 'superseded', withdraw_state: 'done' });
    expect(await db.query(`select status from autopilot_sends where version_id = $1 and status = 'reserved'`, [d2.versionId])).toEqual([]);
  });

  it('#6: creator Re-check on an already-refunded licence retries the unfinished withdrawal', async () => {
    const d1 = await harborV1();
    const t1 = m.pay(d1.paypalId);
    await grantIfPaid(g, d1.versionId, 'test');
    const d2 = await harborUpgrade();
    m.refund(t1);
    m.failNext('get', 500);
    expect((await handleWebhook(g, hookHeaders(), refundEvent(t1), HOOK_ENV)).status).toBe(503);
    expect((await versionRow(d2.versionId)).withdraw_state).toBeNull();
    expect(await recheck(g, d1.versionId, 'creator')).toEqual({ checked: false, reason: 'nothing_to_check' });
    expect(m.invoices.get(d2.paypalId)!.status).toBe('CANCELLED');
    expect(await versionRow(d2.versionId)).toMatchObject({ status: 'superseded', withdraw_state: 'done' });
  });

  it('#11: a legacy body missing price, scope and version is filled from the licence version', async () => {
    const d = await paidDemo();
    const id = newToken();
    await db.query(`insert into receipts (creator_id, version_id, status, public_id, body) values ($1, $2, 'active', $3, $4)`,
      [s.creatorId, d.versionId, id, JSON.stringify({ licensor: { name: 'Imani' }, licensee: { name: 'Northwind Coffee', email: 'buying@northwind.example' }, asset: { title: 'Morning Pour' } })]);
    const v = (await db.query<{ total_cents: number; version_no: number }>(`select total_cents, version_no from licence_versions where id = $1`, [d.versionId]))[0]!;
    const body = (await receiptView(db, id))!.body;
    expect(body).toMatchObject({ priceCents: v.total_cents, versionNo: v.version_no, scope: { words: 'Social, Print, US, 6 mo' }, asset: { file: 'print' } });
    expect(body.licensee.email).toBe('b*****@northwind.example');
    const html = renderToString(await ReceiptPage({ params: Promise.resolve({ id }) }));
    expect(html).not.toContain('$0.00');
  });
});

describe('round 2 test stability: "latest row" never depends on timestamp ties', () => {
  it('with every created_at equal, the deal reads its newest transcript, extraction, version and invoice (seq order)', async () => {
    const d = await demoInvoiced();
    const at = new Date('2026-10-30T12:00:00Z');
    for (const t of ['transcripts', 'extractions', 'licence_versions']) await db.query(`update ${t} set created_at = $2 where brief_id = $1`, [d.briefId, at]);
    await db.query(`update invoices set created_at = $2 where version_id = $1`, [d.versionId, at]);
    const view = (await getBriefView(db, d.briefId))!;
    expect(view.transcript!.confirmed_at).not.toBeNull(); // the confirmed transcript, written after the draft
    expect(view.version!.id).toBe(d.versionId);
    expect(view.version!.invoice!.paypalInvoiceId).toBe(d.paypalId);
    expect(view.status).toBe('invoiced');
    // The editBrief that flaked: it reads the latest transcript and must see it confirmed.
    m.pay(d.paypalId);
    expect((await grantIfPaid(g, d.versionId, 'test')).granted).toBe(true);
    const kept = view.checks!.kept.map((k) => ({ optionId: k.optionId, quote: k.quote }));
    expect((await (await import('../lib/briefs')).editBrief(db, s.creatorId, d.briefId, { uses: kept })).ok).toBe(true);
  });
});

describe('review final (5bae423 check new #1): a quote paid then refunded before any grant attempt is closed', () => {
  it('a stale paid sibling, never grant-checked, is refunded: INVOICE.REFUNDED closes it', async () => {
    const d1 = await harborV1();
    m.pay(d1.paypalId);
    await grantIfPaid(g, d1.versionId, 'test');
    const a = await harborUpgrade();
    const b = await harborUpgrade();
    m.pay(a.paypalId);
    expect((await grantIfPaid(g, a.versionId, 'test')).granted).toBe(true);
    const tb = m.pay(b.paypalId); // INVOICE.PAID for b is missed: no grant attempt, no locked capture
    m.refund(tb);
    const inv = JSON.stringify({ id: eventId(), event_type: 'INVOICING.INVOICE.REFUNDED', resource: { invoice: { id: b.paypalId, detail: { invoice_number: b.number } } } });
    expect(await handleWebhook(g, hookHeaders(), inv, HOOK_ENV)).toMatchObject({ status: 200, body: { result: 'locked_closed' } });
    expect(await versionRow(b.versionId)).toMatchObject({ status: 'superseded', withdraw_state: 'refunded', locked_capture_id: tb });
    expect((await versionRow(a.versionId)).status).toBe('active');
  });

  it('creator Re-check on such a quote closes it too (no webhook)', async () => {
    const d1 = await harborV1();
    m.pay(d1.paypalId);
    await grantIfPaid(g, d1.versionId, 'test');
    const a = await harborUpgrade();
    const b = await harborUpgrade();
    m.pay(a.paypalId);
    await grantIfPaid(g, a.versionId, 'test');
    m.refund(m.pay(b.paypalId));
    expect(await recheck(g, b.versionId, 'creator')).toMatchObject({ checked: true, outcome: 'revoked' });
    expect(await versionRow(b.versionId)).toMatchObject({ status: 'superseded', withdraw_state: 'refunded' });
  });

  it('a withdrawn child whose invoice PayPal shows REFUNDED is closed locally, never sent a cancel (no 503 loop)', async () => {
    const d1 = await harborV1();
    const t1 = m.pay(d1.paypalId);
    await grantIfPaid(g, d1.versionId, 'test');
    const d2 = await harborUpgrade();
    m.refund(m.pay(d2.paypalId)); // child paid and refunded, never granted
    m.refund(t1);
    m.failNext('cancel', 422, 'INVALID_INVOICE_STATUS'); // what PayPal would answer to cancelling a refunded invoice
    expect((await handleWebhook(g, hookHeaders(), refundEvent(t1), HOOK_ENV)).status).toBe(200);
    expect(m.count('cancel')).toBe(0);
    expect(await versionRow(d2.versionId)).toMatchObject({ status: 'superseded', withdraw_state: 'done' });
    expect(await db.query(`select state from invoices where version_id = $1`, [d2.versionId])).toEqual([{ state: 'refunded' }]);
  });

  it('creator Cancel and re-quote on a REFUNDED invoice closes it locally', async () => {
    const d = await demoInvoiced();
    m.refund(m.pay(d.paypalId));
    await db.query(`update licence_versions set status = 'superseded' where id = $1`, [s.v1Id]); // make it a stale quote
    expect(await cancelAndRequote(db, m.api, s.creatorId, d.briefId)).toEqual({ ok: true });
    expect(m.count('cancel')).toBe(0);
    expect((await versionRow(d.versionId)).status).toBe('superseded');
    expect((await payView(db, d.token))!.status).toBe('refunded');
  });
});

describe('review final (5bae423 check new #2): real-Postgres tests refuse to touch public tables', () => {
  it('refuses the transaction pooler port and a connection whose current_schema() is not the test schema', async () => {
    const { assertTestSchema, refusePooler } = await import('./helpers/pg-guard');
    expect(() => refusePooler('postgres://u:p@db.example.supabase.co:6543/postgres')).toThrow(/6543/);
    expect(() => refusePooler('postgres://u:p@db.example.supabase.co:5432/postgres')).not.toThrow();
    let calls = 0;
    const fake = (schemas: string[]) => ({
      transaction: async <T>(fn: (tx: { query: () => Promise<{ s: string }[]> }) => Promise<T>) => fn({ query: async () => [{ s: schemas[calls++ % schemas.length]! }] }),
    }) as unknown as Db;
    await expect(assertTestSchema(fake(['ur_b6_races', 'public']), 'ur_b6_races', 4)).rejects.toThrow(/refusing to run/);
    calls = 0;
    await expect(assertTestSchema(fake(['ur_b6_races']), 'ur_b6_races', 4)).resolves.toBeUndefined();
  });
});

describe('fix round 2: F18 page response headers (next.config)', () => {
  it('pay, receipt and download pages get no-referrer and noindex headers from the server config', async () => {
    const { default: config } = await import('../next.config');
    const rules = await config.headers!();
    for (const path of ['/pay/:path*', '/r/:path*', '/download/:path*', '/api/pay/:path*']) {
      const rule = rules.find((r) => r.source === path);
      expect(rule?.headers).toEqual(expect.arrayContaining([{ key: 'Referrer-Policy', value: 'no-referrer' }, { key: 'X-Robots-Tag', value: 'noindex' }]));
    }
  });

  it('the preview response sends nosniff (review #17)', async () => {
    const d = await demoInvoiced();
    const res = await previewGET(pub(`/api/pay/${d.token}/preview`), ctx('token', d.token));
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });
});

// ---------------------------------------------------------------- F9 (last: revokes the seeded v1)

describe('F9: seeded and legacy receipts', () => {
  it('a legacy body is normalized: valid amount, file, scope, version, masked email', () => {
    const legacy = {
      licensor: { name: 'Imani', slug: 'imani' },
      licensee: { name: 'Northwind Coffee', email: 'buying@northwind.example', paypalPayer: 'buying@northwind.example' },
      asset: { id: '00000000-0000-0000-0000-000000000000', title: 'Morning Pour', fileHash: 'abc123' },
      scope: { channels: ['social'], territory: 'US', durationMonths: 6, exclusive: false },
      startAt: '2026-10-28T12:00:00.000Z', endAt: '2027-04-28T12:00:00.000Z', renewalDate: '2027-04-28T12:00:00.000Z',
      price: { lines: [], totalCents: 30000, currency: 'USD' }, paypalTransactionId: 'SEED-V1', version: 1, parentId: null, status: 'active',
      files: { web: 'delivered', print: 'locked' },
    };
    const b = normalizeReceiptBody(legacy, new Date('2026-10-28T12:00:00Z'));
    expect(b).toMatchObject({ kind: 'grant', priceCents: 30000, versionNo: 1, asset: { file: 'web', fileLabel: 'Web file', sha256: 'abc123' }, scope: { words: 'Social, US, 6 mo' } });
    expect(b.licensee).toEqual({ name: 'Northwind Coffee', email: 'b*****@northwind.example', payerEmail: 'b*****@northwind.example' });
    expect(JSON.stringify(b)).not.toContain('00000000-0000');
  });

  it('the seeded receipt renders cleanly; revoking the seeded version issues a distinct revocation and shows refunded', async () => {
    const [r] = await db.query<{ public_id: string; sha: string }>(`select public_id, body->'asset'->>'sha256' as sha from receipts where version_id = $1 order by seq limit 1`, [s.v1Id]);
    expect(r!.public_id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const [a] = await db.query<{ key_web: string }>(`select key_web from assets where id = $1`, [morningPour]);
    expect(r!.sha).toBe(sha256Bytes((await readAsset(uploadsDir, a!.key_web))!));
    const html = renderToString(await ReceiptPage({ params: Promise.resolve({ id: r!.public_id }) }));
    expect(html).not.toContain('NaN');
    expect(html).not.toContain('buying@northwind.example');
    for (const want of ['$300.00', 'Web file', 'Social, US, 6 mo', 'b*****@northwind.example']) expect(html).toContain(want);
    expect(html).toMatch(/v(<!-- -->)?1/);

    expect(await revokeVersion(g, s.v1Id, { source: 'test', captureStatus: 'REFUNDED' })).toMatchObject({ revoked: true });
    const rows = await db.query<{ public_id: string; status: string; kind: string }>(`select public_id, status, body->>'kind' as kind from receipts where version_id = $1 order by seq`, [s.v1Id]);
    expect(rows.map((x) => [x.status, x.kind])).toEqual([['active', 'grant'], ['refunded', 'revocation']]);
    expect(rows[1]!.public_id).not.toBe(rows[0]!.public_id);
    expect((await receiptView(db, r!.public_id))!.liveStatus).toBe('refunded');
    const rev = renderToString(await ReceiptPage({ params: Promise.resolve({ id: rows[1]!.public_id }) }));
    expect(rev).toContain('Revocation receipt');
    expect(rev).not.toContain('NaN');
  });
});
