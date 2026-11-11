// Pricing (spec §3.2, batch-2 §2). Money is integer cents everywhere.
// Option ids are the bare option names, so a rate card is a flat map and
// `rate_card_options.option_id` / `licence_versions.rate_card` store the same keys.

export const CHANNELS = ['social', 'web', 'print', 'billboard', 'OOH', 'TV'] as const;
export const TERRITORIES = ['US', 'NA', 'WORLD'] as const; // ordered: US < NA < WORLD
export const DURATIONS = [6, 12] as const;

export type Channel = (typeof CHANNELS)[number];
export type Territory = (typeof TERRITORIES)[number];
export type DurationMonths = (typeof DURATIONS)[number];
export type DurationOptionId = `${DurationMonths}mo`;

export type Scope = {
  channels: Channel[];
  territory: Territory;
  durationMonths: DurationMonths;
  exclusive: boolean;
};

/** Options that carry a price. `exclusive` is ask-only and never priced. */
export type PricedOptionId = Channel | Territory | DurationOptionId;
export type OptionId = PricedOptionId | 'exclusive';
export type OptionKind = 'channel' | 'territory' | 'duration';

export type RateCard = Readonly<Record<PricedOptionId, number>>;

export type PriceLine = { optionId: string; cents: number };
export type Price = { lines: PriceLine[]; totalCents: number };

export const DEFAULT_CARD: RateCard = Object.freeze({
  social: 15000,
  web: 10000,
  print: 42000,
  billboard: 90000,
  OOH: 90000,
  TV: 150000,
  US: 0,
  NA: 10000,
  WORLD: 30000,
  '6mo': 15000,
  '12mo': 30000,
});

export function optionKind(id: PricedOptionId): OptionKind {
  if ((CHANNELS as readonly string[]).includes(id)) return 'channel';
  if ((TERRITORIES as readonly string[]).includes(id)) return 'territory';
  return 'duration';
}

export function durationOptionId(months: DurationMonths): DurationOptionId {
  return `${months}mo`;
}

/** Option ids a scope consists of, in canonical order (channels, territory, duration, exclusive). */
export function scopeOptionIds(scope: Scope): OptionId[] {
  const ids: OptionId[] = CHANNELS.filter((c) => scope.channels.includes(c));
  ids.push(scope.territory, durationOptionId(scope.durationMonths));
  if (scope.exclusive) ids.push('exclusive');
  return ids;
}

function cardCents(card: RateCard, id: PricedOptionId): number {
  const cents = card[id];
  if (!Number.isSafeInteger(cents) || cents < 0) {
    throw new Error(`rate card has no valid price for option "${id}"`);
  }
  return cents;
}

/** Sum of channel options + territory option + duration option. Lines always sum to the total. */
export function price(scope: Scope, card: RateCard): Price {
  const lines: PriceLine[] = [];
  for (const id of scopeOptionIds(scope)) {
    if (id === 'exclusive') continue; // ask-only, unpriced
    lines.push({ optionId: id, cents: cardCents(card, id) });
  }
  const totalCents = lines.reduce((sum, l) => sum + l.cents, 0);
  return { lines, totalCents };
}

/** Union of channels, higher territory, longer duration, exclusive OR. */
export function combine(a: Scope, b: Scope): Scope {
  const territoryRank = (t: Territory) => TERRITORIES.indexOf(t);
  return {
    channels: CHANNELS.filter((c) => a.channels.includes(c) || b.channels.includes(c)),
    territory: territoryRank(a.territory) >= territoryRank(b.territory) ? a.territory : b.territory,
    durationMonths: a.durationMonths >= b.durationMonths ? a.durationMonths : b.durationMonths,
    exclusive: a.exclusive || b.exclusive,
  };
}
