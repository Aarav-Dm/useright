import { sameOrigin, sessionCookie, tokenMatches } from '@/lib/auth';
import { json, readJson } from '@/lib/server';

export const runtime = 'nodejs';

/** Exchanges the CREATOR_TOKEN for an httpOnly session cookie (batch-4 fix 5). */
export async function POST(req: Request) {
  if (!sameOrigin(req)) return json({ error: 'cross-origin request refused' }, 403);
  const body = await readJson(req);
  if (body instanceof Response) return body;
  const token = (body as { token?: unknown } | null)?.token;
  if (typeof token !== 'string' || !tokenMatches(token)) return json({ error: 'wrong token' }, 401);
  const res = json({ ok: true });
  res.headers.append('set-cookie', sessionCookie(token, new URL(req.url).protocol === 'https:'));
  return res;
}
