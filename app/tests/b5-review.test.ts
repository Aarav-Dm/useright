// Batch 5 code reviews: review (docs/reviews/b5-review-code.md), review (b5-review-code.md), review (b5-review-code.md).
// PayPal is the in-memory mock; route tests call the real handlers with a creator cookie.
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { POST as askPOST } from '@/app/api/ask/route';
import { POST as decidePOST } from '@/app/api/briefs/[id]/decide/route';
import { POST as transcriptPOST } from '@/app/api/briefs/[id]/transcript/route';
import { GET as ledgerGET } from '@/app/api/ledger/route';
import { openPglite, type Db } from '../db/client';
import { migrate } from '../db/migrate';
import { seed, type SeedResult } from '../db/seed';
import { createAdapter, fixtureProvider } from '../lib/ai/extract';
import { confirmTranscript, editBrief, getBriefView, type AiFor } from '../lib/briefs';
import { intake, type IntakeDeps } from '../lib/intake';
import { listLedger } from '../lib/ledger';
import { paypalCredentials, PayPalHostError } from '../lib/paypal/env';
import { pinToolkitHost } from '../lib/paypal/invoices';
import { evaluate, startOfDayIn } from '../lib/policy';
import { cancelAndRequote, markInvoiceCancelled, reject, retry, runAutopilot, sendInvoice, STALE_SEND_MS } from '../lib/send';
import { setRouteDepsForTests } from '../lib/server';
import { invoiceNumberFor, MAX_INVOICE_ATTEMPTS, pendingVersionFor } from '../lib/versions';
import * as T from './fixtures/texts';
import { mockInvoiceApi } from './helpers/mock-paypal';

let db: Db;
let s: SeedResult;
let deps: IntakeDeps;
let uploadsDir: string;
let morningPour: string;
let harborLight: string;
let pp: ReturnType<typeof mockInvoiceApi>;
const aiFor: AiFor = (fixture) => createAdapter(fixtureProvider(fixture ?? 'paste'));
const creator = { creator: true, sessionSlug: 'imani' };
const TOKEN = 'b5-review-token';
const savedToken = process.env.CREATOR_TOKEN;
const savedOrigin = process.env.APP_ORIGIN;

const env = (e: Record<string, string>) => e as unknown as NodeJS.ProcessEnv;
const post = (path: string, body: unknown, origin = 'http://app.test') =>
  new Request(`http://app.test${path}`, {
    method: 'POST', body: JSON.stringify(body),
    headers: { host: 'app.test', origin, cookie: `ur_creator=${TOKEN}`, 'content-type': 'application/json' },
  });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

async function paste(fixture: string, text: string, assetId: string) {
  const r = await intake(deps, { source: 'paste', clientId: s.clientId, assetId, text, fixture }, creator);
  if (!r.ok) throw new Error(r.error);
  return r.briefId;
}
/** The $420 demo DM, left waiting for its transcript (screenshot intake). */
async function demoScreenshot() {
  const png = await readFile(join(import.meta.dirname, 'fixtures', 'demo-dm.png'));
  const r = await intake(deps, { source: 'screenshot', clientId: s.clientId, assetId: morningPour, fixture: 'demo-dm', image: { mime: 'image/png', base64: png.toString('base64') } }, creator);
  if (!r.ok) throw new Error(r.error);
  return r.briefId;
}
async function demoDm() {
  const id = await demoScreenshot();
  await confirmTranscript(db, aiFor, id, T.DEMO_DM);
  return id;
}
async function pending(briefId: string) {
  const pv = await pendingVersionFor(db, briefId);
  if (!pv.ok) throw new Error(pv.error);
  return pv.version;
}
const view = async (id: string) => (await getBriefView(db, id))!;
const invoicesFor = (versionId: string) =>
  db.query<{ state: string; invoice_number: string; payer_url: string | null; recipient_email: string | null }>(
    `select state, invoice_number, payer_url, recipient_email from invoices where version_id = $1 order by seq`, [versionId]);
const sendsFor = (versionId: string) => db.query<{ status: string }>(`select status from autopilot_sends where version_id = $1 order by seq`, [versionId]);

beforeAll(async () => {
  db = await openPglite();
  await migrate(db);
  s = await seed(db);
  [morningPour, harborLight] = s.assetIds as [string, string];
  uploadsDir = await mkdtemp(join(tmpdir(), 'ur-b5r-'));
  deps = { db, aiFor, uploadsDir, env: env({ AI_PROVIDER: 'fixture', NODE_ENV: 'test' }) };
  process.env.CREATOR_TOKEN = TOKEN;
  delete process.env.APP_ORIGIN;
});
afterAll(async () => {
  setRouteDepsForTests(null);
  if (savedToken === undefined) delete process.env.CREATOR_TOKEN;
  else process.env.CREATOR_TOKEN = savedToken;
  if (savedOrigin !== undefined) process.env.APP_ORIGIN = savedOrigin;
  await db?.close();
  if (uploadsDir) await rm(uploadsDir, { recursive: true, force: true });
});
beforeEach(async () => {
  pp = mockInvoiceApi();
  setRouteDepsForTests({ db, aiFor, invoices: pp.api, uploadsDir });
  await db.query(`update autopilot_sends set status = 'released' where status in ('reserved', 'sent')`);
  await db.query(`update creator_settings set per_deal_cap_cents = 50000, daily_max_sends = 10, rolling30_cap_cents = 150000, timezone = 'America/New_York' where creator_id = $1`, [s.creatorId]);
});
afterEach(() => setRouteDepsForTests(null));

// ---------------------------------------------------------------- review

describe('review 1: the draft is read back before send', () => {
  it.each([
    ['a tip allowed', (i: { allowTip: boolean | null }) => { i.allowTip = true; }],
    ['partial payment allowed', (i: { allowPartial: boolean | null }) => { i.allowPartial = true; }],
    ['a different amount', (i: { amountValue: string | null }) => { i.amountValue = '1.00'; }],
    ['a different currency', (i: { currency: string | null }) => { i.currency = 'EUR'; }],
  ] as const)('PayPal stores %s -> draft deleted, nothing sent, deal failed', async (_n, tamper) => {
    pp.onCreate(tamper as (i: unknown) => void);
    const id = await demoDm();
    expect(await runAutopilot(db, pp.api, id)).toMatchObject({ action: 'failed' });
    expect(pp.count('send')).toBe(0);
    expect(pp.count('remove')).toBe(1);
    expect(pp.invoices.size).toBe(0);
    const v = (await view(id)).version!;
    expect(await invoicesFor(v.id)).toEqual([expect.objectContaining({ state: 'cancelled' })]);
    expect(v.sendError).toMatch(/different terms/);
  });

  it('a matching draft is read back (one GET) before the one send', async () => {
    const id = await demoDm();
    await runAutopilot(db, pp.api, id);
    const ops = pp.calls.map((c) => c.op);
    expect(ops.slice(0, 3)).toEqual(['create', 'get', 'send']);
  });
});

describe('review 2: the Agent Toolkit uses the same PayPal host as REST', () => {
  it('pins both toolkit clients to credentials().base', async () => {
    const { PayPalAgentToolkit } = await import('@paypal/agent-toolkit/ai-sdk');
    const kit = new PayPalAgentToolkit({ clientId: 'id', clientSecret: 'secret', configuration: { actions: { invoices: { create: true } }, context: { sandbox: true } } });
    const k = kit as unknown as { client: { getBaseUrl: () => string }; _paypal: { baseUrl: string } };
    expect(k.client.getBaseUrl()).toBe('https://api.sandbox.paypal.com'); // the toolkit's own default differs from REST
    pinToolkitHost(kit, 'https://api-m.sandbox.paypal.com');
    expect(k.client.getBaseUrl()).toBe('https://api-m.sandbox.paypal.com');
    expect(k._paypal.baseUrl).toBe('https://api-m.sandbox.paypal.com');
  });
  it('refuses a toolkit whose layout it does not know (create then falls back to REST)', () => {
    expect(() => pinToolkitHost({}, 'https://api-m.sandbox.paypal.com')).toThrow(/layout changed/);
  });
});

describe('review 4: claim re-checks the per-deal cap under the lock', () => {
  it('cap lowered after evaluate() reserved the send -> refused, reservation released, no PayPal call', async () => {
    const id = await demoDm();
    const v = await pending(id);
    const ev = await evaluate(db, v.id, { mode: 'autopilot' });
    expect(ev.ok && ev.policy.pass && ev.reservationId).toBeTruthy();
    await db.query(`update creator_settings set per_deal_cap_cents = 10000 where creator_id = $1`, [s.creatorId]);
    expect(await sendInvoice(db, pp.api, v.id, { mode: 'autopilot' })).toMatchObject({ ok: false, status: 409, code: 'over_deal_cap' });
    expect(pp.calls).toHaveLength(0);
    expect(await sendsFor(v.id)).toEqual([{ status: 'released' }]);
  });
});

// ---------------------------------------------------------------- review

describe('review 1: an invoiced quote keeps its frozen price on screen', () => {
  it('raising the rate card after a v1 invoice does not change the Price shown for it', async () => {
    const id = await paste('suggests-price', T.SUGGESTS_PRICE, harborLight);
    expect(await runAutopilot(db, pp.api, id)).toMatchObject({ action: 'sent' });
    const before = await view(id);
    expect(before.gapPreview!.totalCents).toBe(before.version!.totalCents);
    await db.query(`update rate_card_options set cents = cents + 10000 where creator_id = $1 and option_id = 'web'`, [s.creatorId]);
    try {
      const after = await view(id);
      expect(after.status).toBe('invoiced');
      expect(after.gapPreview!.totalCents).toBe(before.version!.totalCents);
      expect(after.cardSource).toBe(`rate card (frozen with quote v${after.version!.versionNo})`);
    } finally {
      await db.query(`update rate_card_options set cents = cents - 10000 where creator_id = $1 and option_id = 'web'`, [s.creatorId]);
    }
  });
});

describe('review 5: invoiced deals report editable=false', () => {
  it('editable before the invoice, not while it is out, again after cancel', async () => {
    const id = await demoDm();
    expect((await view(id)).editable).toBe(true);
    await runAutopilot(db, pp.api, id);
    expect((await view(id)).editable).toBe(false);
    await cancelAndRequote(db, pp.api, s.creatorId, id);
    expect((await view(id)).editable).toBe(true);
  });
});

describe('review 6: rejected ledger rows keep their identity', () => {
  it('rejecting the billboard deal -> ledger row with deal, version, scope, status', async () => {
    const id = await paste('billboard', T.BILLBOARD, morningPour);
    await runAutopilot(db, pp.api, id);
    const v = (await view(id)).version!;
    await reject(db, s.creatorId, id);
    const row = (await listLedger(db, s.creatorId)).find((r) => r.kind === 'rejected' && r.briefId === id)!;
    expect(row).toMatchObject({ deal: 'Northwind Coffee · Morning Pour', versionId: v.id, versionNo: v.versionNo, status: 'draft' });
    expect(row.scope).toContain('Billboard');
  });
});

describe('review 7: a lost payer link is recovered without a second invoice', () => {
  it('GET after send fails -> invoiced with no link; Retry re-reads it once and saves it', async () => {
    const id = await demoDm();
    pp.failNext('get', 'pass'); // the read-back before send
    pp.failNext('get', 500); // the read after send
    expect(await runAutopilot(db, pp.api, id)).toMatchObject({ action: 'sent', send: { payerUrl: null } });
    const v = (await view(id)).version!;
    expect((await view(id)).status).toBe('invoiced');
    expect(v.invoice!.payerUrl).toBeNull();

    pp.reset();
    const r = await retry(db, pp.api, s.creatorId, id);
    expect(r).toMatchObject({ ok: true, already: true, payerUrl: expect.stringMatching(/^https:\/\/www\.sandbox\.paypal\.com/) });
    expect(pp.calls.map((c) => c.op)).toEqual(['get']);
    expect((await invoicesFor(v.id))[0]!.payer_url).toMatch(/^https:\/\/www\.sandbox\.paypal\.com/);
  });
});

describe('review 8: the daily cap starts at the right midnight on clock-change days', () => {
  it.each([
    ['2026-11-01T04:30:00Z', '2026-11-01T04:00:00Z'], // 00:30 EDT; midnight was EDT
    ['2026-11-01T18:00:00Z', '2026-11-01T04:00:00Z'], // 13:00 EST, same day: midnight was still EDT
    ['2026-03-08T05:30:00Z', '2026-03-08T05:00:00Z'], // 00:30 EST before clocks go forward
    ['2026-03-08T20:00:00Z', '2026-03-08T05:00:00Z'], // 16:00 EDT, same day
    ['2026-07-15T12:00:00Z', '2026-07-15T04:00:00Z'],
  ])('America/New_York at %s -> %s', (now, midnight) => {
    expect(startOfDayIn('America/New_York', new Date(now)).toISOString()).toBe(new Date(midnight).toISOString());
  });
  it('UTC and a half-hour zone', () => {
    expect(startOfDayIn('UTC', new Date('2026-11-01T00:00:00Z')).toISOString()).toBe('2026-11-01T00:00:00.000Z');
    expect(startOfDayIn('Asia/Kolkata', new Date('2026-11-01T20:00:00Z')).toISOString()).toBe('2026-11-01T18:30:00.000Z');
  });
});

describe('review 9: a send that crosses midnight counts on the day it went out', () => {
  it('reserved 23:59:50, sent 00:00:10 -> counts today; max-one policy refuses the next', async () => {
    await db.query(`update creator_settings set daily_max_sends = 1, timezone = 'UTC' where creator_id = $1`, [s.creatorId]);
    await db.query(
      `insert into autopilot_sends (creator_id, client_id, version_id, status, amount_cents, expires_at, created_at, sent_at)
       values ($1, $2, $3, 'sent', 100, '2026-11-03T00:14:50Z', '2026-11-02T23:59:50Z', '2026-11-03T00:00:10Z')`,
      [s.creatorId, s.clientId, s.v1Id]);
    const v = await pending(await demoDm());
    const ev = await evaluate(db, v.id, { mode: 'autopilot', now: new Date('2026-11-03T00:05:00Z') });
    if (!ev.ok) throw new Error(ev.error);
    expect(ev.policy.results.find((r) => r.rule === 'R3')).toMatchObject({ pass: false, code: 'daily_max_reached:1' });
    expect(ev.reservationId).toBeNull();
  });

  it('markSent stamps sent_at on the reservation', async () => {
    const id = await demoDm();
    await runAutopilot(db, pp.api, id);
    const [row] = await db.query<{ status: string; sent_at: Date | null }>(`select status, sent_at from autopilot_sends where version_id = $1 and status = 'sent'`, [(await view(id)).version!.id]);
    expect(row!.sent_at).toBeInstanceOf(Date);
  });
});

describe('review 10: rejecting a stale Ask me card never rejects the newer quote', () => {
  it('POST /api/ask reject with a superseded versionId -> 409 stale; the current quote stays pending', async () => {
    const id = await paste('billboard', T.BILLBOARD, morningPour);
    await runAutopilot(db, pp.api, id);
    const stale = (await view(id)).version!;
    const kept = (await view(id)).checks!.kept.map((k) => ({ optionId: k.optionId, quote: k.quote }));
    expect((await editBrief(db, s.creatorId, id, { uses: kept })).ok).toBe(true);
    expect(await runAutopilot(db, pp.api, id)).toMatchObject({ action: 'needs_approval' });
    const current = (await view(id)).version!;
    expect(current.id).not.toBe(stale.id);

    const res = await askPOST(post('/api/ask', { versionId: stale.id, action: 'reject' }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'stale' });
    const [c] = await db.query(`select status from licence_versions where id = $1`, [current.id]);
    expect(c).toEqual({ status: 'pending' });

    const ok = await askPOST(post('/api/ask', { versionId: current.id, action: 'reject' }));
    expect(ok.status).toBe(200);
    expect((await view(id)).status).toBe('rejected');
  });
});

describe('review 11: an old rejection does not hide a new extraction', () => {
  it('reject billboard, then edit the uses to none -> the new state shows, not Rejected', async () => {
    const id = await paste('billboard', T.BILLBOARD, morningPour);
    await runAutopilot(db, pp.api, id);
    await reject(db, s.creatorId, id);
    expect((await view(id)).status).toBe('rejected');
    expect((await editBrief(db, s.creatorId, id, { uses: [] })).ok).toBe(true);
    const after = await view(id);
    expect(after.status).not.toBe('rejected');
    expect(after.status).toBe(after.extraction!.status);
    expect(after.reasons).toEqual(after.extraction!.reasons);
    expect(after.reasons.length).toBeGreaterThan(0);
  });
});

describe('review 12: the transcript route alone invoices the $420 deal', () => {
  it('one POST /api/briefs/:id/transcript -> invoiced, one PayPal send, no manual runAutopilot', async () => {
    const id = await demoScreenshot();
    const res = await transcriptPOST(post(`/api/briefs/${id}/transcript`, T.DEMO_DM), ctx(id));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ briefId: id, autopilot: 'sent' });
    expect(pp.count('create')).toBe(1);
    expect(pp.count('send')).toBe(1);
    const v = await view(id);
    expect(v).toMatchObject({ status: 'invoiced', version: { totalCents: 42000, sendState: 'sent' } });
  });
});

// ---------------------------------------------------------------- review

describe('review 1: a send that went out is never cancelled', () => {
  it('send answers 500 but PayPal shows it sent -> marked sent, draft not deleted', async () => {
    const id = await demoDm();
    pp.failNext('send', 'applied-then-500');
    expect(await runAutopilot(db, pp.api, id)).toMatchObject({ action: 'sent' });
    expect(pp.count('remove')).toBe(0);
    const v = (await view(id)).version!;
    expect(await invoicesFor(v.id)).toEqual([expect.objectContaining({ state: 'sent' })]);
    expect(await sendsFor(v.id)).toEqual([{ status: 'sent' }]);
  });

  it('send fails and the draft cannot be deleted -> row held (not cancelled), reservation kept; Retry sends the same invoice', async () => {
    const id = await demoDm();
    pp.failNext('send', 500);
    pp.failNext('remove', 500);
    expect(await runAutopilot(db, pp.api, id)).toMatchObject({ action: 'failed' });
    const v = (await view(id)).version!;
    expect(await invoicesFor(v.id)).toEqual([expect.objectContaining({ state: 'created' })]);
    expect(await sendsFor(v.id)).toEqual([{ status: 'reserved' }]);
    expect((await view(id)).status).toBe('failed');

    // review 4: even past expiry, the sweep keeps a reservation whose invoice may be live.
    await db.query(`update autopilot_sends set expires_at = now() - interval '1 minute' where version_id = $1`, [v.id]);
    expect(await retry(db, pp.api, s.creatorId, id)).toMatchObject({ ok: true });
    expect(pp.count('create')).toBe(1);
    const rows = await invoicesFor(v.id);
    expect(rows).toEqual([expect.objectContaining({ state: 'sent', invoice_number: invoiceNumberFor(v.id) })]);
    expect(await sendsFor(v.id)).toEqual([{ status: 'sent' }]);
  });
});

describe('review 2: cancel never races a send', () => {
  it('cancel while the version is sending -> 409, no PayPal call', async () => {
    const id = await demoDm();
    await runAutopilot(db, pp.api, id);
    const v = (await view(id)).version!;
    await db.query(`update licence_versions set send_state = 'sending' where id = $1`, [v.id]);
    pp.reset();
    expect(await cancelAndRequote(db, pp.api, s.creatorId, id)).toMatchObject({ ok: false, status: 409 });
    expect(pp.calls).toHaveLength(0);
    await db.query(`update licence_versions set send_state = 'sent' where id = $1`, [v.id]);
  });
});

describe('review 4, 5: abandoned or ambiguous attempts are reconciled before a new number', () => {
  it('a fresh in-flight row -> busy; the same row older than 2 minutes with nothing at PayPal -> cleared, Retry uses attempt 1', async () => {
    const id = await demoDm();
    const v = await pending(id);
    await evaluate(db, v.id, { mode: 'autopilot' });
    await db.query(`insert into invoices (creator_id, version_id, invoice_number, state) values ($1, $2, $3, 'creating')`, [s.creatorId, v.id, invoiceNumberFor(v.id)]);
    await db.query(`update licence_versions set send_state = 'sending' where id = $1`, [v.id]);
    expect(await sendInvoice(db, pp.api, v.id)).toMatchObject({ ok: false, code: 'sending' });

    await db.query(`update invoices set created_at = $1 where version_id = $2`, [new Date(Date.now() - STALE_SEND_MS - 1000), v.id]);
    expect(await sendInvoice(db, pp.api, v.id)).toMatchObject({ ok: false, code: 'reconciled_missing' });
    expect(pp.count('findByNumber')).toBe(1);
    expect(pp.count('create')).toBe(0);
    expect(await retry(db, pp.api, s.creatorId, id)).toMatchObject({ ok: true, invoiceNumber: invoiceNumberFor(v.id, 1) });
  });

  it('create times out and search finds nothing -> held under the same number; Retry searches again first', async () => {
    const id = await demoDm();
    pp.failNext('create', 'timeout');
    expect(await runAutopilot(db, pp.api, id)).toMatchObject({ action: 'failed' });
    const v = (await view(id)).version!;
    expect(await invoicesFor(v.id)).toEqual([expect.objectContaining({ state: 'creating', invoice_number: invoiceNumberFor(v.id) })]);
    expect(await sendsFor(v.id)).toEqual([{ status: 'reserved' }]);

    pp.reset();
    expect(await retry(db, pp.api, s.creatorId, id)).toMatchObject({ ok: false, code: 'reconciled_missing' });
    expect(pp.calls.map((c) => c.op)).toEqual(['findByNumber']);
    expect(await retry(db, pp.api, s.creatorId, id)).toMatchObject({ ok: true, invoiceNumber: invoiceNumberFor(v.id, 1) });
  });
});

describe('review 6: retry numbers never collide with attempt 0 and never wrap', () => {
  it('skips the suffix equal to attempt 0\'s own last two hex digits', () => {
    const id = 'aaaaaaaa-bbbb-4ccc-8ddd-05eeffffffff';
    expect(invoiceNumberFor(id)).toBe('UR-aaaaaaaabbbb4ccc8ddd05');
    const all = new Set([invoiceNumberFor(id)]);
    for (let k = 1; k <= MAX_INVOICE_ATTEMPTS; k++) all.add(invoiceNumberFor(id, k));
    expect(all.size).toBe(MAX_INVOICE_ATTEMPTS + 1);
    for (const n of all) expect(n).toHaveLength(25);
    expect(invoiceNumberFor(id, 4)).toBe('UR-aaaaaaaabbbb4ccc8ddd04');
    expect(invoiceNumberFor(id, 5)).toBe('UR-aaaaaaaabbbb4ccc8ddd06');
    expect(() => invoiceNumberFor(id, MAX_INVOICE_ATTEMPTS + 1)).toThrow(/too many/);
  });
});

describe('review 7: only PayPal\'s two hosts; live needs PAYPAL_ENV=live', () => {
  const keys = { MY_CLIENT_ID: 'a', MY_PAYPAL_SECRET: 'b' };
  it.each([
    ['https://api-m.paypal.com', {}],
    ['https://api-m.sandbox.paypal.com.evil.example', {}],
    ['http://api-m.sandbox.paypal.com', {}],
    ['https://api-m.sandbox.paypal.com/v1', {}],
    ['not a url', {}],
  ])('PAYPAL_BASE=%s is refused', (base, extra) => {
    expect(() => paypalCredentials(env({ ...keys, PAYPAL_BASE: base, ...extra }))).toThrow(PayPalHostError);
  });
  it('sandbox by default; live only with PAYPAL_ENV=live', () => {
    expect(paypalCredentials(env(keys))).toMatchObject({ base: 'https://api-m.sandbox.paypal.com', sandbox: true });
    expect(paypalCredentials(env({ ...keys, PAYPAL_BASE: 'https://api-m.paypal.com', PAYPAL_ENV: 'live' }))).toMatchObject({ base: 'https://api-m.paypal.com', sandbox: false });
  });
});

describe('review 8: the recipient is saved on the invoice row', () => {
  it('recipient_email is the client email read under the lock', async () => {
    const id = await demoDm();
    await runAutopilot(db, pp.api, id);
    const v = (await view(id)).version!;
    expect((await invoicesFor(v.id))[0]!.recipient_email).toBe('buying@northwind.example');
    expect([...pp.invoices.values()][0]!.draft.recipientEmail).toBe('buying@northwind.example');
  });
});

describe('review 9: cancelling resets the version', () => {
  it('cancel and re-quote -> invoice cancelled, send_state idle, reservation released', async () => {
    const id = await demoDm();
    await runAutopilot(db, pp.api, id);
    const v = (await view(id)).version!;
    expect(await cancelAndRequote(db, pp.api, s.creatorId, id)).toEqual({ ok: true });
    const [lv] = await db.query(`select status, send_state from licence_versions where id = $1`, [v.id]);
    expect(lv).toEqual({ status: 'superseded', send_state: 'idle' });
    expect(await sendsFor(v.id)).toEqual([{ status: 'released' }]);
  });
});

describe('review 10: origin checks on the batch-5 routes', () => {
  it('POST /api/ask without a session -> 401', async () => {
    const res = await askPOST(new Request('http://app.test/api/ask', { method: 'POST', headers: { host: 'app.test', origin: 'http://app.test' }, body: '{}' }));
    expect(res.status).toBe(401);
  });
  it('valid cookie but Origin https://evil.example -> 403 from decide and ask', async () => {
    const id = await paste('billboard', T.BILLBOARD, morningPour);
    await runAutopilot(db, pp.api, id);
    const v = (await view(id)).version!;
    expect((await decidePOST(post(`/api/briefs/${id}/decide`, { action: 'reject' }, 'https://evil.example'), ctx(id))).status).toBe(403);
    expect((await askPOST(post('/api/ask', { versionId: v.id, action: 'reject' }, 'https://evil.example'))).status).toBe(403);
    expect((await view(id)).status).toBe('needs_approval'); // nothing changed
  });
});

describe('review 11: an existing PayPal invoice is reused only when it matches', () => {
  it('a draft under our number with another amount -> deleted, never sent', async () => {
    const id = await demoDm();
    const v = await pending(id);
    await pp.api.create({ invoiceNumber: invoiceNumberFor(v.id), recipientEmail: 'x@y.example', itemName: 'x', itemDescription: 'x', amountCents: 100, note: 'x' });
    pp.reset();
    expect(await runAutopilot(db, pp.api, id)).toMatchObject({ action: 'failed' });
    expect(pp.count('send')).toBe(0);
    expect(pp.count('remove')).toBe(1);
  });
});

describe('review 12: GET /api/ledger returns the flat rows', () => {
  it('route JSON rows carry every ledger key', async () => {
    const id = await demoDm();
    await runAutopilot(db, pp.api, id);
    const res = await ledgerGET(new Request('http://app.test/api/ledger', { headers: { host: 'app.test', cookie: `ur_creator=${TOKEN}` } }));
    expect(res.status).toBe(200);
    const { rows } = (await res.json()) as { rows: Record<string, unknown>[] };
    const mine = rows.filter((r) => r.briefId === id);
    expect(mine.length).toBeGreaterThan(0);
    const keys = ['eventId', 'kind', 'createdAt', 'briefId', 'deal', 'versionId', 'versionNo', 'scope', 'rule', 'result', 'message', 'paypalInvoiceId', 'invoiceNumber', 'paypalTxnId', 'amountCents', 'label', 'status', 'expiry', 'renewalDate', 'demo'];
    for (const r of mine) expect(Object.keys(r).sort()).toEqual([...keys].sort());
    expect(mine.find((r) => r.kind === 'invoice.sent')).toMatchObject({ result: 'pass', status: 'sent', deal: 'Northwind Coffee · Morning Pour' });
  });
});


// ---------------------------------------------------------------- review re-check of 4df8541

describe('review re-check: unresolved sends', () => {
  /** A's invoice went out at PayPal, but the answer and the read after it failed: the row is held, not cancelled. */
  async function heldDeal() {
    const id = await demoDm();
    pp.failNext('get', 'pass'); // read-back before send
    pp.failNext('send', 'applied-then-500');
    pp.failNext('get', 500); // the read that would have shown SENT
    expect(await runAutopilot(db, pp.api, id)).toMatchObject({ action: 'failed' });
    const v = (await view(id)).version!;
    expect(await invoicesFor(v.id)).toEqual([expect.objectContaining({ state: 'created' })]);
    return { id, v, paypalId: [...pp.invoices.values()].find((i) => i.invoiceNumber === invoiceNumberFor(v.id))!.id };
  }

  it('1: an expired reservation whose invoice may be live still fills the daily max; a second deal is not sent', async () => {
    await db.query(`update creator_settings set daily_max_sends = 1 where creator_id = $1`, [s.creatorId]);
    const a = await heldDeal();
    await db.query(`update autopilot_sends set expires_at = now() - interval '1 minute' where version_id = $1`, [a.v.id]);
    const b = await demoDm();
    expect(await runAutopilot(db, pp.api, b)).toMatchObject({ action: 'needs_approval' });
    expect((await view(b)).version!.policy!.results.find((r) => r.rule === 'R3')).toMatchObject({ pass: false, code: 'daily_max_reached:1' });
    expect(pp.count('create')).toBe(1);
  });

  it('2: a recovery is claimed under the lock: cancel during it is refused, and a row cancelled meanwhile stays cancelled', async () => {
    const a = await heldDeal();
    let reached!: () => void;
    let release!: () => void;
    const atGet = new Promise<void>((r) => { reached = r; });
    const gate = new Promise<void>((r) => { release = r; });
    const paused = { ...pp.api, get: async (pid: string) => { reached(); await gate; return pp.api.get(pid); } };

    const recovery = retry(db, paused, s.creatorId, a.id);
    await atGet;
    expect(await cancelAndRequote(db, pp.api, s.creatorId, a.id)).toMatchObject({ ok: false, status: 409 });
    // Something else (e.g. PayPal's CANCELLED webhook) cancels the row while recovery is waiting on PayPal.
    const [row] = await db.query<{ id: string }>(`select id from invoices where version_id = $1`, [a.v.id]);
    await db.transaction((tx) => markInvoiceCancelled(tx, row!.id, { supersede: true }));
    release();
    expect(await recovery).toMatchObject({ ok: false, code: 'cancelled_meanwhile' });
    expect(await invoicesFor(a.v.id)).toEqual([expect.objectContaining({ state: 'cancelled' })]);
    expect(pp.count('send')).toBe(1);
  });

  it('2: a second Retry while the first recovery is in flight is told it is busy', async () => {
    const a = await heldDeal();
    let release!: () => void;
    let reached!: () => void;
    const atGet = new Promise<void>((r) => { reached = r; });
    const gate = new Promise<void>((r) => { release = r; });
    const paused = { ...pp.api, get: async (pid: string) => { reached(); await gate; return pp.api.get(pid); } };
    const first = retry(db, paused, s.creatorId, a.id);
    await atGet;
    expect(await sendInvoice(db, pp.api, a.v.id)).toMatchObject({ ok: false, code: 'sending' });
    release();
    expect(await first).toMatchObject({ ok: true });
    expect(await invoicesFor(a.v.id)).toEqual([expect.objectContaining({ state: 'sent' })]);
  });

  it('3: recovery finds a SENT invoice with the wrong amount -> held for review, never recorded as sent', async () => {
    const a = await heldDeal();
    pp.invoices.get(a.paypalId)!.amountValue = '1.00';
    const r = await retry(db, pp.api, s.creatorId, a.id);
    expect(r).toMatchObject({ ok: false, code: 'send_unresolved' });
    expect(await invoicesFor(a.v.id)).toEqual([expect.objectContaining({ state: 'created' })]);
    const v = (await view(a.id)).version!;
    expect(v.sendState).toBe('failed');
    expect(v.sendError).toMatch(/different amount or currency/);
    expect(await sendsFor(a.v.id)).toEqual([{ status: 'reserved' }]);
  });
});
