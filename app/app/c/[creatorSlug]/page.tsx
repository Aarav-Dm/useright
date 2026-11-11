// /c/[creatorSlug]: public creator page. Server side reads the creator, its public assets and its rate card, and
// hands the client only public fields (no email, no private settings). Photos come from the placeholder manifest;
// a photo is linked to a database asset by title, otherwise it has no asset id and requests use the form source.
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ClientExperience } from '@/components/client/client-experience';
import type { PortfolioPhoto } from '@/components/client/types';
import { deps } from '@/lib/server';
import { getSettings } from '@/lib/settings';
import manifest from '@/public/portfolio/imani/photos.json';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ creatorSlug: string }> };

async function loadCreator(slug: string) {
  const { db } = await deps();
  const [creator] = await db.query<{ id: string; slug: string; name: string }>(`select id, slug, name from creators where slug = $1`, [slug]);
  return creator ? { db, creator } : null;
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const found = await loadCreator((await params).creatorSlug);
  const name = found?.creator.name ?? 'Photographer';
  return { title: `${name} · Licensed photography`, description: `License photographs by ${name}. Priced from the rate card, paid with PayPal.` };
}

export default async function CreatorPage({ params }: Params) {
  const found = await loadCreator((await params).creatorSlug);
  if (!found) notFound();
  const { db, creator } = found;
  const assets = await db.query<{ id: string; title: string }>(
    `select id, title from assets where creator_id = $1 and is_public`, [creator.id]);
  const byTitle = new Map(assets.map((a) => [a.title.trim().toLowerCase(), a.id]));
  const { rateCard } = await getSettings(db, creator.id);

  // ponytail: one placeholder manifest (imani); per-creator manifests when a second creator exists.
  const photos: PortfolioPhoto[] = manifest.photos.map((p) => ({
    assetId: byTitle.get(p.title.trim().toLowerCase()) ?? null,
    num: p.num,
    title: p.title,
    alt: p.alt,
    orientation: p.orientation === 'portrait' ? 'portrait' : 'landscape',
    width: p.width,
    height: p.height,
    src: `/portfolio/imani/${p.filename}`,
    blurDataUrl: p.blurDataUrl,
  }));

  return <ClientExperience creator={{ slug: creator.slug, name: creator.name, rateCard }} photos={photos} />;
}
