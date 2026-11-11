import { PAY_LIMITS, previewFor } from '@/lib/pay';
import { deps, PUBLIC_HEADERS, publicJson, publicLimit } from '@/lib/server';

export const runtime = 'nodejs';

/** The watermarked preview: the only image a client sees before paying (§5). */
export async function GET(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const d = await deps();
  const limited = await publicLimit(req, d.db, 'pay_preview', PAY_LIMITS.pay_preview);
  if (limited) return limited;
  const p = await previewFor(d.db, d.uploadsDir, token);
  if (!p) return publicJson({ error: 'not found' }, 404);
  return new Response(new Uint8Array(p.bytes), { headers: { ...PUBLIC_HEADERS, 'content-type': p.type, 'x-content-type-options': 'nosniff' } });
}