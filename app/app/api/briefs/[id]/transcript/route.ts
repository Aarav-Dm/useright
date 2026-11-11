import { TranscriptSchema } from '@/lib/ai/types';
import { confirmTranscript, InvoiceLockedError } from '@/lib/briefs';
import { autopilot, deps, guard, json, ownedBrief, readJson } from '@/lib/server';

export const runtime = 'nodejs';

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const denied = guard(req);
  if (denied) return denied;
  const { id } = await ctx.params;
  const body = await readJson(req);
  if (body instanceof Response) return body;
  const parsed = TranscriptSchema.safeParse(body);
  if (!parsed.success) return json({ error: 'body must be {lines:[{speaker,text}]}' }, 400);
  const d = await deps();
  const brief = await ownedBrief(d.db, id);
  if (brief instanceof Response) return brief;
  if (brief.state === 'awaiting_verification') return json({ error: 'waiting for email verification' }, 409);
  let extraction;
  try {
    extraction = await confirmTranscript(d.db, d.aiFor, id, parsed.data);
  } catch (err) {
    if (err instanceof InvoiceLockedError) return json({ error: err.message }, 409);
    throw err;
  }
  const auto = extraction.status === 'ready' ? await autopilot(d.db, id) : null; // batch-5 fix 11
  return json({ briefId: id, extraction, autopilot: auto?.action ?? null });
}
