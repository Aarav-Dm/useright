import { sameOrigin } from '@/lib/auth';
import { PAY_PAGE_CHECK_MS, recheck } from '@/lib/grant';
import { PAY_LIMITS, payRow, payView } from '@/lib/pay';
import { grantDeps, publicJson, publicLimit } from '@/lib/server';

export const runtime = 'nodejs';

/** "I've paid, check now" / page load / focus (§2, fix 10): at most one PayPal call per invoice per 10 s. */
export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  if (!sameOrigin(req)) return publicJson({ error: 'cross-origin request refused' }, 403);
  const { token } = await ctx.params;
  const d = await grantDeps();
  const limited = await publicLimit(req, d.db, 'pay_check', PAY_LIMITS.pay_check);
  if (limited) return limited;
  const row = await payRow(d.db, token);
  if (!row) return publicJson({ error: 'This payment link is not valid.' }, 404);
  const r = await recheck(d, row.version_id, 'pay_page', PAY_PAGE_CHECK_MS);
  return publicJson({ checked: r.checked, throttled: !r.checked && r.reason === 'throttled', view: await payView(d.db, token) });
}