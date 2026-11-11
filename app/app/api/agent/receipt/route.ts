// B12 D2: GET /api/agent/receipt?id=<receipt id>&sha256=<hex>. Read-only; see lib/agent-door.ts.
import { AGENT_DOOR_LIMIT_PER_HOUR, agentIp, verifyReceipt } from '@/lib/agent-door';
import { ipHashOf, rateLimit } from '@/lib/rate-limit';
import { deps, json } from '@/lib/server';

export const runtime = 'nodejs';

export async function GET(req: Request) {
  const { db } = await deps();
  const p = new URL(req.url).searchParams;
  const r = await db.transaction(async (tx) => (await rateLimit(tx, 'agent', ipHashOf(agentIp(req.headers)), AGENT_DOOR_LIMIT_PER_HOUR))
    ? verifyReceipt(tx, p.get('id'), p.get('sha256'))
    : { status: 429, body: { code: 'rate_limited', error: 'Too many requests this hour.' } });
  return json(r.body, r.status);
}
