import { z } from 'zod';
import { sameOrigin } from '@/lib/auth';
import { PAY_LIMITS, payView, setRenewalOptIn } from '@/lib/pay';
import { deps, publicJson, publicLimit, readJson } from '@/lib/server';

export const runtime = 'nodejs';

const Body = z.object({ optIn: z.boolean() }).strict();

/**
 * Batch 8 §2: "Send me a renewal invoice before this licence ends". Same-origin only and rate limited like the other
 * pay page POSTs; the change is refused once the renewal invoice is out.
 */
export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  if (!sameOrigin(req)) return publicJson({ error: 'cross-origin request refused' }, 403);
  const { token } = await ctx.params;
  const { db } = await deps();
  const limited = await publicLimit(req, db, 'pay_renewal', PAY_LIMITS.pay_renewal);
  if (limited) return limited;
  const raw = await readJson(req, 1024);
  if (raw instanceof Response) return publicJson(await raw.json(), raw.status);
  const parsed = Body.safeParse(raw);
  if (!parsed.success) return publicJson({ error: 'send { "optIn": true } or { "optIn": false }' }, 400);
  const r = await setRenewalOptIn(db, token, parsed.data.optIn);
  return r.ok ? publicJson({ view: await payView(db, token) }) : publicJson({ error: r.error }, r.status);
}
