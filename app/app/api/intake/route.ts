import { clientIp, requireCreator } from '@/lib/auth';
import { intake, MAX_INTAKE_BODY_BYTES } from '@/lib/intake';
import { autopilot, deps, json, readJson } from '@/lib/server';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  const body = await readJson(req, MAX_INTAKE_BODY_BYTES);
  if (body instanceof Response) return body;
  // portfolio/form are public; paste/screenshot ride the creator session, so they get the CSRF check.
  const source = (body as { source?: unknown } | null)?.source;
  const auth = requireCreator(req);
  if ((source === 'paste' || source === 'screenshot') && !auth.ok) return json({ error: auth.error }, auth.status);
  const d = await deps();
  const result = await intake(d, body, { creator: auth.ok, sessionSlug: auth.ok ? auth.slug : 'imani', ip: clientIp(req.headers) });
  if (!result.ok) return json({ error: result.error }, result.status);
  // Batch-5 fix 11: a ready paste/form deal is quoted and, if every rule passes, invoiced now. Public
  // requesters only learn the brief id; the outcome is shown to the creator.
  const auto = result.extraction?.status === 'ready' ? await autopilot(d.db, result.briefId) : null;
  return json(auth.ok ? { ...result, autopilot: auto?.action ?? null } : result, 201);
}
