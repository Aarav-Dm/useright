import { getSettings, putSettings } from '@/lib/settings';
import { creatorId, deps, guard, json, readJson } from '@/lib/server';

export const runtime = 'nodejs';

export async function GET(req: Request) {
  const denied = guard(req);
  if (denied) return denied;
  const { db } = await deps();
  const id = await creatorId(db);
  if (id instanceof Response) return id;
  return json(await getSettings(db, id));
}

export async function PUT(req: Request) {
  const denied = guard(req);
  if (denied) return denied;
  const body = await readJson(req);
  if (body instanceof Response) return body;
  const { db } = await deps();
  const id = await creatorId(db);
  if (id instanceof Response) return id;
  const r = await putSettings(db, id, body);
  return r.ok ? json(r.settings) : json({ error: r.error, issues: r.issues }, r.status);
}
