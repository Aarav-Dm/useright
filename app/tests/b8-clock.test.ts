// Batch 8 §1 + review fix 6: the demo clock. Real time plus a stored offset, only in demo mode; forward only, to the
// next renewal window; one ledger event per move.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openPglite, type Db } from '../db/client';
import { migrate } from '../db/migrate';
import { seed, type SeedResult } from '../db/seed';
import { advanceToNextRenewal, clockOffset, DAY_MS, demoMode, now, RENEWAL_WINDOW_MS } from '../lib/clock';
import { listLedger } from '../lib/ledger';

let db: Db;
let s: SeedResult;
const DEMO = { DEMO_MODE: '1' };
const LIVE = {};
const T0 = Date.UTC(2026, 10, 3, 12);
const real = () => T0;
let v1End: number;

beforeAll(async () => {
  db = await openPglite();
  await migrate(db);
  s = await seed(db, new Date(T0));
  v1End = (await db.query<{ end_at: Date }>(`select end_at from licence_versions where id = $1`, [s.v1Id]))[0]!.end_at.getTime();
});
afterAll(async () => { await db?.close(); });

describe('demo clock', () => {
  it('demo mode is on only for DEMO_MODE=1 or true', () => {
    expect([demoMode({}), demoMode({ DEMO_MODE: '0' }), demoMode({ DEMO_MODE: 'yes' }), demoMode({ DEMO_MODE: '1' }), demoMode({ DEMO_MODE: 'TRUE' })])
      .toEqual([false, false, false, true, true]);
  });

  it('starts at real time with no offset', async () => {
    expect(await clockOffset(db)).toBe(0);
    expect((await now(db, DEMO, real)).getTime()).toBe(T0);
  });

  it('refuses to move in live mode and writes nothing', async () => {
    expect(await advanceToNextRenewal(db, s.creatorId, LIVE, real)).toMatchObject({ ok: false, status: 404 });
    expect(await clockOffset(db)).toBe(0);
    expect((await listLedger(db, s.creatorId)).some((r) => r.kind === 'clock')).toBe(false);
  });

  it('moves to the soonest licence’s renewal window (end minus 7 days) in one step, with one clock event', async () => {
    const a = await advanceToNextRenewal(db, s.creatorId, DEMO, real);
    expect(a).toMatchObject({ ok: true, moved: true });
    expect((await now(db, DEMO, real)).getTime()).toBe(v1End - RENEWAL_WINDOW_MS);
    const days = Math.ceil((v1End - RENEWAL_WINDOW_MS - T0) / DAY_MS);
    const rows = (await listLedger(db, s.creatorId)).filter((r) => r.kind === 'clock');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ label: 'Demo clock moved', demo: true });
    expect(rows[0]!.message).toMatch(new RegExp(`^Demo clock moved forward ${days} days to .+, when the next renewal is due\\.$`));
  });

  it('forward only: inside an open window a second press moves nothing and writes no event', async () => {
    const before = await clockOffset(db);
    expect(await advanceToNextRenewal(db, s.creatorId, DEMO, real)).toMatchObject({ ok: true, moved: false, days: 0 });
    expect(await clockOffset(db)).toBe(before);
    expect((await listLedger(db, s.creatorId)).filter((r) => r.kind === 'clock')).toHaveLength(1);
  });

  it('a licence that already has its renewal sets no target', async () => {
    const [p] = await db.query<{ scope: unknown; rate_card: unknown; client_id: string; asset_id: string }>(`select scope, rate_card, client_id, asset_id from licence_versions where id = $1`, [s.v1Id]);
    await db.query(
      `insert into licence_versions (creator_id, client_id, asset_id, parent_id, renewal_of, version_no, scope, rate_card, total_cents, content_hash, status)
       values ($1, $2, $3, $4, $4, 2, $5, $6, 100, 'h', 'pending')`, [s.creatorId, p!.client_id, p!.asset_id, s.v1Id, JSON.stringify(p!.scope), JSON.stringify(p!.rate_card)]);
    const before = await clockOffset(db);
    expect(await advanceToNextRenewal(db, s.creatorId, DEMO, () => T0 - 400 * DAY_MS)).toMatchObject({ ok: true, moved: false, target: null });
    expect(await clockOffset(db)).toBe(before);
  });

  it('live mode ignores a stored offset', async () => {
    expect(await clockOffset(db)).toBeGreaterThan(0);
    expect((await now(db, LIVE, real)).getTime()).toBe(T0);
  });

  it('the database refuses a negative offset', async () => {
    await expect(db.query(`update demo_clock set offset_ms = -1`)).rejects.toThrow();
  });
});
