import type { RateCard } from '@/lib/pricing';

/** One portfolio photo as the public page sees it. `assetId` is null when the photo has no database asset yet. */
export type PortfolioPhoto = {
  assetId: string | null;
  num: string;
  title: string;
  alt: string;
  orientation: 'landscape' | 'portrait';
  width: number;
  height: number;
  src: string;
  blurDataUrl?: string;
};

/** Public creator profile: never carries an email or other private field. */
export type PublicCreator = {
  slug: string;
  name: string;
  rateCard: RateCard;
};
