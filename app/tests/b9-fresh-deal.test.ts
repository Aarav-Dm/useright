// B9 9.2: "Start a fresh deal": creator only, demo mode only, adds one request, resets the demo clock, deletes nothing.
// review 4, review 8: an unsettled sample deal is reused, so repeat clicks send no new invoice and leave the R3 cap alone.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { POST } from '@/app/api/demo/fresh-deal/route';
import { SAMPLES } from '@/components/creator/request-samples';
import { openPglite, type Db } from '../db/client';
import { initialize } from '../db/init';
import { adapterFromEnv } from '../lib/ai/extract';
import { advanceToNextRenewal, clockOffset, demoMode, now } from '../lib/clock';
import { grantIfPaid } from '../lib/grant';
import { intake } from '../lib/intake';
import { listLedger } from '../lib/ledger';
import { cancelAndRequote } from '../lib/send';
import { autopilot, deps, setRouteDepsForTests } from '../lib/server';
import { mockInvoiceApi } from './helpers/mock-paypal';

const TOKEN = 'b9-fresh-deal-token';
const SAME_ORIGIN = { host: 'app.test', origin: 'http://app.test', cookie: `ur_creator=${TOKEN}` };
const post = (headers: Record<string, string> = SAME_ORIGIN) => POST(new Request('http://app.test/api/demo/fresh-deal', { method: 'POST', headers }));
const TABLES = ['briefs', 'licence_versions', 'invoices', 'payments', 'receipts', 'events', 'clients', 'assets'];
type Body = { briefId: string; sample: string; reused?: boolean; autopilot: string | null };

let db: Db;
let dir: string;
let creatorId: string;
let m: ReturnType<typeof mockInvoiceApi>;
let modelCalls = 0;
const saved = { token: process.env.CREATOR_TOKEN, origin: process.env.APP_ORIGIN, demo: process.env.DEMO_MODE };
const counts = async () => Object.fromEntries(await Promise.all(TABLES.map(async (t) => [t, (await db.query<{ n: number }>(`select count(*)::int as n from ${t}`))[0]!.n])));
const briefCount = async () => (await counts()).briefs!;
const click = async () => { const res = await post(); return { status: res.status, body: await res.json() as Body }; };

/** The buyer pays the deal's invoice and PayPal confirms it. */
async function payDeal(briefId: string) {
  const [v] = await db.query<{ id: string; paypal_invoice_id: string }>(
    `select v.id, i.paypal_invoice_id from licence_versions v join invoices i on i.version_id = v.id where v.brief_id = $1 and i.state = 'sent'`, [briefId]);
  m.pay(v!.paypal_invoice_id);
  expect((await grantIfPaid({ db, uploadsDir: dir, pp: m.pp }, v!.id, 'test')).granted).toBe(true);
}

/** The creator pastes one of the samples in the Add request sheet. */
async function pasteSample(key: string, runAgent = true) {
  const s = SAMPLES.find((x) => x.key === key)!;
  const [client] = await db.query<{ id: string }>(`select id from clients where lower(email) = $1`, [s.clientEmail]);
  const [asset] = await db.query<{ id: string }>(`select id from assets where title = $1`, [s.assetTitle]);
  const r = await intake(await deps(), { source: 'paste', clientId: client!.id, assetId: asset!.id, text: s.text, fixture: s.fixture }, { creator: true, sessionSlug: 'imani' });
  if (!r.ok) throw new Error(r.error);
  return { briefId: r.briefId, auto: runAgent ? await autopilot(db, r.briefId) : null };
}

beforeAll(async () => {
  process.env.PUBLIC_BASE_URL ??= 'https://useright.example';
  dir = await mkdtemp(join(tmpdir(), 'ur-b9-fresh-'));
  process.env.CREATOR_TOKEN = TOKEN;
  delete process.env.APP_ORIGIN;
});
// A fresh database per test, because each deal changes what the next click picks; the files in `dir` are kept.
beforeEach(async () => {
  process.env.DEMO_MODE = '1';
  db = await openPglite();
  creatorId = (await initialize(db, dir)).seed.creatorId;
  m = mockInvoiceApi();
  modelCalls = 0;
  setRouteDepsForTests({ db, uploadsDir: dir, invoices: m.api, aiFor: (f) => { modelCalls++; return adapterFromEnv(process.env, f ?? undefined); } });
}, 60_000);
afterEach(async () => {
  setRouteDepsForTests(null);
  await db?.close();
});
afterAll(async () => {
  for (const [k, v] of [['CREATOR_TOKEN', saved.token], ['APP_ORIGIN', saved.origin], ['DEMO_MODE', saved.demo]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe('POST /api/demo/fresh-deal', () => {
  it('refuses without the creator session, from another origin, and in live mode, and changes nothing', async () => {
    const before = await counts();
    expect((await post({ host: 'app.test', origin: 'http://app.test' })).status).toBe(401);
    expect((await post({ ...SAME_ORIGIN, origin: 'https://evil.example' })).status).toBe(403);
    process.env.DEMO_MODE = '';
    expect((await post()).status).toBe(404);
    expect(await counts()).toEqual(before);
  });

  it('adds one request, deletes nothing, keeps every existing PayPal id, and resets the demo clock once', async () => {
    expect(await advanceToNextRenewal(db, creatorId, { DEMO_MODE: '1' })).toMatchObject({ moved: true });
    expect(await clockOffset(db)).toBeGreaterThan(0);
    const before = await counts();
    const ids = async () => (await db.query<{ paypal_invoice_id: string }>(`select paypal_invoice_id from invoices order by seq`)).map((r) => r.paypal_invoice_id);
    const oldIds = await ids();
    const { status, body } = await click();
    expect(status).toBe(201);
    expect(body).toMatchObject({ sample: 'Print add-on', autopilot: 'sent' });
    expect(await clockOffset(db)).toBe(0);
    const after = await counts();
    expect(after.briefs).toBe(before.briefs! + 1);
    for (const t of TABLES) expect(after[t]).toBeGreaterThanOrEqual(before[t]!);
    expect((await ids()).slice(0, oldIds.length)).toEqual(oldIds);
    const clocks = (await listLedger(db, creatorId)).filter((r) => r.kind === 'clock');
    expect(clocks).toHaveLength(2); // the advance, then the reset
    expect(clocks.every((c) => c.demo)).toBe(true);
    expect((await db.query(`select 1 from events where kind = 'clock' and detail->>'message' like 'Demo clock reset%'`))).toHaveLength(1);
  });

  it('with the clock already at real time it adds no clock event', async () => {
    const clocks = async () => (await listLedger(db, creatorId)).filter((r) => r.kind === 'clock').length;
    const before = await clocks();
    expect((await click()).status).toBe(201);
    expect(await clocks()).toBe(before);
  });

  it('once the print add-on is paid, the next sample is used', async () => {
    const first = await click();
    await payDeal(first.body.briefId);
    expect((await click()).body).toMatchObject({ sample: 'New photo, social', autopilot: 'sent' });
  });
});

describe('PAYPAL_ENV=live turns demo mode off (security review finding 4)', () => {
  it('demoMode is false, the offset is ignored, and the route answers 404', async () => {
    expect(demoMode({ DEMO_MODE: '1' })).toBe(true);
    expect(demoMode({ DEMO_MODE: '1', PAYPAL_ENV: 'sandbox' })).toBe(true);
    expect(demoMode({ DEMO_MODE: '1', PAYPAL_ENV: 'live' })).toBe(false);
    expect(await advanceToNextRenewal(db, creatorId, { DEMO_MODE: '1' })).toMatchObject({ moved: true });
    const real = 1_000_000;
    expect((await now(db, { DEMO_MODE: '1', PAYPAL_ENV: 'live' }, () => real)).getTime()).toBe(real);
    const before = await counts();
    process.env.PAYPAL_ENV = 'live';
    try {
      expect((await post()).status).toBe(404);
    } finally {
      delete process.env.PAYPAL_ENV;
    }
    expect(await counts()).toEqual(before);
  });
});

describe('the demo clock when no request can be made (review 6)', () => {
  const offsetBefore = async () => {
    expect(await advanceToNextRenewal(db, creatorId, { DEMO_MODE: '1' })).toMatchObject({ moved: true });
    return clockOffset(db);
  };

  it('stays put when intake fails', async () => {
    const offset = await offsetBefore();
    expect(offset).toBeGreaterThan(0);
    await db.query(`create function b9_no_briefs() returns trigger language plpgsql as $$ begin raise exception 'intake is down'; end $$`);
    await db.query(`create trigger b9_no_briefs before insert on briefs for each row execute function b9_no_briefs()`);
    await expect(post()).rejects.toThrow('intake is down');
    expect(await clockOffset(db)).toBe(offset);
  });

  it('stays put when no sample can be made or reused', async () => {
    const offset = await offsetBefore();
    await db.query(`update clients set email = 'moved@northwind.example' where lower(email) = 'buying@northwind.example'`);
    const res = await post();
    expect(res.status).toBe(409);
    expect(await clockOffset(db)).toBe(offset);
  });

  it('is reset when an open deal is reused', async () => {
    await click();
    await offsetBefore();
    expect((await click()).status).toBe(200);
    expect(await clockOffset(db)).toBe(0);
  });
});

describe('repeat clicks (review 4, review 8)', () => {
  it('two clicks in a row leave one deal and one open invoice', async () => {
    const before = await briefCount();
    const a = await click();
    const b = await click();
    expect([a.status, b.status]).toEqual([201, 200]);
    expect(b.body).toMatchObject({ briefId: a.body.briefId, sample: 'Print add-on', reused: true, autopilot: null });
    expect(await briefCount()).toBe(before + 1);
    expect(m.count('create')).toBe(1);
    expect(m.count('send')).toBe(1);
    expect(modelCalls).toBe(1); // the reuse is decided before intake
  });

  // PGlite runs one connection at a time, so this covers the check-then-insert order but cannot prove the race. The
  // lock itself (lockCreator in the transaction that stores the request) has not run on real Postgres.
  it('two clicks at the same moment leave one deal and one open invoice', async () => {
    const before = await briefCount();
    const [a, b] = await Promise.all([click(), click()]);
    expect([a.status, b.status].sort()).toEqual([200, 201]);
    expect(a.body.briefId).toBe(b.body.briefId);
    expect(await briefCount()).toBe(before + 1);
    expect(m.count('create')).toBe(1);
    expect(modelCalls).toBe(1);
  });

  it('ten unpaid clicks leave one open invoice, and the next send still passes R3', async () => {
    for (let i = 0; i < 10; i++) await click();
    expect(m.count('create')).toBe(1);
    expect((await db.query(`select 1 from autopilot_sends s join licence_versions v on v.id = s.version_id where s.status in ('reserved', 'sent') and v.created_at > now() - interval '1 minute'`))).toHaveLength(1);
    const { auto } = await pasteSample('social');
    expect(auto).toMatchObject({ action: 'sent' });
  });

  it('reuses a request that has no quote yet, and runs no agent on it', async () => {
    const { briefId } = await pasteSample('print', false);
    expect((await click()).body).toMatchObject({ briefId, reused: true });
    expect(m.count('create')).toBe(0);
  });

  it('reuse touches nothing on the deal: a failed send stays for the creator, with no Retry and no new pay token', async () => {
    m.failNext('create', 500);
    const a = await click();
    expect(a.body.autopilot).toBe('failed');
    const rows = async () => db.query(`select i.id, i.state, i.pay_token_hash, v.send_state from invoices i join licence_versions v on v.id = i.version_id where v.brief_id = $1 order by i.seq`, [a.body.briefId]);
    const before = await rows();
    m.reset();
    expect((await click()).body).toMatchObject({ briefId: a.body.briefId, reused: true, autopilot: null });
    expect(m.calls).toEqual([]);
    expect(await rows()).toEqual(before);
  });

  it('never hands back a real request: only the exact sample text matches', async () => {
    const s = SAMPLES.find((x) => x.key === 'print')!;
    const [client] = await db.query<{ id: string }>(`select id from clients where lower(email) = $1`, [s.clientEmail]);
    const [asset] = await db.query<{ id: string }>(`select id from assets where title = $1`, [s.assetTitle]);
    const real = await intake(await deps(), { source: 'paste', clientId: client!.id, assetId: asset!.id, text: `${s.text} Can it run in the autumn too?`, fixture: s.fixture }, { creator: true, sessionSlug: 'imani' });
    if (!real.ok) throw new Error(real.error);
    const b = await click();
    expect(b.status).toBe(201);
    expect(b.body.briefId).not.toBe(real.briefId);
  });

  it('a stopped Paid ads deal on the same client and photo does not count: the click still makes the Harbor Light deal', async () => {
    const print = await click();
    await payDeal(print.body.briefId);
    const paid = await pasteSample('paid');
    const next = await click();
    expect(next.status).toBe(201);
    expect(next.body).toMatchObject({ sample: 'New photo, social', autopilot: 'sent' });
    expect(next.body.briefId).not.toBe(paid.briefId);
    const [v] = await db.query<{ total_cents: number }>(`select total_cents from licence_versions where brief_id = $1 and status = 'pending'`, [next.body.briefId]);
    expect(v!.total_cents).toBe(30000);
  });

  it('a fresh-deal sample waiting in Ask me counts as unsettled', async () => {
    await db.query(`update creator_settings set per_deal_cap_cents = 100`); // the print add-on now stops at R2
    const a = await click();
    expect(a.body.autopilot).toBe('needs_approval');
    expect((await click()).body).toMatchObject({ briefId: a.body.briefId, reused: true, autopilot: null });
    expect(m.count('create')).toBe(0);
  });

  it('with two open copies of a sample, the oldest wins', async () => {
    const older = await pasteSample('print', false);
    const newer = await pasteSample('print', false);
    expect(newer.briefId).not.toBe(older.briefId);
    expect((await click()).body).toMatchObject({ briefId: older.briefId, reused: true });
  });

  it('a cancelled deal is settled: the next click starts again', async () => {
    const a = await click();
    expect(await cancelAndRequote(db, m.api, creatorId, a.body.briefId)).toEqual({ ok: true });
    const b = await click();
    expect(b.status).toBe(201);
    expect(b.body.briefId).not.toBe(a.body.briefId);
  });

  it('after filming: a billboard left open does not stop the next sample, and that sample is then reused', async () => {
    const print = await click();
    await payDeal(print.body.briefId);
    const billboard = await pasteSample('billboard');
    expect(billboard.auto).toMatchObject({ action: 'needs_approval' });
    const next = await click();
    expect(next.status).toBe(201);
    expect(next.body).toMatchObject({ sample: 'New photo, social', autopilot: 'sent' });
    expect((await click()).body).toMatchObject({ briefId: next.body.briefId, reused: true });
  });
});
