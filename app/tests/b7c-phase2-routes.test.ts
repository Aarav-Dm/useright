// Batch 7C phase 2: the new read-only GET /api/overview and the per-photo counts on GET /api/portfolio, through the
// real route handlers on the demo seed.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GET as overviewGET } from '@/app/api/overview/route';
import { GET as portfolioGET } from '@/app/api/portfolio/route';
import { openPglite, type Db } from '../db/client';
import { initialize } from '../db/init';
import type { Overview } from '../lib/overview';
import { setRouteDepsForTests } from '../lib/server';

const TOKEN = 'b7c-phase2-routes-token';
let db: Db;
let dir: string;
const saved = { token: process.env.CREATOR_TOKEN, origin: process.env.APP_ORIGIN };
const authed = (path: string) => new Request(`http://app.test${path}`, { headers: { host: 'app.test', cookie: `ur_creator=${TOKEN}` } });

beforeAll(async () => {
  db = await openPglite();
  dir = await mkdtemp(join(tmpdir(), 'ur-b7c2-'));
  await initialize(db, dir);
  process.env.CREATOR_TOKEN = TOKEN;
  delete process.env.APP_ORIGIN;
  setRouteDepsForTests({ db, uploadsDir: dir });
});
afterAll(async () => {
  setRouteDepsForTests(null);
  if (saved.token === undefined) delete process.env.CREATOR_TOKEN; else process.env.CREATOR_TOKEN = saved.token;
  if (saved.origin !== undefined) process.env.APP_ORIGIN = saved.origin;
  await db?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe('GET /api/overview', () => {
  it('needs the creator session', async () => {
    expect((await overviewGET(new Request('http://app.test/api/overview'))).status).toBe(401);
  });

  it('keeps seeded demo money apart, counts a refunded payment only as refunded, and links receipts', async () => {
    const res = await overviewGET(authed('/api/overview'));
    expect(res.status).toBe(200);
    const o = await res.json() as Overview;
    // Demo seed: Quayside $400, Northwind's base v1 $300 (SEED-V1) and Pinecrest Harbor Light $300 (B8 fix 8) kept,
    // Riverbend $300 paid then refunded, Pinecrest $400 invoiced and unpaid. review B7C-2 finding 2: earned comes from payments.
    expect(o.totals.earned).toEqual({ liveCents: 0, demoCents: 100000, liveCount: 0, demoCount: 3 });
    expect(o.totals.refunded).toEqual({ liveCents: 0, demoCents: 30000, liveCount: 0, demoCount: 1 });
    expect(o.totals.revokedKept).toEqual({ liveCents: 0, demoCents: 0, liveCount: 0, demoCount: 0 });
    expect(o.totals.pending).toEqual({ liveCents: 0, demoCents: 40000, liveCount: 0, demoCount: 1 });
    // B12 E6: seeded deals count apart in the headline and add no money to it.
    expect(o.headline).toMatchObject({ caught: 0, invoicedCents: 0, recoveredCents: 0 });
    expect(o.headline.caughtDemo).toBeGreaterThan(0);
    expect(o.unpaid.map((d) => d.asset?.title)).toEqual(['Vineyard Harvest']);
    expect(o.waiting).toEqual({ approvals: 1, blocked: 0, blockedBriefId: null, checks: 1, failed: 0 });
    expect(o.alertsShown).toBe(1);
    expect(o.partlyRefunded).toBe(0);
    expect(o.recent.length).toBeGreaterThan(0);
    // review B7C-2 finding 3: each version maps its grant receipt and, once refunded, its revocation receipt.
    const kindOf = async (publicId: string) => (await db.query<{ kind: string }>(`select coalesce(body->>'kind', 'grant') as kind from receipts where public_id = $1`, [publicId]))[0]?.kind;
    const entries = Object.values(o.receipts);
    expect(entries.length).toBeGreaterThanOrEqual(2);
    for (const e of entries) {
      if (e.grant) expect(await kindOf(e.grant)).toBe('grant');
      if (e.revocation) expect(await kindOf(e.revocation)).toBe('revocation');
    }
    const refunded = entries.filter((e) => e.revocation);
    expect(refunded).toHaveLength(1); // Riverbend
    expect(refunded[0]!.grant).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('review B7C-2 finding 2: Overview earned equals the sum of Portfolio earned on the same seed', async () => {
    const o = await (await overviewGET(authed('/api/overview'))).json() as Overview;
    const p = await (await portfolioGET(authed('/api/portfolio'))).json() as { assets: { earnedLiveCents: number; earnedDemoCents: number }[] };
    expect(p.assets.reduce((s, a) => s + a.earnedLiveCents, 0)).toBe(o.totals.earned.liveCents);
    expect(p.assets.reduce((s, a) => s + a.earnedDemoCents, 0)).toBe(o.totals.earned.demoCents);
  });
});

describe('GET /api/portfolio per-photo counts', () => {
  it('counts licences, active licences and kept earnings per photo, demo apart', async () => {
    const body = await (await portfolioGET(authed('/api/portfolio'))).json() as { assets: { title: string; licensed: number; activeLicences: number; earnedLiveCents: number; earnedDemoCents: number }[] };
    const by = Object.fromEntries(body.assets.map((a) => [a.title, a]));
    expect(by['Laptop Desk from Above']).toMatchObject({ licensed: 1, activeLicences: 1, earnedLiveCents: 0, earnedDemoCents: 40000 });
    expect(by['Rocky Beach']).toMatchObject({ licensed: 1, activeLicences: 0, earnedDemoCents: 0 }); // refunded
    expect(by['Morning Pour']).toMatchObject({ licensed: 1, activeLicences: 1, earnedDemoCents: 30000 }); // seeded Northwind v1
    expect(by['Waterfall Over Boulders']).toMatchObject({ licensed: 0, activeLicences: 0, earnedLiveCents: 0, earnedDemoCents: 0 });
  });
});

// Last: this block adds rows to the shared database.
describe('review B7C-2 finding 1: totals cover every deal and event, not the newest 200 / 500', () => {
  it('an old invoice and old payments stay in the totals after 205 newer deals and 600 newer events', async () => {
    const before = await (await overviewGET(authed('/api/overview'))).json() as Overview;
    const [{ id: creator }] = await db.query<{ id: string }>(`select id from creators limit 1`) as [{ id: string }];
    const cols = (await db.query<{ column_name: string }>(
      `select column_name from information_schema.columns where table_name = 'briefs' and column_name not in ('id', 'seq', 'created_at')`)).map((c) => c.column_name).join(', ');
    await db.query(`insert into briefs (${cols}) select ${cols} from (select * from briefs where creator_id = $1 order by created_at limit 1) b, generate_series(1, 205)`, [creator]);
    await db.query(`insert into events (creator_id, kind, rule, detail) select $1, 'rule', 'R1', '{"pass": true}'::jsonb from generate_series(1, 600)`, [creator]);
    const after = await (await overviewGET(authed('/api/overview'))).json() as Overview;
    expect(after.totals.earned).toEqual(before.totals.earned);
    expect(after.totals.refunded).toEqual(before.totals.refunded);
    expect(after.totals.pending).toEqual(before.totals.pending);
    expect(after.unpaid.map((d) => d.asset?.title)).toEqual(['Vineyard Harvest']);
  });
});
