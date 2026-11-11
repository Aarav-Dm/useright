import { z } from 'zod';
import { currentVersion, getBriefView, loadBrief } from '@/lib/briefs';
import { recheck } from '@/lib/grant';
import { rotatePayLink } from '@/lib/pay';
import { approve, cancelAndRequote, reject, retry } from '@/lib/send';
import { creatorId, deps, grantDeps, guard, invoices, json, readJson } from '@/lib/server';

export const runtime = 'nodejs';

const ACTIONS = ['approve', 'reject', 'retry', 'cancel_requote', 'recheck', 'rotate_link'] as const;

const DecideSchema = z
  .object({
    action: z.enum(ACTIONS),
    /** The dollar text the creator typed ("900" or "900.00"); parsed with string math (batch-5 fix 20). */
    typedTotal: z.string().max(20).optional(),
  })
  .strict();

/** The creator's decision on a deal, then the updated read model. Batch 6 adds Re-check PayPal and Rotate link. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const denied = guard(req);
  if (denied) return denied;
  const body = await readJson(req);
  if (body instanceof Response) return body;
  const parsed = DecideSchema.safeParse(body);
  if (!parsed.success) return json({ error: `body must be {action: ${ACTIONS.map((a) => `"${a}"`).join('|')}, typedTotal?: "420.00"}` }, 400);
  const { id } = await ctx.params;
  const { db } = await deps();
  const me = await creatorId(db);
  if (me instanceof Response) return me;
  const { action, typedTotal } = parsed.data;

  if (action === 'recheck' || action === 'rotate_link') {
    const brief = await loadBrief(db, id);
    if (!brief || brief.creator_id !== me) return json({ error: 'deal not found' }, 404);
    if (action === 'rotate_link') {
      const r = await rotatePayLink(db, me, id);
      return r.ok ? json({ ok: true, payPath: r.path, view: await getBriefView(db, id) }) : json({ error: r.error }, r.status);
    }
    // Batch-6 §2 + fix 15: "Re-check PayPal" grants a paid invoice and revokes a refunded one.
    const v = await currentVersion(db, id);
    if (!v) return json({ error: 'there is no quote for this deal yet' }, 409);
    const r = await recheck(await grantDeps(), v.id, 'creator');
    return json({ ok: true, recheck: r, view: await getBriefView(db, id) });
  }

  const r =
    action === 'approve' ? await approve(db, invoices(), me, { briefId: id }, typedTotal ?? '')
    : action === 'reject' ? await reject(db, me, id)
    : action === 'retry' ? await retry(db, invoices(), me, id)
    : await cancelAndRequote(db, invoices(), me, id);
  if (!r.ok) return json({ error: r.error, code: 'code' in r ? r.code : undefined }, r.status);
  return json({ ok: true, view: await getBriefView(db, id) });
}