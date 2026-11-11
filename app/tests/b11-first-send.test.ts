// review's B11 build review, finding 1 (docs/reviews/b11-build-review.md): a quote made before the B11 refusal must not reach
// PayPal by any route, and an invoice already out must keep working. Real route handlers on PGlite with PayPal mocked.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { POST as askPOST } from '@/app/api/ask/route';
import { POST as decidePOST } from '@/app/api/briefs/[id]/decide/route';
import { POST as intakePOST } from '@/app/api/intake/route';
import { SAMPLES } from '@/components/creator/request-samples';
import { openPglite, type Db } from '../db/client';
import { initialize } from '../db/init';
import { creatorCard, gapPreview, latestExtraction, loadBrief } from '../lib/briefs';
import { advanceToNextRenewal } from '../lib/clock';
import { grantIfPaid } from '../lib/grant';
import { runTick } from '../lib/renewal';
import { runAutopilot } from '../lib/send';
import { setRouteDepsForTests } from '../lib/server';
import { versionHash } from '../lib/versions';
import { mockInvoiceApi } from './helpers/mock-paypal';

const TOKEN = 'b11-first-send-token';
let db: Db;
let dir: string;
let m: ReturnType<typeof mockInvoiceApi>;
let ids: { clients: Record<string, string>; assets: Record<string, string> };
const saved = { token: process.env.CREATOR_TOKEN, origin: process.env.APP_ORIGIN, demo: process.env.DEMO_MODE };
const headers = { host: 'app.test', origin: 'http://app.test', cookie: `ur_creator=${TOKEN}`, 'content-type': 'application/json' };
const params = (id: string) => ({ params: Promise.resolve({ id }) });

beforeAll(async () => {
  db = await openPglite();
  dir = await mkdtemp(join(tmpdir(), 'ur-b11f-'));
  await initialize(db, dir);
  process.env.CREATOR_TOKEN = TOKEN;
  delete process.env.APP_ORIGIN;
  m = mockInvoiceApi();
  setRouteDepsForTests({ db, uploadsDir: dir, invoices: m.api });
  const clients = await db.query<{ id: string; email: string }>(`select id, email from clients`);
  const assets = await db.query<{ id: string; title: string }>(`select id, title from assets`);
  ids = { clients: Object.fromEntries(clients.map((c) => [c.email, c.id])), assets: Object.fromEntries(assets.map((a) => [a.title, a.id])) };
});
afterAll(async () => {
  setRouteDepsForTests(null);
  if (saved.token === undefined) delete process.env.CREATOR_TOKEN; else process.env.CREATOR_TOKEN = saved.token;
  if (saved.origin !== undefined) process.env.APP_ORIGIN = saved.origin;
  if (saved.demo === undefined) delete process.env.DEMO_MODE; else process.env.DEMO_MODE = saved.demo;
  await db?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});
beforeEach(() => m.reset());

async function submit(key: string) {
  const s = SAMPLES.find((x) => x.key === key)!;
  const body = { source: 'paste', clientId: ids.clients[s.clientEmail], assetId: ids.assets[s.assetTitle], text: s.text, fixture: s.fixture };
  const res = await intakePOST(new Request('http://app.test/api/intake', { method: 'POST', headers, body: JSON.stringify(body) }));
  expect(res.status).toBe(201);
  return ((await res.json()) as { briefId: string }).briefId;
}
const decide = (id: string, body: object) => decidePOST(new Request(`http://app.test/api/briefs/${id}/decide`, { method: 'POST', headers, body: JSON.stringify(body) }), params(id));
const ask = (body: object) => askPOST(new Request('http://app.test/api/ask', { method: 'POST', headers, body: JSON.stringify(body) }));
const pendingId = async (briefId: string) => (await db.query<{ id: string }>(`select id from licence_versions where brief_id = $1 and status = 'pending'`, [briefId]))[0]!.id;
const paidReason = (briefId: string) => db.query(`update extractions set reasons = array['tripwire:boost'], status = 'needs_creator' where brief_id = $1`, [briefId]);
const paypalWrites = () => m.calls.filter((c) => c.op === 'create' || c.op === 'send');

/** The quote a request like this got before B11 refused it: the same row pendingVersionFor used to write. */
async function legacyQuote(briefId: string) {
  const brief = (await loadBrief(db, briefId))!;
  const x = (await latestExtraction(db, briefId))!;
  const preview = (await gapPreview(db, brief, x.raw.requested))!;
  const hash = versionHash({ scope: preview.combined, totalCents: preview.totalCents, assetId: brief.asset_id!, clientId: brief.client_id!, parentId: null });
  const [v] = await db.query<{ id: string }>(
    `insert into licence_versions (creator_id, client_id, asset_id, parent_id, version_no, scope, rate_card, total_cents, paid_cents, content_hash, status, brief_id, extraction_id)
     values ($1, $2, $3, null, 1, $4, $5, $6, 0, $7, 'pending', $8, $9) returning id`,
    [brief.creator_id, brief.client_id, brief.asset_id, JSON.stringify(preview.combined), JSON.stringify(await creatorCard(db, brief.creator_id)), preview.totalCents, hash, brief.id, x.id]);
  return { id: v!.id, total: (preview.totalCents / 100).toFixed(2), creatorId: brief.creator_id, clientId: brief.client_id! };
}
async function approvalFor(q: Awaited<ReturnType<typeof legacyQuote>>) {
  const [v] = await db.query<{ content_hash: string; total_cents: number }>(`select content_hash, total_cents from licence_versions where id = $1`, [q.id]);
  const [c] = await db.query<{ email: string }>(`select email from clients where id = $1`, [q.clientId]);
  await db.query(`insert into approvals (creator_id, version_id, version_hash, amount_cents, recipient) values ($1, $2, $3, $4, $5)`, [q.creatorId, q.id, v!.content_hash, v!.total_cents, c!.email]);
}

describe('a pending paid-use quote made before the refusal', () => {
  it('deal-room Approve: 409, no approval recorded, no PayPal call', async () => {
    const id = await submit('paid');
    const q = await legacyQuote(id);
    const res = await decide(id, { action: 'approve', typedTotal: q.total });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'paid_use_unpriced' });
    expect(paypalWrites()).toEqual([]);
    expect(await db.query(`select 1 from approvals where version_id = $1`, [q.id])).toEqual([]);
    expect(await db.query(`select 1 from invoices where version_id = $1`, [q.id])).toEqual([]);
  });

  it('direct Ask with the versionId: 409, no PayPal call', async () => {
    const q = await legacyQuote(await submit('paid'));
    const res = await ask({ versionId: q.id, action: 'approve', typedTotal: q.total });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'paid_use_unpriced' });
    expect(paypalWrites()).toEqual([]);
  });

  it('Retry, even with an approval already on file: 409, no PayPal call', async () => {
    const id = await submit('paid');
    const q = await legacyQuote(id);
    await approvalFor(q);
    const res = await decide(id, { action: 'retry' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'paid_use_unpriced' });
    expect(paypalWrites()).toEqual([]);
    expect(await db.query(`select 1 from invoices where version_id = $1`, [q.id])).toEqual([]);
  });

  it('a Setup save before B11 turned the words into notes with status ready: autopilot and Approve still refuse', async () => {
    const id = await submit('paid');
    await db.query(`update extractions set status = 'ready', reasons = '{}', model = 'creator_edit', raw = raw || '{"notes":["tripwire:boost","tripwire:paid ads"]}'::jsonb where brief_id = $1`, [id]);
    const q = await legacyQuote(id);
    expect(await runAutopilot(db, m.api, id)).toMatchObject({ action: 'failed' });
    expect((await decide(id, { action: 'approve', typedTotal: q.total })).status).toBe(409);
    expect(paypalWrites()).toEqual([]);
    expect(await db.query(`select 1 from autopilot_sends where version_id = $1 and status = 'reserved'`, [q.id])).toEqual([]);
  });

  it('Reject still closes it', async () => {
    const q = await legacyQuote(await submit('paid'));
    expect((await ask({ versionId: q.id, action: 'reject' })).status).toBe(200);
  });
});

describe('what is already out keeps working', () => {
  async function sentBillboard() {
    const id = await submit('billboard');
    expect((await decide(id, { action: 'approve', typedTotal: '900.00' })).status).toBe(200);
    return id;
  }

  it('an invoice already sent: Retry and Ask return it, with no new PayPal write', async () => {
    const id = await sentBillboard();
    await paidReason(id);
    const versionId = await pendingId(id);
    m.reset();
    const res = await decide(id, { action: 'retry' });
    expect(res.status).toBe(200);
    expect((await ask({ versionId, action: 'approve', typedTotal: '900.00' })).status).toBe(200);
    expect(paypalWrites()).toEqual([]);
    expect(await db.query(`select 1 from invoices where version_id = $1 and state = 'sent'`, [versionId])).toHaveLength(1);
  });

  async function heldBillboard() {
    const id = await submit('billboard');
    m.failNext('create', 'created-then-timeout');
    m.failNext('findByNumber', 'timeout');
    expect((await decide(id, { action: 'approve', typedTotal: '900.00' })).status).not.toBe(200);
    const versionId = await pendingId(id);
    const [row] = await db.query<{ invoice_number: string }>(`select invoice_number from invoices where version_id = $1 and state <> 'cancelled'`, [versionId]);
    await paidReason(id);
    m.reset();
    return { id, versionId, number: row!.invoice_number };
  }

  it('reconcile: a held attempt PayPal shows as sent is recorded as sent, with no new PayPal write', async () => {
    const h = await heldBillboard();
    m.byNumber(h.number).status = 'SENT';
    expect((await decide(h.id, { action: 'retry' })).status).toBe(200);
    expect(paypalWrites()).toEqual([]);
    expect(await db.query(`select 1 from invoices where version_id = $1 and state = 'sent'`, [h.versionId])).toHaveLength(1);
  });

  it('reconcile: a held attempt still a draft is not sent; the draft is deleted', async () => {
    const h = await heldBillboard();
    const res = await decide(h.id, { action: 'retry' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'paid_use_unpriced' });
    expect(m.calls.some((c) => c.op === 'send')).toBe(false);
    expect(m.calls.some((c) => c.op === 'remove')).toBe(true);
    expect(await db.query(`select 1 from invoices where version_id = $1 and state not in ('cancelled')`, [h.versionId])).toEqual([]);
  });

  // review N1: the row is cancelled only after PayPal confirms the delete.
  const rowState = async (versionId: string) => (await db.query<{ state: string }>(`select state from invoices where version_id = $1`, [versionId]))[0]!.state;
  const sendState = async (versionId: string) => (await db.query<{ send_state: string }>(`select send_state from licence_versions where id = $1`, [versionId]))[0]!.send_state;
  // These deals share one client and photo, and a grant supersedes the parent: put the seeded licence back for the next deal.
  const endLicence = async (versionId: string) => {
    await db.query(`update licence_versions set status = 'superseded' where id = $1`, [versionId]);
    await db.query(`update licence_versions set status = 'active' where id = (select parent_id from licence_versions where id = $1)`, [versionId]);
  };

  it('N1: an empty PayPal status is not a draft: refused, no delete, row kept, and a later attempt records what is out', async () => {
    const h = await heldBillboard();
    m.byNumber(h.number).status = '';
    const res = await decide(h.id, { action: 'retry' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'paid_use_unpriced' });
    expect(m.count('remove')).toBe(0);
    expect(m.count('send')).toBe(0);
    expect(await rowState(h.versionId)).toBe('created');
    expect(await sendState(h.versionId)).toBe('failed'); // not stuck in sending, so the next attempt reconciles at once
    m.byNumber(h.number).status = 'SENT';
    expect((await decide(h.id, { action: 'retry' })).status).toBe(200);
    expect(m.count('send')).toBe(0);
    expect(await rowState(h.versionId)).toBe('sent');
  });

  it.each(['SENT', 'PAID'])('N1: a stale DRAFT read whose delete fails because the invoice is %s: row kept, next attempt records it', async (real) => {
    const h = await heldBillboard();
    m.failNext('remove', 422, 'INVOICE_CANNOT_BE_DELETED'); // the real answer, docs/spike-results.md
    expect((await decide(h.id, { action: 'retry' })).status).toBe(409);
    expect(m.count('remove')).toBe(1);
    expect(m.count('send')).toBe(0);
    expect(await rowState(h.versionId)).toBe('created');
    const inv = m.byNumber(h.number);
    if (real === 'PAID') m.pay(inv.id); else inv.status = 'SENT';
    expect((await decide(h.id, { action: 'retry' })).status).toBe(200);
    expect(m.count('remove')).toBe(1);
    expect(m.count('send')).toBe(0);
    expect(await rowState(h.versionId)).toBe('sent');
    if (real === 'PAID') {
      expect(await grantIfPaid({ db, pp: m.pp, uploadsDir: dir }, h.versionId, 'test')).toMatchObject({ granted: true });
      expect(await rowState(h.versionId)).toBe('paid');
      await endLicence(h.versionId);
    }
  });

  it('N1: a grant that lands while the delete runs: the row stays paid', async () => {
    const h = await heldBillboard();
    const real = m.api.remove;
    let grant: unknown = null;
    m.api.remove = async (id) => {
      m.pay(id);
      grant = await grantIfPaid({ db, pp: m.pp, uploadsDir: dir }, h.versionId, 'test');
      return real(id);
    };
    try {
      expect((await decide(h.id, { action: 'retry' })).status).toBe(409);
    } finally {
      m.api.remove = real;
    }
    expect(grant).toMatchObject({ granted: true });
    expect(await rowState(h.versionId)).toBe('paid');
    expect(await sendState(h.versionId)).toBe('sent');
    expect(m.count('send')).toBe(0);
    await endLicence(h.versionId);
  });

  it('N1: delete fails, row and reservation stay; the retry deletes it, then cancels and releases', async () => {
    m.failNext('create', 'created-then-timeout');
    m.failNext('findByNumber', 'timeout');
    const printId = await submit('print');
    const versionId = await pendingId(printId);
    const [row] = await db.query<{ invoice_number: string }>(`select invoice_number from invoices where version_id = $1`, [versionId]);
    const reserved = () => db.query(`select 1 from autopilot_sends where version_id = $1 and status = 'reserved'`, [versionId]);
    expect(await reserved()).toHaveLength(1);
    await db.query(`update extractions set raw = raw || '{"notes":["tripwire:boost"]}'::jsonb where brief_id = $1`, [printId]);
    m.reset();

    m.failNext('remove', 500);
    expect((await decide(printId, { action: 'retry' })).status).toBe(409);
    expect(m.count('remove')).toBe(1);
    expect(await rowState(versionId)).toBe('created');
    expect(await reserved()).toHaveLength(1);
    expect(m.byNumber(row!.invoice_number)).toBeDefined();

    expect((await decide(printId, { action: 'retry' })).status).toBe(409);
    expect(m.count('remove')).toBe(2);
    expect(m.count('send')).toBe(0);
    expect(await rowState(versionId)).toBe('cancelled');
    expect(await reserved()).toEqual([]);
    expect(m.byNumber(row!.invoice_number)).toBeUndefined();
  });

  it('a renewal has no extraction and still sends', async () => {
    process.env.DEMO_MODE = '1';
    const DEMO = { DEMO_MODE: '1' };
    const [c] = await db.query<{ id: string }>(`select id from creators limit 1`);
    expect(await advanceToNextRenewal(db, c!.id, DEMO)).toMatchObject({ ok: true });
    await runTick({ db, api: m.api, env: DEMO });
    const [r] = await db.query<{ extraction_id: string | null; send_state: string }>(`select extraction_id, send_state from licence_versions where renewal_of is not null order by seq desc limit 1`);
    expect(r).toEqual({ extraction_id: null, send_state: 'sent' });
    expect(m.calls.some((x) => x.op === 'send')).toBe(true);
  });
});
