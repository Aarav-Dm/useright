// Gap engine (spec §4.3, batch-2 §3). One code path for v1 and vN (P2).
import { combine, price, scopeOptionIds, type PriceLine, type RateCard, type Scope } from './pricing';

export const PAID_CREDIT_OPTION_ID = 'credit:paid';

export type Gap = {
  /** Lines of the combined scope, plus a negative `credit:paid` line when paidCents > 0. Sums to totalCents. */
  lines: PriceLine[];
  totalCents: number;
  /** Option ids in the combined scope that the current licence does not already have. */
  newOptionIds: string[];
  /** True when the amount due is <= 0. Returned, never thrown. */
  refused: boolean;
  /** The scope already held (null for a v1), the scope after the sale, and the price breakdown the total comes from. */
  current: Scope | null;
  combined: Scope;
  /** Price of `combined` at `card`. totalCents = combinedCents - paidCents. */
  combinedCents: number;
  paidCents: number;
};

/**
 * v1: `current = null`, prices the requested scope.
 * vN: prices combined(current, requested) at `card` (the parent's frozen card) minus `paidCents`.
 */
export function gap(requested: Scope, current: Scope | null, paidCents: number, card: RateCard): Gap {
  if (!Number.isSafeInteger(paidCents) || paidCents < 0) {
    throw new Error('paidCents must be a non-negative integer');
  }
  const target = current ? combine(current, requested) : requested;
  const priced = price(target, card);
  const lines = [...priced.lines];
  if (paidCents > 0) lines.push({ optionId: PAID_CREDIT_OPTION_ID, cents: -paidCents });
  const totalCents = priced.totalCents - paidCents;

  const had = new Set<string>(current ? scopeOptionIds(current) : []);
  const newOptionIds = scopeOptionIds(target).filter((id) => !had.has(id));

  return {
    lines, totalCents, newOptionIds, refused: totalCents <= 0,
    current, combined: target, combinedCents: priced.totalCents, paidCents,
  };
}
