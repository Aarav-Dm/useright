// B12 D2: GET /api/agent/quote?photo=<id or title>&use=social,web&territory=US&months=6. Read-only; see lib/agent-door.ts.
import { AGENT_DOOR_LIMIT_PER_HOUR, agentIp, agentQuote } from '@/lib/agent-door';
import { ipHashOf, rateLimit } from '@/lib/rate-limit';
import { creatorId, deps, json } from '@/lib/server';

export const runtime = 'nodejs';
export async function GET(req: Request) {
  const { db } = await deps();
  const id = await creatorId(db);
  if (id instanceof Response) return id;
  const p = new URL(req.url).searchParams;
  const r = await db.transaction(async (tx) => (await rateLimit(tx, 'agent', ipHashOf(agentIp(req.headers)), AGENT_DOOR_LIMIT_PER_HOUR))
    ? agentQuote(tx, id, { photo: p.get('photo'), use: p.get('use'), territory: p.get('territory'), months: p.get('months') })
    : { status: 429, body: { code: 'rate_limited', error: 'Too many requests this hour.' } });
  return json(r.body, r.status);
}
