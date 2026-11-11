import { sameOrigin } from '@/lib/auth';
import { verifyEmail } from '@/lib/intake';
import { autopilot, deps, json } from '@/lib/server';
import { confirmPage, html, resultPage, TOKEN_RE } from '@/lib/verify-page';

export const runtime = 'nodejs';

/** Shows a confirm button only. Never touches the token (code-review fix 4). */
export async function GET(_req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  return html(confirmPage(token), TOKEN_RE.test(token) ? 200 : 400);
}

/** Uses the token. Same-origin only, so another site cannot submit it on the requester's behalf. */
export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const wantsHtml = (req.headers.get('content-type') ?? '').includes('application/x-www-form-urlencoded');
  if (!sameOrigin(req)) {
    return wantsHtml ? html(resultPage(false, 'This request did not come from this site.'), 403) : json({ error: 'cross-origin request refused' }, 403);
  }
  const { token } = await ctx.params;
  const d = await deps();
  const result = await verifyEmail(d, token);
  if (!result.ok) return wantsHtml ? html(resultPage(false, `This link cannot be used: ${result.error}.`), result.status) : json({ error: result.error }, result.status);
  // Batch-5 fix 11. Verify creates clients allowed=false, so R1 sends these to Ask me rather than PayPal.
  if (result.extraction?.status === 'ready') await autopilot(d.db, result.briefId);
  // The requester learns only that the email is confirmed, not the extraction.
  return wantsHtml
    ? html(resultPage(true, 'Thank you. The photographer will reply to this address.'))
    : json({ verified: true, briefId: result.briefId });
}
