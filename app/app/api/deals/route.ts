import { listDeals } from '@/lib/deals';
import { creatorId, deps, guard, json } from '@/lib/server';

export const runtime = 'nodejs';

export async function GET(req: Request) {
  const denied = guard(req);
  if (denied) return denied;
  const { db } = await deps();
  const id = await creatorId(db);
  if (id instanceof Response) return id;
  return json({ deals: await listDeals(db, id) });
}
