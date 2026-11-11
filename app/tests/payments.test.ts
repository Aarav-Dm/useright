// Batch 6 (docs/batch-6.md §7 + §8 fixes): grantIfPaid, webhooks, pay page, downloads, receipts, revocation.
// PayPal is the in-memory mock; routes are called through their real handlers.
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderToString } from 'react-dom/server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { POST as decidePOST } from '@/app/api/briefs/[id]/decide/route';
import { GET as payGET } from '@/app/api/pay/[token]/route';
import { POST as checkPOST } from '@/app/api/pay/[token]/check/route';
import { POST as dlIssuePOST } from '@/app/api/pay/[token]/download/route';
import { POST as webhookPOST } from '@/app/api/paypal/webhook/route';
import { GET as downloadGET, HEAD as downloadHEAD } from '@/app/download/[token]/route';
import ReceiptPage from '@/app/r/[id]/page';
import { openPglite, type Db } from '../db/client';
import { migrate } from '../db/migrate';
import { seed, type SeedResult } from '../db/seed';
import { createAdapter, fixtureProvider } from '../lib/ai/extract';
import { confirmTranscript, editBrief, getBriefView, type AiFor } from '../lib/briefs';
import { checkInvoicePaid, grantIfPaid, licenceTerm, paymentReasonWords, recheck, type GrantDeps } from '../lib/grant';
import { intake, type IntakeDeps } from '../lib/intake';
import { listAlerts } from '../lib/ledger';
import { consumeDownload, issueDownload, PAY_LIMITS, payView } from '../lib/pay';
import { ensureAssetFiles, originalPhotoPath } from '../lib/placeholder-files';
import { manifestPhotoFor } from '../lib/portfolio';
import { ipHashOf } from '../lib/rate-limit';
import { receiptView } from '../lib/receipts';
import { cancelAndRequote, runAutopilot } from '../lib/send';
import { setRouteDepsForTests } from '../lib/server';
import { readAsset } from '../lib/storage';
import { decryptToken, encryptToken } from '../lib/tokens';
import { captureIdOf, handleWebhook } from '../lib/webhooks';
import * as T from './fixtures/texts';
import { mockInvoiceApi } from './helpers/mock-paypal';

let db: Db;
let s: SeedResult;
let deps: IntakeDeps;
let uploadsDir: string;
let morningPour: string;
let harborLight: string;
let m: ReturnType<typeof mockInvoiceApi>;
let g: GrantDeps;
const aiFor: AiFor = (fixture) => createAdapter(fixtureProvider(fixture ?? 'paste'));
const creator = { creator: true, sessionSlug: 'imani' };
const TOKEN = 'b6-creator-token';
const HOOK_ENV = { PAYPAL_WEBHOOK_ID: 'WH-TEST-0001' } as unknown as NodeJS.ProcessEnv;
const saved = { token: process.env.CREATOR_TOKEN, hook: process.env.PAYPAL_WEBHOOK_ID, origin: process.env.APP_ORIGIN };
let ipSeq = 0;
let evSeq = 0;

const ctx = <K extends string>(k: K, v: string) => ({ params: Promise.resolve({ [k]: v } as Record<K, string>) });
const pub = (path: string, method = 'GET', ip = `198.51.100.${++ipSeq % 250}`) =>
  new Request(`http://app.test${path}`, { method, headers: { host: 'app.test', origin: 'http://app.test', 'x-forwarded-for': ip } });
const creatorPost = (path: string, body: unknown) =>
  new Request(`http://app.test${path}`, { method: 'POST', body: JSON.stringify(body), headers: { host: 'app.test', origin: 'http://app.test', cookie: `ur_creator=${TOKEN}`, 'content-type': 'application/json' } });
const hookHeaders = (sig = 'good') => new Headers({
  'paypal-auth-algo': 'SHA256withRSA', 'paypal-cert-url': 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1',
  'paypal-transmission-id': `t-${++evSeq}`, 'paypal-transmission-sig': sig, 'paypal-transmission-time': new Date().toISOString(),
});
const eventId = () => `WH-TEST-${String(++evSeq).padStart(6, '0')}`;
const paidEvent = (invoiceId: string, number: string, id = eventId()) => JSON.stringify({ id, event_type: 'INVOICING.INVOICE.PAID', resource: { invoice: { id: invoiceId, detail: { invoice_number: number } } } });
const refundEvent = (captureId: string, id = eventId()) => JSON.stringify({ id, event_type: 'PAYMENT.CAPTURE.REFUNDED', resource: { id: 'REF123456', status: 'COMPLETED', links: [{ rel: 'up', href: `https://api.sandbox.paypal.com/v2/payments/captures/${captureId}` }] } });

async function paste(fixture: string, text: string, assetId: string) {
  const r = await intake(deps, { source: 'paste', clientId: s.clientId, assetId, text, fixture }, creator);
  if (!r.ok) throw new Error(r.error);
  return r.briefId;
}
/** The $420 demo deal, invoiced on autopilot. */
async function demoInvoiced() {
  const png = await readFile(join(import.meta.dirname, 'fixtures', 'demo-dm.png'));
  const r = await intake(deps, { source: 'screenshot', clientId: s.clientId, assetId: morningPour, fixture: 'demo-dm', image: { mime: 'image/png', base64: png.toString('base64') } }, creator);
  if (!r.ok) throw new Error(r.error);
  await confirmTranscript(db, aiFor, r.briefId, T.DEMO_DM);
  expect(await runAutopilot(db, m.api, r.briefId)).toMatchObject({ action: 'sent' });
  return deal(r.briefId);
}
async function deal(briefId: string) {
  const v = (await getBriefView(db, briefId))!.version!;
  const token = v.invoice!.payPath!.split('/').pop()!;
  return { briefId, versionId: v.id, paypalId: v.invoice!.paypalInvoiceId!, number: v.invoice!.invoiceNumber, token };
}
const versionRow = (id: string) => db.query<{ status: string; paid_cents: number; start_at: Date | null; end_at: Date | null }>(
  `select status, paid_cents, start_at, end_at from licence_versions where id = $1`, [id]).then((r) => r[0]!);
const count = async (sql: string, params: unknown[]) => (await db.query<{ n: number }>(`select count(*)::int as n from ${sql}`, params))[0]!.n;

beforeAll(async () => {
  db = await openPglite();
  await migrate(db);
  s = await seed(db);
  [morningPour, harborLight] = s.assetIds as [string, string];
  uploadsDir = await mkdtemp(join(tmpdir(), 'ur-b6-'));
  await ensureAssetFiles(db, uploadsDir);
  deps = { db, aiFor, uploadsDir, env: { AI_PROVIDER: 'fixture', NODE_ENV: 'test' } as unknown as NodeJS.ProcessEnv };
  process.env.CREATOR_TOKEN = TOKEN;
  process.env.PAYPAL_WEBHOOK_ID = 'WH-TEST-0001';
  delete process.env.APP_ORIGIN;
});
afterAll(async () => {
  setRouteDepsForTests(null);
  for (const [k, v] of [['CREATOR_TOKEN', saved.token], ['PAYPAL_WEBHOOK_ID', saved.hook], ['APP_ORIGIN', saved.origin]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await db?.close();
  if (uploadsDir) await rm(uploadsDir, { recursive: true, force: true });
});
beforeEach(async () => {
  m = mockInvoiceApi();
  g = { db, pp: m.pp, uploadsDir };
  setRouteDepsForTests({ db, aiFor, invoices: m.api, payments: m.payments, uploadsDir });
  await db.query(`update autopilot_sends set status = 'released' where status in ('reserved', 'sent')`);
  await db.query(`update creator_settings set per_deal_cap_cents = 50000, daily_max_sends = 50, rolling30_cap_cents = 10000000 where creator_id = $1`, [s.creatorId]);
  // Each test starts from the seed's v1 licences being the active ones.
  await db.query(`update licence_versions set status = 'superseded' where status = 'active' and id <> $1`, [s.v1Id]);
  await db.query(`update licence_versions set status = 'active' where id = $1`, [s.v1Id]);
  await db.query(`delete from rate_hits`);
});
afterEach(() => setRouteDepsForTests(null));

// ---------------------------------------------------------------- checkInvoicePaid (fix 3)

describe('checkInvoicePaid (pure, fix 3)', () => {
  const v = { totalCents: 42000, invoiceNumber: 'UR-0123456789abcdef012345', recipientEmail: 'buying@northwind.example' };
  const paid = (over: Record<string, unknown> = {}) => ({
    status: 'PAID', detail: { invoice_number: v.invoiceNumber, currency_code: 'USD' },
    primary_recipients: [{ billing_info: { email_address: 'Buying@Northwind.example' } }],
    due_amount: { currency_code: 'USD', value: '0.00' },
    payments: { paid_amount: { currency_code: 'USD', value: '420.00' }, transactions: [{ payment_id: '95T72312DE468711M', method: 'PAYPAL', payment_date: '2026-10-29' }] },
    ...over,
  });
  it('PAID, $420.00 USD, number + recipient match, one PAYPAL transaction -> ok with the capture id', () => {
    expect(checkInvoicePaid(paid(), v)).toMatchObject({ ok: true, txnId: '95T72312DE468711M', amountCents: 42000 });
  });
  it.each([
    ['wrong amount', paid({ payments: { paid_amount: { currency_code: 'USD', value: '419.99' }, transactions: [{ payment_id: 'X1', method: 'PAYPAL' }] } }), 'amount_mismatch:41999:42000'],
    ['wrong currency', paid({ detail: { invoice_number: v.invoiceNumber, currency_code: 'EUR' } }), 'currency_mismatch'],
    ['wrong invoice_number', paid({ detail: { invoice_number: 'UR-ffffffffffffffffffffff', currency_code: 'USD' } }), 'invoice_number_mismatch'],
    ['other recipient', paid({ primary_recipients: [{ billing_info: { email_address: 'someone@else.example' } }] }), 'recipient_mismatch'],
    ['amount still due', paid({ due_amount: { currency_code: 'USD', value: '20.00' } }), 'amount_due'],
    ['PARTIALLY_PAID', paid({ status: 'PARTIALLY_PAID' }), 'partial'],
    ['PAYMENT_PENDING', paid({ status: 'PAYMENT_PENDING' }), 'pending'],
    ['MARKED_AS_PAID', paid({ status: 'MARKED_AS_PAID' }), 'marked_paid'],
    ['external record', paid({ payments: { paid_amount: { currency_code: 'USD', value: '420.00' }, transactions: [{ payment_id: 'X2', method: 'CASH' }] } }), 'external_record'],
    ['no transactions', paid({ payments: { paid_amount: { currency_code: 'USD', value: '420.00' }, transactions: [] } }), 'no_transactions'],
    ['SENT', paid({ status: 'SENT' }), 'not_paid:SENT'],
  ])('%s -> no grant (%s)', (_n, inv, reason) => {
    expect(checkInvoicePaid(inv, v)).toEqual({ ok: false, reason });
  });
  it('licence term: payment-day midnight in the creator timezone, + duration', () => {
    const t = licenceTerm('America/New_York', new Date('2026-10-29T12:00:00Z'), 6);
    expect(t.start.toISOString()).toBe('2026-10-29T04:00:00.000Z');
    expect(t.end.toISOString()).toBe('2027-04-29T04:00:00.000Z');
  });
});

// ---------------------------------------------------------------- grant

describe('grantIfPaid', () => {
  it('fix 1: one transaction commits activation, payment, parent superseded, invoice paid and receipt (fix 2: paid_cents)', async () => {
    const d = await demoInvoiced();
    const txn = m.pay(d.paypalId);
    expect(await grantIfPaid(g, d.versionId, 'test')).toEqual({ granted: true, already: false });
    const v = await versionRow(d.versionId);
    const v1 = await versionRow(s.v1Id);
    expect(v.status).toBe('active');
    expect(v.paid_cents).toBe(v1.paid_cents + 42000);
    expect(v.start_at!.toISOString()).toBe('2026-10-29T04:00:00.000Z');
    expect(v.end_at!.toISOString()).toBe('2027-04-29T04:00:00.000Z');
    expect(v1.status).toBe('superseded');
    expect(await db.query(`select paypal_txn_id, amount_cents, currency from payments where version_id = $1`, [d.versionId])).toEqual([{ paypal_txn_id: txn, amount_cents: 42000, currency: 'USD' }]);
    expect(await db.query(`select state from invoices where paypal_invoice_id = $1`, [d.paypalId])).toEqual([{ state: 'paid' }]);
    expect(await count(`receipts where version_id = $1`, [d.versionId])).toBe(1);
    expect((await getBriefView(db, d.briefId))!.status).toBe('paid');
    // grant twice -> one payment row, no PayPal call
    m.reset();
    expect(await grantIfPaid(g, d.versionId, 'test')).toEqual({ granted: true, already: true });
    expect(m.calls).toHaveLength(0);
    expect(await count(`payments where version_id = $1`, [d.versionId])).toBe(1);
  });

  it('a failure inside the grant transaction rolls back every write', async () => {
    const d = await demoInvoiced();
    m.pay(d.paypalId);
    await db.query(`alter table receipts add constraint t_fail check (false) not valid`);
    try {
      await expect(grantIfPaid(g, d.versionId, 'test')).rejects.toThrow();
    } finally {
      await db.query(`alter table receipts drop constraint t_fail`);
    }
    expect((await versionRow(d.versionId)).status).toBe('pending');
    expect(await count(`payments where version_id = $1`, [d.versionId])).toBe(0);
    expect((await versionRow(s.v1Id)).status).toBe('active');
  });

  it('spec §8: an invoice marked paid by hand -> file stays locked, with the reason in plain words', async () => {
    const d = await demoInvoiced();
    m.markPaidManually(d.paypalId);
    expect(await grantIfPaid(g, d.versionId, 'test')).toEqual({ granted: false, reason: 'marked_paid' });
    expect((await versionRow(d.versionId)).status).toBe('pending');
    const view = (await payView(db, d.token))!;
    expect(view).toMatchObject({ status: 'unpaid', refusal: paymentReasonWords('marked_paid') });
    expect(await issueDownload(db, d.token)).toMatchObject({ ok: false, status: 409 });
  });

  it('spec §8: a PayPal error -> no grant, event logged', async () => {
    const d = await demoInvoiced();
    m.pay(d.paypalId);
    m.failNext('getInvoice', 500);
    expect(await grantIfPaid(g, d.versionId, 'test')).toEqual({ granted: false, reason: 'paypal_unavailable' });
    expect((await versionRow(d.versionId)).status).toBe('pending');
    expect((await payView(db, d.token))!.refusal).toBe(paymentReasonWords('paypal_unavailable'));
  });

  it('PARTIALLY_PAID and PAYMENT_PENDING -> no grant', async () => {
    const a = await demoInvoiced();
    m.pay(a.paypalId, { status: 'PARTIALLY_PAID', value: '100.00', due: '320.00' });
    expect(await grantIfPaid(g, a.versionId, 'test')).toEqual({ granted: false, reason: 'partial' });
    await cancelAndRequote(db, m.api, s.creatorId, a.briefId).catch(() => {});
    const b = await demoInvoiced();
    m.pay(b.paypalId, { status: 'PAYMENT_PENDING' });
    expect(await grantIfPaid(g, b.versionId, 'test')).toEqual({ granted: false, reason: 'pending' });
  });

  it('fix 4: PAID on a version that is no longer pending -> no grant, paid_on_stale_version shown in Ask me', async () => {
    const d = await demoInvoiced();
    await db.query(`update licence_versions set status = 'superseded' where id = $1`, [d.versionId]);
    m.pay(d.paypalId);
    expect(await grantIfPaid(g, d.versionId, 'test')).toEqual({ granted: false, reason: 'stale_version' });
    expect((await versionRow(s.v1Id)).status).toBe('active');
    expect((await listAlerts(db, s.creatorId)).find((a) => a.briefId === d.briefId)).toMatchObject({ kind: 'paid_on_stale_version' });
  });

  it('fix 4: Cancel invoice and re-quote re-fetches and refuses a paid invoice', async () => {
    const d = await demoInvoiced();
    m.pay(d.paypalId);
    expect(await cancelAndRequote(db, m.api, s.creatorId, d.briefId)).toMatchObject({ ok: false, status: 409, code: 'already_paid' });
    expect(m.count('cancel')).toBe(0);
  });

  it('fix 21: a PayPal transaction already recorded for another version -> no grant, txn_replay', async () => {
    const d = await demoInvoiced();
    const txn = m.pay(d.paypalId);
    await db.query(`insert into payments (creator_id, version_id, paypal_txn_id, amount_cents, currency) values ($1, $2, $3, 42000, 'USD')`, [s.creatorId, s.v1Id, txn]);
    expect(await grantIfPaid(g, d.versionId, 'test')).toEqual({ granted: false, reason: 'txn_replay' });
    await db.query(`delete from payments where paypal_txn_id = $1`, [txn]);
  });

  it('fix 21: the grant GETs by the stored PayPal id only (no search by number)', async () => {
    const d = await demoInvoiced();
    m.pay(d.paypalId);
    m.reset();
    await grantIfPaid(g, d.versionId, 'test');
    expect(m.calls.map((c) => [c.op, c.arg])).toEqual([['getInvoice', d.paypalId]]);
  });

  it('fix 2: grant v1, quote v2 -> the credit line is what v1 paid', async () => {
    const v1Brief = await paste('suggests-price', T.SUGGESTS_PRICE, harborLight); // web, US, 6mo: no licence yet
    expect(await runAutopilot(db, m.api, v1Brief)).toMatchObject({ action: 'sent' });
    const d1 = await deal(v1Brief);
    m.pay(d1.paypalId);
    expect((await grantIfPaid(g, d1.versionId, 'test')).granted).toBe(true);
    const paid1 = (await versionRow(d1.versionId)).paid_cents;
    const v2Brief = await paste('paste', T.PASTE, harborLight); // social for Harbor Light: a v2 on top of v1
    const view = (await getBriefView(db, v2Brief))!;
    expect(view.licence).toMatchObject({ versionNo: 1, paidCents: paid1 });
    expect(view.gapPreview!.lines.find((l) => l.optionId === 'credit:paid')!.cents).toBe(-paid1);
  });
});

// ---------------------------------------------------------------- webhooks (§2, fixes 5, 8, 23)

describe('webhook', () => {
  it('verified PAID event -> grant; duplicate event id -> 200, one grant', async () => {
    const d = await demoInvoiced();
    m.pay(d.paypalId);
    const body = paidEvent(d.paypalId, d.number);
    expect(await handleWebhook(g, hookHeaders(), body, HOOK_ENV)).toMatchObject({ status: 200, body: { result: 'granted' } });
    expect(await handleWebhook(g, hookHeaders(), body, HOOK_ENV)).toMatchObject({ status: 200, body: { duplicate: true } });
    expect(await count(`payments where version_id = $1`, [d.versionId])).toBe(1);
    expect(await count(`receipts where version_id = $1`, [d.versionId])).toBe(1);
  });

  it('bad signature -> 400, nothing stored, no grant', async () => {
    const d = await demoInvoiced();
    m.pay(d.paypalId);
    const body = paidEvent(d.paypalId, d.number);
    expect(await handleWebhook(g, hookHeaders('bad'), body, HOOK_ENV)).toMatchObject({ status: 400 });
    expect(await count(`webhook_events where event_id = $1`, [JSON.parse(body).id])).toBe(0);
    expect((await versionRow(d.versionId)).status).toBe('pending');
  });

  it('fix 8: missing transmission headers -> 400 with no PayPal call; verify 5xx or timeout -> 503; no webhook id -> 503', async () => {
    m.reset();
    expect(await handleWebhook(g, new Headers(), paidEvent('INV2-X', 'UR-x'), HOOK_ENV)).toMatchObject({ status: 400 });
    expect(m.calls).toHaveLength(0);
    m.failNext('verifyWebhook', 503);
    expect(await handleWebhook(g, hookHeaders(), paidEvent('INV2-X', 'UR-x'), HOOK_ENV)).toMatchObject({ status: 503 });
    m.failNext('verifyWebhook', 'timeout');
    expect(await handleWebhook(g, hookHeaders(), paidEvent('INV2-X', 'UR-x'), HOOK_ENV)).toMatchObject({ status: 503 });
    expect(await handleWebhook(g, hookHeaders(), paidEvent('INV2-X', 'UR-x'), {} as NodeJS.ProcessEnv)).toMatchObject({ status: 503 });
  });

  it('fix 8 + F2: a stored event that failed (PayPal down) answers 503 and is processed when PayPal resends it', async () => {
    const d = await demoInvoiced();
    m.pay(d.paypalId);
    const body = paidEvent(d.paypalId, d.number);
    m.failNext('getInvoice', 500);
    expect(await handleWebhook(g, hookHeaders(), body, HOOK_ENV)).toMatchObject({ status: 503 });
    const [row] = await db.query<{ processed_at: Date | null; error: string | null }>(`select processed_at, error from webhook_events where event_id = $1`, [JSON.parse(body).id]);
    expect(row).toMatchObject({ processed_at: null, error: 'paypal_unavailable' });
    expect(await handleWebhook(g, hookHeaders(), body, HOOK_ENV)).toMatchObject({ status: 200, body: { result: 'granted' } });
  });

  it('fix 23: the raw body is what gets verified (route reads text, not parsed JSON)', async () => {
    const d = await demoInvoiced();
    m.pay(d.paypalId);
    const body = paidEvent(d.paypalId, d.number);
    const res = await webhookPOST(new Request('http://app.test/api/paypal/webhook', { method: 'POST', body, headers: hookHeaders() }));
    expect(res.status).toBe(200);
    expect((await versionRow(d.versionId)).status).toBe('active');
  });

  it('fix 5: an unmapped capture -> webhook_events.error = unmapped, nothing changes', async () => {
    const body = refundEvent('NOSUCHCAPTURE1');
    expect(await handleWebhook(g, hookHeaders(), body, HOOK_ENV)).toMatchObject({ status: 200 });
    expect(await db.query(`select error from webhook_events where event_id = $1`, [JSON.parse(body).id])).toEqual([{ error: 'unmapped' }]);
  });

  it('fix 5: capture ids: refund -> links[rel=up], reversal -> resource.id', () => {
    expect(captureIdOf('PAYMENT.CAPTURE.REFUNDED', JSON.parse(refundEvent('ABC123')).resource)).toBe('ABC123');
    expect(captureIdOf('PAYMENT.CAPTURE.REVERSED', { id: 'REV999' })).toBe('REV999');
  });

  it('INVOICING.INVOICE.CANCELLED -> re-fetched; invoice cancelled, R3 released, deal shows cancelled', async () => {
    const d = await demoInvoiced();
    await m.api.cancel(d.paypalId);
    const body = JSON.stringify({ id: eventId(), event_type: 'INVOICING.INVOICE.CANCELLED', resource: { invoice: { id: d.paypalId, detail: { invoice_number: d.number } } } });
    expect(await handleWebhook(g, hookHeaders(), body, HOOK_ENV)).toMatchObject({ status: 200, body: { result: 'cancelled' } });
    expect(await db.query(`select state from invoices where paypal_invoice_id = $1`, [d.paypalId])).toEqual([{ state: 'cancelled' }]);
    expect(await db.query(`select status from autopilot_sends where version_id = $1`, [d.versionId])).toEqual([{ status: 'released' }]);
    expect((await getBriefView(db, d.briefId))!.status).toBe('cancelled');
  });
});

// ---------------------------------------------------------------- revocation (§4, fixes 6, 7, 15)

describe('revocation', () => {
  async function paidDemo() {
    const d = await demoInvoiced();
    const txn = m.pay(d.paypalId);
    expect((await grantIfPaid(g, d.versionId, 'test')).granted).toBe(true);
    return { ...d, txn };
  }

  it('refund webhook -> version refunded, download refused, revocation receipt, parent back to active', async () => {
    const d = await paidDemo();
    const dl = await issueDownload(db, d.token);
    if (!dl.ok) throw new Error(dl.error);
    m.refund(d.txn);
    expect(await handleWebhook(g, hookHeaders(), refundEvent(d.txn), HOOK_ENV)).toMatchObject({ status: 200, body: { result: 'refunded' } });
    expect((await versionRow(d.versionId)).status).toBe('refunded');
    expect((await versionRow(s.v1Id)).status).toBe('active');
    expect(await consumeDownload(db, uploadsDir, dl.url.split('/').pop()!)).toMatchObject({ ok: false, status: 410 });
    expect(await issueDownload(db, d.token)).toMatchObject({ ok: false });
    expect(await db.query(`select status, body->>'kind' as kind from receipts where version_id = $1 order by seq`, [d.versionId]))
      .toEqual([{ status: 'active', kind: 'grant' }, { status: 'refunded', kind: 'revocation' }]);
    expect((await payView(db, d.token))!.status).toBe('refunded');
    expect((await getBriefView(db, d.briefId))!.status).toBe('refunded');
  });

  it('fix 6: INVOICE.REFUNDED and CAPTURE.REFUNDED both fire -> one revocation', async () => {
    const d = await paidDemo();
    m.refund(d.txn);
    const inv = JSON.stringify({ id: eventId(), event_type: 'INVOICING.INVOICE.REFUNDED', resource: { invoice: { id: d.paypalId, detail: { invoice_number: d.number } } } });
    expect(await handleWebhook(g, hookHeaders(), inv, HOOK_ENV)).toMatchObject({ body: { result: 'refunded' } });
    expect(await handleWebhook(g, hookHeaders(), refundEvent(d.txn), HOOK_ENV)).toMatchObject({ body: { result: 'already_refunded' } });
    expect(await count(`receipts where version_id = $1 and status = 'refunded'`, [d.versionId])).toBe(1);
  });

  it('fix 6: a partial refund leaves the licence active and tells the creator', async () => {
    const d = await paidDemo();
    m.refund(d.txn, false);
    expect(await handleWebhook(g, hookHeaders(), refundEvent(d.txn), HOOK_ENV)).toMatchObject({ body: { result: 'partial' } });
    expect((await versionRow(d.versionId)).status).toBe('active');
    expect((await listAlerts(db, s.creatorId))[0]).toMatchObject({ kind: 'refund_partial' });
  });

  it('PAYMENT.CAPTURE.REVERSED (resource.id) -> revoked', async () => {
    const d = await paidDemo();
    m.reverse(d.txn);
    const body = JSON.stringify({ id: eventId(), event_type: 'PAYMENT.CAPTURE.REVERSED', resource: { id: d.txn, status: 'REVERSED' } });
    expect(await handleWebhook(g, hookHeaders(), body, HOOK_ENV)).toMatchObject({ body: { result: 'refunded' } });
    expect((await versionRow(d.versionId)).status).toBe('refunded');
  });

  it('fix 7: refund of v1 revokes it; a later pending quote built on it has its PayPal invoice cancelled', async () => {
    const v1Brief = await paste('suggests-price', T.SUGGESTS_PRICE, harborLight);
    await runAutopilot(db, m.api, v1Brief);
    const d1 = await deal(v1Brief);
    const txn = m.pay(d1.paypalId);
    expect((await grantIfPaid(g, d1.versionId, 'test')).granted).toBe(true);
    const v2Brief = await paste('paste', T.PASTE, harborLight);
    expect(await runAutopilot(db, m.api, v2Brief)).toMatchObject({ action: 'sent' });
    const d2 = await deal(v2Brief);
    m.refund(txn);
    await handleWebhook(g, hookHeaders(), refundEvent(txn), HOOK_ENV);
    expect((await versionRow(d1.versionId)).status).toBe('refunded');
    expect(m.invoices.get(d2.paypalId)!.status).toBe('CANCELLED');
    expect((await versionRow(d2.versionId)).status).toBe('superseded');
    expect(await db.query(`select status from autopilot_sends where version_id = $1`, [d2.versionId])).toEqual([{ status: 'released' }]);
    expect((await listAlerts(db, s.creatorId)).some((a) => a.kind === 'revoked_by_parent_refund' && a.briefId === v2Brief)).toBe(true);
  });

  it('fix 7: refund of v1 also revokes a later active version', async () => {
    const v1Brief = await paste('suggests-price', T.SUGGESTS_PRICE, harborLight);
    await runAutopilot(db, m.api, v1Brief);
    const d1 = await deal(v1Brief);
    const txn1 = m.pay(d1.paypalId);
    await grantIfPaid(g, d1.versionId, 'test');
    const v2Brief = await paste('paste', T.PASTE, harborLight);
    await runAutopilot(db, m.api, v2Brief);
    const d2 = await deal(v2Brief);
    m.pay(d2.paypalId);
    expect((await grantIfPaid(g, d2.versionId, 'test')).granted).toBe(true);
    m.refund(txn1);
    await handleWebhook(g, hookHeaders(), refundEvent(txn1), HOOK_ENV);
    expect((await versionRow(d1.versionId)).status).toBe('refunded');
    expect((await versionRow(d2.versionId)).status).toBe('refunded');
  });

  it('fix 15: the creator Re-check PayPal finds a refund with no webhook and revokes', async () => {
    const d = await paidDemo();
    m.refund(d.txn);
    const res = await decidePOST(creatorPost(`/api/briefs/${d.briefId}/decide`, { action: 'recheck' }), ctx('id', d.briefId));
    expect(res.status).toBe(200);
    expect((await versionRow(d.versionId)).status).toBe('refunded');
  });
});

// ---------------------------------------------------------------- downloads (§5, fixes 11, 12, 22)

describe('downloads', () => {
  it('fix 11: print in scope -> the print-resolution file, never the original', async () => {
    const d = await demoInvoiced(); // demo adds print
    m.pay(d.paypalId);
    await grantIfPaid(g, d.versionId, 'test');
    const dl = await issueDownload(db, d.token);
    if (!dl.ok) throw new Error(dl.error);
    const r = await consumeDownload(db, uploadsDir, dl.url.split('/').pop()!);
    const [a] = await db.query<{ key_print: string; key_original: string }>(`select key_print, key_original from assets where id = $1`, [morningPour]);
    expect(r.ok && r.bytes!.equals((await readAsset(uploadsDir, a!.key_print))!)).toBe(true);
    expect(r.ok && r.bytes!.equals((await readAsset(uploadsDir, a!.key_original))!)).toBe(false);
    // B9 9.1: what the client downloads is the private original of the photo they saw, not a generated image.
    expect(r.ok && r.bytes!.equals(readFileSync(originalPhotoPath(manifestPhotoFor('Morning Pour')!.num)))).toBe(true);
    expect((await payView(db, d.token))!.fileLabel).toBe('Print-resolution file');
  });

  it('fix 11: a web-only licence downloads the web file; the print file is not available to it', async () => {
    const id = await paste('suggests-price', T.SUGGESTS_PRICE, harborLight);
    await runAutopilot(db, m.api, id);
    const d = await deal(id);
    m.pay(d.paypalId);
    await grantIfPaid(g, d.versionId, 'test');
    const dl = await issueDownload(db, d.token);
    if (!dl.ok) throw new Error(dl.error);
    const r = await consumeDownload(db, uploadsDir, dl.url.split('/').pop()!);
    const [a] = await db.query<{ key_web: string; key_print: string }>(`select key_web, key_print from assets where id = $1`, [harborLight]);
    expect(r.ok && r.bytes!.equals((await readAsset(uploadsDir, a!.key_web))!)).toBe(true);
    expect(r.ok && r.bytes!.equals((await readAsset(uploadsDir, a!.key_print))!)).toBe(false);
    expect(r.ok && r.filename).toMatch(/-web\.jpg$/);
  });

  it('fix 12: 3 uses (HEAD free), the 4th refused; an expired link refused; re-issuable', async () => {
    const d = await demoInvoiced();
    m.pay(d.paypalId);
    await grantIfPaid(g, d.versionId, 'test');
    const dl = await issueDownload(db, d.token);
    if (!dl.ok) throw new Error(dl.error);
    const t = dl.url.split('/').pop()!;
    expect((await downloadHEAD(pub(`/download/${t}`, 'HEAD'), ctx('token', t))).status).toBe(200);
    for (let i = 0; i < 3; i++) {
      const res = await downloadGET(pub(`/download/${t}`), ctx('token', t));
      expect(res.status).toBe(200);
      expect(res.headers.get('referrer-policy')).toBe('no-referrer');
      expect(res.headers.get('location')).toBeNull();
    }
    expect((await downloadGET(pub(`/download/${t}`), ctx('token', t))).status).toBe(410);
    const again = await issueDownload(db, d.token);
    if (!again.ok) throw new Error(again.error);
    const t2 = again.url.split('/').pop()!;
    expect(await consumeDownload(db, uploadsDir, t2, { now: new Date(Date.now() + 5 * 60 * 1000 + 1000) })).toMatchObject({ ok: false, status: 410 });
    expect((await consumeDownload(db, uploadsDir, t2)).ok).toBe(true);
  });

  it('fix 22: tokens are stored hashed only', async () => {
    const d = await demoInvoiced();
    m.pay(d.paypalId);
    await grantIfPaid(g, d.versionId, 'test');
    const dl = await issueDownload(db, d.token);
    if (!dl.ok) throw new Error(dl.error);
    const raw = dl.url.split('/').pop()!;
    expect(raw).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(await db.query(`select * from download_tokens`))).not.toContain(raw);
    expect(JSON.stringify(await db.query(`select pay_token_hash, pay_token_enc from invoices`))).not.toContain(d.token);
  });
});

// ---------------------------------------------------------------- pay page + receipts (§3, §6, fixes 9, 10, 13, 14, 16, 22)

describe('client pay page', () => {
  it('payer link unlocks: SENT -> page re-check locked; PayPal flips to PAID -> re-check grants -> download works', async () => {
    const d = await demoInvoiced();
    const first = await (await checkPOST(pub(`/api/pay/${d.token}/check`, 'POST'), ctx('token', d.token))).json();
    expect(first.view).toMatchObject({ status: 'unpaid', totalCents: 42000, payerUrl: expect.stringMatching(/^https:\/\/www\.sandbox\.paypal\.com/) });
    m.pay(d.paypalId);
    await db.query(`update invoices set last_checked_at = null where paypal_invoice_id = $1`, [d.paypalId]);
    const second = await (await checkPOST(pub(`/api/pay/${d.token}/check`, 'POST'), ctx('token', d.token))).json();
    expect(second.view).toMatchObject({ status: 'paid', verified: { amountCents: 42000, paypalTransactionId: expect.stringMatching(/^CAP/) }, receiptPath: expect.stringMatching(/^\/r\//) });
    const issued = await (await dlIssuePOST(pub(`/api/pay/${d.token}/download`, 'POST'), ctx('token', d.token))).json();
    const t = issued.url.split('/').pop();
    expect((await downloadGET(pub(issued.url), ctx('token', t))).status).toBe(200);
  });

  it('fix 10: PayPal is asked at most once per invoice per 10 s; the poll GET never calls PayPal', async () => {
    const d = await demoInvoiced();
    m.reset();
    await checkPOST(pub(`/api/pay/${d.token}/check`, 'POST'), ctx('token', d.token));
    const again = await (await checkPOST(pub(`/api/pay/${d.token}/check`, 'POST'), ctx('token', d.token))).json();
    expect(again.throttled).toBe(true);
    for (let i = 0; i < 3; i++) expect((await payGET(pub(`/api/pay/${d.token}`), ctx('token', d.token))).status).toBe(200);
    expect(m.count('getInvoice')).toBe(1);
  });

  it(`fix 10 + F6: ${PAY_LIMITS.pay_read} poll reads per hour per IP, then 429; another address is unaffected`, async () => {
    const d = await demoInvoiced();
    await db.query(`insert into rate_hits (kind, ip_hash, at) select 'pay_read', $1, now() - interval '1 minute' from generate_series(1, $2)`,
      [ipHashOf('203.0.113.50'), PAY_LIMITS.pay_read - 1]);
    expect((await payGET(pub(`/api/pay/${d.token}`, 'GET', '203.0.113.50'), ctx('token', d.token))).status).toBe(200);
    expect((await payGET(pub(`/api/pay/${d.token}`, 'GET', '203.0.113.50'), ctx('token', d.token))).status).toBe(429);
    expect((await payGET(pub(`/api/pay/${d.token}`, 'GET', '203.0.113.51'), ctx('token', d.token))).status).toBe(200);
  });

  it('public POSTs need our origin', async () => {
    const d = await demoInvoiced();
    const req = new Request(`http://app.test/api/pay/${d.token}/check`, { method: 'POST', headers: { host: 'app.test', origin: 'https://evil.example' } });
    expect((await checkPOST(req, ctx('token', d.token))).status).toBe(403);
  });

  it('pay page JSON and receipt page never contain the version UUID, invoice UUID or a storage key', async () => {
    const d = await demoInvoiced();
    m.pay(d.paypalId);
    await grantIfPaid(g, d.versionId, 'test');
    const res = await payGET(pub(`/api/pay/${d.token}`), ctx('token', d.token));
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    const text = await res.text();
    const [inv] = await db.query<{ id: string }>(`select id from invoices where paypal_invoice_id = $1`, [d.paypalId]);
    const [a] = await db.query<{ key_original: string; key_print: string; key_web: string }>(`select key_original, key_print, key_web from assets where id = $1`, [morningPour]);
    const receiptId = JSON.parse(text).receiptPath.split('/').pop();
    const html = renderToString(await ReceiptPage({ params: Promise.resolve({ id: receiptId }) }));
    for (const page of [text, html]) {
      for (const secret of [d.versionId, inv!.id, s.creatorId, a!.key_original, a!.key_print, a!.key_web, 'buying@northwind.example']) expect(page).not.toContain(secret);
    }
    expect(html).toContain('Record of payment and scope, not legal advice.');
    expect(html).toContain(JSON.parse(text).verified.paypalTransactionId);
  });

  it('fix 16: receipt shows the live status (superseded after the next version is paid)', async () => {
    const v1Brief = await paste('suggests-price', T.SUGGESTS_PRICE, harborLight);
    await runAutopilot(db, m.api, v1Brief);
    const d1 = await deal(v1Brief);
    m.pay(d1.paypalId);
    await grantIfPaid(g, d1.versionId, 'test');
    const r1 = (await payView(db, d1.token))!.receiptPath!.split('/').pop()!;
    expect((await receiptView(db, r1))!.liveStatus).toBe('active');
    const v2Brief = await paste('paste', T.PASTE, harborLight);
    await runAutopilot(db, m.api, v2Brief);
    const d2 = await deal(v2Brief);
    m.pay(d2.paypalId);
    await grantIfPaid(g, d2.versionId, 'test');
    expect((await receiptView(db, r1))!.liveStatus).toBe('superseded');
    expect((await receiptView(db, r1))!.body).toMatchObject({ versionNo: 1, renewalDate: (await receiptView(db, r1))!.body.endAt });
  });
});

describe('fix 9: delivery link', () => {
  it('the invoice note carries the same /pay link the deal room shows; Rotate makes a new one and kills the old', async () => {
    const d = await demoInvoiced();
    expect(m.invoices.get(d.paypalId)!.draft.note).toContain(`/pay/${d.token}`);
    expect((await getBriefView(db, d.briefId))!.version!.invoice!.payPath).toBe(`/pay/${d.token}`);
    const res = await decidePOST(creatorPost(`/api/briefs/${d.briefId}/decide`, { action: 'rotate_link' }), ctx('id', d.briefId));
    const body = await res.json();
    expect(body.payPath).not.toBe(`/pay/${d.token}`);
    expect(await payView(db, d.token)).toBeNull();
    expect(await payView(db, body.payPath.split('/').pop())).toMatchObject({ status: 'unpaid' });
  });

  it('the stored link is AES-GCM encrypted and tamper-evident', () => {
    const enc = encryptToken('abc');
    expect(decryptToken(enc)).toBe('abc');
    expect(decryptToken(enc.slice(0, -2) + (enc.endsWith('A') ? 'B' : 'A') + 'A')).toBeNull();
  });

  it('a paid deal does not get re-quoted by autopilot on the same request', async () => {
    const d = await demoInvoiced();
    m.pay(d.paypalId);
    await grantIfPaid(g, d.versionId, 'test');
    expect(await runAutopilot(db, m.api, d.briefId)).toMatchObject({ action: 'skipped' });
    expect(m.count('create')).toBe(1);
  });

  it('after payment the deal room price is the paid quote against the licence it extended', async () => {
    const d = await demoInvoiced();
    m.pay(d.paypalId);
    await grantIfPaid(g, d.versionId, 'test');
    const view = (await getBriefView(db, d.briefId))!;
    expect(view.status).toBe('paid');
    expect(view.gapPreview!.totalCents).toBe(42000);
    expect(view.editable).toBe(true);
  });

  it('a creator edit after payment makes the next version on top of the paid one', async () => {
    const d = await demoInvoiced();
    m.pay(d.paypalId);
    await grantIfPaid(g, d.versionId, 'test');
    const r = await editBrief(db, s.creatorId, d.briefId, { uses: [...(await getBriefView(db, d.briefId))!.checks!.kept.map((k) => ({ optionId: k.optionId, quote: k.quote }))] });
    expect(r.ok).toBe(true);
    const view = (await getBriefView(db, d.briefId))!;
    // F3: the paid version keeps a version number unique on this client + photo (earlier tests' v2s exist here).
    const [paid] = await db.query<{ version_no: number }>(`select version_no from licence_versions where id = $1`, [d.versionId]);
    expect(paid!.version_no).toBeGreaterThanOrEqual(2);
    expect(view.licence).toMatchObject({ versionNo: paid!.version_no });
  });
});

describe('re-check helper', () => {
  it('nothing to check for a deal with no invoice', async () => {
    expect(await recheck(g, s.v1Id, 'test')).toEqual({ checked: false, reason: 'nothing_to_check' });
  });
});
