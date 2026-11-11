import { extname } from 'node:path';
import { deps, guard, json, ownedBrief } from '@/lib/server';
import { readUpload } from '@/lib/storage';

export const runtime = 'nodejs';

const TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp' };

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const denied = guard(req);
  if (denied) return denied;
  const { id } = await ctx.params;
  const { db, uploadsDir } = await deps();
  const brief = await ownedBrief(db, id);
  if (brief instanceof Response) return brief;
  if (!brief.upload_path) return json({ error: 'no image' }, 404);
  const bytes = await readUpload(uploadsDir, brief.upload_path); // written by intake, never taken from the request
  if (!bytes) return json({ error: 'no image' }, 404);
  return new Response(new Uint8Array(bytes), {
    headers: { 'content-type': TYPES[extname(brief.upload_path)] ?? 'application/octet-stream', 'cache-control': 'private, no-store' },
  });
}
