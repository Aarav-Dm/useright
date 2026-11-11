import { sameOrigin } from '@/lib/auth';
import { verifyEmail } from '@/lib/intake';
import { autopilot, deps, publicJson, publicLimit } from '@/lib/server';

export const runtime = 'nodejs';

/** Page-purpose tokens never verify email ownership; the durable brief flag forces creator approval. */
export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  if (!sameOrigin(req)) return publicJson({ error: 'cross-origin request refused' }, 403);
  const d = await deps();
  const limited = await publicLimit(req, d.db, 'page_confirm', 20);
  if (limited) return limited;
  const { token } = await ctx.params;
  const result = await verifyEmail(d, token, 'page');
  if (!result.ok) return publicJson({ error: result.error }, result.status);
  if (result.extraction?.status === 'ready') await autopilot(d.db, result.briefId);
  return publicJson({ confirmed: true, briefId: result.briefId });
}
