import { resetClock, demoMode } from '@/lib/clock';
import { startFreshDeal } from '@/lib/fresh-deal';
import { autopilot, creatorId, deps, guard, json } from '@/lib/server';

export const runtime = 'nodejs';

/**
 * B9 9.2: "Start a fresh deal" (creator only, same-origin via guard; demo mode only). Puts the demo clock back to real
 * time and adds one new sample request through the normal intake, so judges start clean. Deletes nothing: the filmed
 * PayPal ids stay. Like the Add request sheet, a ready request goes to the agent, so it may send an invoice. An unsettled
 * sample deal is reused instead (200, `reused`): no new request, no agent run, no new invoice.
 */
export async function POST(req: Request) {
  const denied = guard(req);
  if (denied) return denied;
  if (!demoMode()) return json({ error: 'the demo panel is off in live mode' }, 404);
  const d = await deps();
  const me = await creatorId(d.db);
  if (me instanceof Response) return me;
  const deal = await startFreshDeal(d, me);
  if (!deal.ok) return json({ error: deal.error }, deal.status);
  // review 6: only once a request exists, so a failed click leaves the clock where it was.
  await resetClock(d.db, me);
  if (deal.reused) return json({ briefId: deal.briefId, sample: deal.label, reused: true, autopilot: null });
  const auto = deal.ready ? await autopilot(d.db, deal.briefId) : null;
  return json({ briefId: deal.briefId, sample: deal.label, autopilot: auto?.action ?? null }, 201);
}
