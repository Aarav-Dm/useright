import { consumeDownload, PAY_LIMITS } from '@/lib/pay';
import { deps, PUBLIC_HEADERS, publicJson, publicLimit } from '@/lib/server';

export const runtime = 'nodejs';

async function serve(req: Request, token: string, head: boolean) {
  const d = await deps();
  const limited = await publicLimit(req, d.db, 'download_serve', PAY_LIMITS.download_serve);
  if (limited) return limited;
  const r = await consumeDownload(d.db, d.uploadsDir, token, { head });
  if (!r.ok) return publicJson({ error: r.error }, r.status);
  const headers = { ...PUBLIC_HEADERS, 'content-type': r.type, 'content-disposition': `attachment; filename="${r.filename}"`, 'x-content-type-options': 'nosniff' };
  return head ? new Response(null, { headers }) : new Response(new Uint8Array(r.bytes!), { headers });
}

/** Licensed file download (§5, fixes 11, 12, 22): streamed from private storage, 3 uses in 5 minutes. */
export async function GET(req: Request, ctx: { params: Promise<{ token: string }> }) {
  return serve(req, (await ctx.params).token, false);
}

/** HEAD does not use up the link (fix 12). */
export async function HEAD(req: Request, ctx: { params: Promise<{ token: string }> }) {
  return serve(req, (await ctx.params).token, true);
}