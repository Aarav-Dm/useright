import { sameOrigin } from '@/lib/auth';
import { issueDownload, PAY_LIMITS } from '@/lib/pay';
import { deps, publicJson, publicLimit } from '@/lib/server';

export const runtime = 'nodejs';

/** Issues a 5-minute, 3-use download link, only while the licence is active (§5, fix 12). */
export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  if (!sameOrigin(req)) return publicJson({ error: 'cross-origin request refused' }, 403);
  const { token } = await ctx.params;
  const { db } = await deps();
  const limited = await publicLimit(req, db, 'download_issue', PAY_LIMITS.download_issue);
  if (limited) return limited;
  const r = await issueDownload(db, token);
  return r.ok ? publicJson({ url: r.url, expiresAt: r.expiresAt }) : publicJson({ error: r.error }, r.status);
}