// Batch 8 §1: the clock renewal and expiry decisions use. Real time plus a stored demo offset (one row, default 0),
// and only in demo mode; live mode ignores the offset. Nothing else in the app changes its clock source
// (docs/batch-8.md plan fix 6: the tick, the renewal start date and the tick's policy evaluate(now) use it).
import type { Db, Queryable } from '../db/client';
import { NOT_SEEDED_DEMO_SQL } from './demo';
import { RENEWAL_WINDOW_MS, shortDate } from './format';
import { lockCreator } from './policy';

export const DAY_MS = 24 * 3600 * 1000;
export { RENEWAL_WINDOW_MS };

type Env = Record<string, string | undefined>;

/** DEMO_MODE=1 (or true) turns the demo clock and the demo panel on, never with live PayPal. Read at call time, never at import. */
export function demoMode(env: Env = process.env): boolean {
  if (env.PAYPAL_ENV === 'live') return false;
  const v = (env.DEMO_MODE ?? '').trim().toLowerCase();
  return v === '1' || v === 'true';
}

/** The stored offset in ms (0 when never moved). */
export async function clockOffset(q: Queryable): Promise<number> {
  const [r] = await q.query<{ offset_ms: string | number }>(`select offset_ms from demo_clock where id`);
  return r ? Number(r.offset_ms) : 0;
}

/** Real time, plus the demo offset only in demo mode. `real` is injectable for tests. */
export async function now(q: Queryable, env: Env = process.env, real: () => number = Date.now): Promise<Date> {
  if (!demoMode(env)) return new Date(real());
  return new Date(real() + await clockOffset(q));
}

/** B9 9.2 (review B8 finding 3): back to real time after filming. Demo mode only; one `clock` event, only if it moved. */
export async function resetClock(db: Db, creatorId: string, env: Env = process.env, real: () => number = Date.now): Promise<void> {
  if (!demoMode(env)) return;
  await db.transaction(async (tx) => {
    await lockCreator(tx, creatorId);
    if ((await clockOffset(tx)) === 0) return;
    await tx.query(`update demo_clock set offset_ms = 0, updated_at = now() where id`);
    const today = new Date(real());
    await tx.query(`insert into events (creator_id, kind, detail) values ($1, 'clock', $2)`, [
      creatorId, JSON.stringify({ days: 0, offsetMs: 0, demo: true, demoDate: today.toISOString(), message: `Demo clock reset to real time, ${shortDate(today)}.` }),
    ]);
  });
}

export type AdvanceResult =
  | { ok: true; moved: boolean; days: number; offsetMs: number; now: Date; target: Date | null }
  | { ok: false; status: 404; error: string };

/**
 * B8 review fix 6 (review 2, review 6): "Advance to the next renewal". Moves the demo clock forward to the start of the
 * renewal window (end minus 7 days) of the creator's soonest active licence that has no renewal yet; seeded
 * walkthrough licences (SEED-DEMO-, except the one seeded to renew) are never renewed, so they never set the target.
 * Forward only: when that window
 * has already opened, or no licence is waiting, nothing moves and no event is written. Demo mode only. One `clock`
 * ledger event per move, under the creator lock. The caller (the creator-guarded demo route) runs the tick next.
 */
export async function advanceToNextRenewal(db: Db, creatorId: string, env: Env = process.env, real: () => number = Date.now): Promise<AdvanceResult> {
  if (!demoMode(env)) return { ok: false, status: 404, error: 'the demo clock is off in live mode' };
  return db.transaction(async (tx) => {
    await lockCreator(tx, creatorId);
    const offset = await clockOffset(tx);
    const current = real() + offset;
    const [next] = await tx.query<{ end_at: Date | null }>(
      `select min(v.end_at) as end_at from licence_versions v
        where v.creator_id = $1 and v.status = 'active' and v.end_at is not null
          and not exists (select 1 from licence_versions c where c.renewal_of = v.id)
          and ${NOT_SEEDED_DEMO_SQL}`, [creatorId]);
    const target = next?.end_at ? new Date(next.end_at).getTime() - RENEWAL_WINDOW_MS : null;
    if (target === null || target <= current) {
      return { ok: true as const, moved: false, days: 0, offsetMs: offset, now: new Date(current), target: target === null ? null : new Date(target) };
    }
    const delta = Math.ceil(target - current);
    const [r] = await tx.query<{ offset_ms: string | number }>(
      `insert into demo_clock (id, offset_ms) values (true, $1)
       on conflict (id) do update set offset_ms = demo_clock.offset_ms + excluded.offset_ms, updated_at = now()
       returning offset_ms`, [delta]);
    const offsetMs = Number(r!.offset_ms);
    const days = Math.ceil(delta / DAY_MS);
    const demoDate = new Date(real() + offsetMs);
    await tx.query(`insert into events (creator_id, kind, detail) values ($1, 'clock', $2)`, [
      creatorId, JSON.stringify({ days, offsetMs, demo: true, demoDate: demoDate.toISOString(),
        message: `Demo clock moved forward ${days} day${days === 1 ? '' : 's'} to ${shortDate(demoDate)}, when the next renewal is due.` }),
    ]);
    return { ok: true as const, moved: true, days, offsetMs, now: demoDate, target: new Date(target) };
  });
}
