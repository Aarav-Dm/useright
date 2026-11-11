import { PAY_LIMITS, payView } from '@/lib/pay';
import { deps, publicJson, publicLimit } from '@/lib/server';

export const runtime = 'nodejs';

/** Client pay page read model (batch-6 §3). Reads our database only; the 3 s poll hits this. */
export async function GET(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const { db } = await deps();
  const limited = await publicLimit(req, db, 'pay_read', PAY_LIMITS.pay_read);
  if (limited) return limited;
  const view = await payView(db, token);
  return view ? publicJson(view) : publicJson({ error: 'This payment link is not valid.' }, 404);
}