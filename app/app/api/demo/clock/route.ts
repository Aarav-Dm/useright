import { advanceToNextRenewal, DAY_MS, demoMode, now } from '@/lib/clock';
import { runTick, tickPending } from '@/lib/renewal';
import { creatorId, deps, guard, invoices, json } from '@/lib/server';

export const runtime = 'nodejs';

/**
 * Batch 8 §1 + plan fix 6 + review fix 6: "Advance to the next renewal" (creator only, same-origin via guard; demo
 * mode only). Moves the demo clock forward to the soonest renewal window, then runs the tick at once, so the pay page
 * and receipts never disagree with the ledger. The move commits first: if the tick then fails, the answer is still
 * 200 with `tickError`, and the panel offers "Run tick again" (POST /api/demo/tick), which never moves the clock.
 */
export async function POST(req: Request) {
  const denied = guard(req);
  if (denied) return denied;
  if (!demoMode()) return json({ error: 'the demo clock is off in live mode' }, 404);
  const { db } = await deps();
  const me = await creatorId(db);
  if (me instanceof Response) return me;
  // review B8 re-review N2: never move the clock over a tick that did not finish.
  if (await tickPending(db, me, await now(db))) return json({ error: 'The last tick did not finish. Use Run tick again first.', tickPending: true }, 409);
  const moved = await advanceToNextRenewal(db, me);
  if (!moved.ok) return json({ error: moved.error }, moved.status);
  const clock = { now: moved.now.toISOString(), offsetDays: Math.round(moved.offsetMs / DAY_MS), moved: moved.moved, days: moved.days };
  try {
    return json({ ...clock, tick: await runTick({ db, api: invoices() }) });
  } catch (err) {
    console.error('demo tick failed after the clock moved:', err instanceof Error ? err.name : 'unknown error');
    return json({ ...clock, tick: null, tickError: 'The clock moved, but the tick did not finish. Use Run tick again; it does not move the clock.' });
  }
}
