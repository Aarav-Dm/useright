import { OPTION_IDS } from '@/lib/ai/prompts';
import { creatorId, deps, guard, json } from '@/lib/server';
import { sessionCreatorSlug } from '@/lib/auth';

export const runtime = 'nodejs';

/** Clients, assets and option ids for the intake and deal-room pickers (the creator picks both; batch-3 fix 11). Public assets only: the one private asset is a generated gradient and must not be sold (review b9 3). */
export async function GET(req: Request) {
  const denied = guard(req);
  if (denied) return denied;
  const { db } = await deps();
  const id = await creatorId(db);
  if (id instanceof Response) return id;
  const clients = await db.query(`select id, name, email, allowed from clients where creator_id = $1 order by name`, [id]);
  const assets = await db.query(`select id, title, is_public from assets where creator_id = $1 and is_public order by title`, [id]);
  return json({ creatorSlug: sessionCreatorSlug(), clients, assets, optionIds: OPTION_IDS });
}
