import { z } from 'zod';
import { editBrief, getBriefView, InvoiceLockedError } from '@/lib/briefs';
import { autopilot, creatorId, deps, guard, json, readJson } from '@/lib/server';

export const runtime = 'nodejs';

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const denied = guard(req);
  if (denied) return denied;
  const { id } = await ctx.params;
  const { db } = await deps();
  const me = await creatorId(db);
  if (me instanceof Response) return me;
  const view = await getBriefView(db, id);
  return view && view.brief.creator_id === me ? json(view) : json({ error: 'brief not found' }, 404);
}

const EditSchema = z
  .object({
    clientId: z.string().uuid().optional(),
    assetId: z.string().uuid().optional(),
    uses: z.array(z.object({ optionId: z.string().min(1).max(64), quote: z.string().min(1).max(2000) }).strict()).max(50).optional(),
  })
  .strict()
  .refine((e) => e.clientId !== undefined || e.assetId !== undefined || e.uses !== undefined, 'nothing to change');

/** Creator edit (batch-4 fix 2): new extraction row, checks + gap re-run, no AI call. */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const denied = guard(req);
  if (denied) return denied;
  const body = await readJson(req);
  if (body instanceof Response) return body;
  const parsed = EditSchema.safeParse(body);
  if (!parsed.success) return json({ error: parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') }, 400);
  const { id } = await ctx.params;
  const { db } = await deps();
  const me = await creatorId(db);
  if (me instanceof Response) return me;
  let r;
  try {
    r = await editBrief(db, me, id, parsed.data);
  } catch (err) {
    if (err instanceof InvoiceLockedError) return json({ error: err.message }, 409);
    throw err;
  }
  if (!r.ok) return json({ error: r.error }, r.status);
  // Batch-5 fixes 11, 16: the edit superseded any old quote; a now-ready deal is quoted and checked again.
  if (r.view.extraction?.status === 'ready') {
    await autopilot(db, id);
    return json(await getBriefView(db, id));
  }
  return json(r.view);
}
