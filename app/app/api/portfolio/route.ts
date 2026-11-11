import { sessionCreatorSlug } from '@/lib/auth';
import { listPaidVersions } from '@/lib/overview';
import { manifestPhotoFor } from '@/lib/portfolio';
import { creatorId, deps, guard, json } from '@/lib/server';

export const runtime = 'nodejs';

/**
 * Batch 7 (read-only): the creator's photos for the Portfolio dashboard, in upload order. `isPublic` is the
 * asset's flag (eligible); `onPublicPage` is whether /c/<slug> actually shows it as a tile with this asset id
 * (public and matched to a manifest photo, the same join that page uses). No storage key or paid rendition.
 * Batch 7C: per photo, how often it was licensed, how many licences are active, and what was earned, with seeded
 * payments (SEED-...) counted apart. review B7C-2 finding 2: the money comes from `listPaidVersions`, the same rows the
 * Overview totals use, so the photos add up to the Overview's Earned. Read only.
 */
export async function GET(req: Request) {
  const denied = guard(req);
  if (denied) return denied;
  const { db } = await deps();
  const id = await creatorId(db);
  if (id instanceof Response) return id;
  const slug = sessionCreatorSlug();
  const rows = await db.query<{ id: string; title: string; is_public: boolean; created_at: Date }>(
    `select id, title, is_public, created_at from assets where creator_id = $1 order by created_at`, [id]);
  const byAsset = new Map<string, { licensed: number; active: number; earnedLive: number; earnedDemo: number }>();
  for (const p of await listPaidVersions(db, id)) {
    const s = byAsset.get(p.assetId) ?? { licensed: 0, active: 0, earnedLive: 0, earnedDemo: 0 };
    s.licensed += 1; // a paid version (a cancelled or withdrawn quote is not a licence)
    if (p.status === 'active') s.active += 1;
    if (!p.refunded) { if (p.demo) s.earnedDemo += p.amountCents; else s.earnedLive += p.amountCents; }
    byAsset.set(p.assetId, s);
  }
  const assets = rows.map((r) => {
    const photo = manifestPhotoFor(r.title);
    const s = byAsset.get(r.id);
    return {
      id: r.id, title: r.title, isPublic: r.is_public, onPublicPage: r.is_public && photo !== null, createdAt: r.created_at, photo,
      licensed: s?.licensed ?? 0, activeLicences: s?.active ?? 0, earnedLiveCents: s?.earnedLive ?? 0, earnedDemoCents: s?.earnedDemo ?? 0,
    };
  });
  return json({ creatorSlug: slug, publicPath: `/c/${slug}`, assets });
}
