import { listLedger } from '@/lib/ledger';
import { creatorId, deps, guard, json } from '@/lib/server';

export const runtime = 'nodejs';

/** Flat ledger rows (batch-5 §5, fix 9) for the AG Studio swap on Nov 7-8. */
export async function GET(req: Request) {
  const denied = guard(req);
  if (denied) return denied;
  const { db } = await deps();
  const me = await creatorId(db);
  if (me instanceof Response) return me;
  return json({ rows: await listLedger(db, me) });
}
