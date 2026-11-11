import { getOverview } from '@/lib/overview';
import { creatorId, deps, guard, json } from '@/lib/server';

export const runtime = 'nodejs';

/** Batch 7C (read only): totals, waiting items, unpaid invoices, recent activity and receipt ids for the overview. */
export async function GET(req: Request) {
  const denied = guard(req);
  if (denied) return denied;
  const { db } = await deps();
  const id = await creatorId(db);
  if (id instanceof Response) return id;
  return json(await getOverview(db, id));
}
