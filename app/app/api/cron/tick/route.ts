import { cronAuth, runTick } from '@/lib/renewal';
import { deps, invoices, json } from '@/lib/server';

export const runtime = 'nodejs';

/**
 * Batch 8 §3: the daily renewal and expiry tick, called by an external pinger with the `x-cron-secret` header
 * (docs/RUNBOOK.md). Missing CRON_SECRET = 503, wrong secret = 401. Idempotent.
 */
export async function POST(req: Request) {
  const auth = cronAuth(req);
  if (!auth.ok) return json({ error: auth.error }, auth.status);
  const { db } = await deps();
  return json(await runTick({ db, api: invoices() }));
}
