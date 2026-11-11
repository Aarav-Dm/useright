import { clearSessionCookie, sameOrigin } from '@/lib/auth';
import { json } from '@/lib/server';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  if (!sameOrigin(req)) return json({ error: 'cross-origin request refused' }, 403);
  const res = json({ ok: true });
  res.headers.append('set-cookie', clearSessionCookie);
  return res;
}
