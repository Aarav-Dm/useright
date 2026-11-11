// Batch 7: the placeholder portfolio photos (public/portfolio/imani/photos.json) and how an asset maps to one.
// Same join as the public page /c/[creatorSlug]: a public asset is on that page when its title matches a manifest
// photo. Read-only display data; no paid rendition or storage key.
import manifest from '../public/portfolio/imani/photos.json';

export type PortfolioPhoto = { num: string; src: string; alt: string; width: number; height: number; orientation: 'portrait' | 'landscape'; blurDataUrl: string };

const norm = (title: string) => title.trim().toLowerCase();

const BY_TITLE = new Map<string, PortfolioPhoto>(manifest.photos.map((p) => [norm(p.title), {
  num: p.num, src: `/portfolio/imani/${p.filename}`, alt: p.alt, width: p.width, height: p.height,
  orientation: p.orientation === 'portrait' ? 'portrait' : 'landscape', blurDataUrl: p.blurDataUrl,
}]));

/** The manifest photo with this title, or null. One manifest (imani) until a second creator exists. */
export function manifestPhotoFor(title: string): PortfolioPhoto | null {
  return BY_TITLE.get(norm(title)) ?? null;
}

/** How many photos the public page shows (every manifest photo is a tile). */
export const PUBLIC_PAGE_PHOTO_COUNT = manifest.photos.length;
