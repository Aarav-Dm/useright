import { demoMode } from '@/lib/clock';
import { runTick } from '@/lib/renewal';
import { deps, guard, invoices, json } from '@/lib/server';

export const runtime = 'nodejs';

/** Batch 8 §4: "Run tick now" from the demo panel (creator only, same-origin via guard; demo mode only). */
export async function POST(req: Request) {
  const denied = guard(req);
  if (denied) return denied;
  if (!demoMode()) return json({ error: 'the demo panel is off in live mode' }, 404);
  const { db } = await deps();
  return json({ tick: await runTick({ db, api: invoices() }) });
}
