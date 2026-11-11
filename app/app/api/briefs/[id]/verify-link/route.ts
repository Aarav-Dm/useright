import { issueVerifyLink } from '@/lib/intake';
import { creatorId, deps, guard, json } from '@/lib/server';

export const runtime = 'nodejs';

/** review P1: the pending verify link is shown to the signed-in creator only (stand-in until outbound email). */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const denied = guard(req);
  if (denied) return denied;
  const { id } = await ctx.params;
  const { db } = await deps();
  const me = await creatorId(db);
  if (me instanceof Response) return me;
  const r = await issueVerifyLink(db, me, id);
  return r.ok ? json({ url: r.url, email: r.email, expiresAt: r.expiresAt }) : json({ error: r.error }, r.status);
}
