import { clockOffset, DAY_MS, demoMode, now } from '@/lib/clock';
import { tickPending } from '@/lib/renewal';
import { creatorId, deps, guard, json } from '@/lib/server';

export const runtime = 'nodejs';

/** Batch 8 §4: the demo panel's clock (creator only). 404 in live mode, so the panel stays hidden there. */
export async function GET(req: Request) {
  const denied = guard(req);
  if (denied) return denied;
  if (!demoMode()) return json({ error: 'the demo panel is off in live mode' }, 404);
  const { db } = await deps();
  const me = await creatorId(db);
  if (me instanceof Response) return me;
  const offset = await clockOffset(db);
  const at = await now(db);
  return json({ demoMode: true, now: at.toISOString(), offsetDays: Math.round(offset / DAY_MS), tickPending: await tickPending(db, me, at) });
}
