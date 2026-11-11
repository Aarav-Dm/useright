import { describe, expect, it } from 'vitest';
import { gap, PAID_CREDIT_OPTION_ID } from '../lib/gap';
import { unsellable } from '../lib/policy-flags';
import { combine, DEFAULT_CARD, price, type Scope } from '../lib/pricing';

const sum = (lines: { cents: number }[]) => lines.reduce((s, l) => s + l.cents, 0);
const v1Scope: Scope = { channels: ['social'], territory: 'US', durationMonths: 6, exclusive: false };
const settings = { autoChannels: ['social', 'web', 'print'] };

describe('§7.1 lines sum to total', () => {
  const scopes: Scope[] = [
    v1Scope,
    { channels: ['social', 'web', 'print'], territory: 'NA', durationMonths: 12, exclusive: false },
    { channels: ['billboard', 'OOH', 'TV'], territory: 'WORLD', durationMonths: 6, exclusive: true },
    { channels: [], territory: 'US', durationMonths: 12, exclusive: false },
  ];
  it.each(scopes)('price(%j)', (scope) => {
    const p = price(scope, DEFAULT_CARD);
    expect(sum(p.lines)).toBe(p.totalCents);
    expect(p.lines.every((l) => Number.isInteger(l.cents))).toBe(true);
  });
  it('gap lines also sum to total', () => {
    const g = gap({ ...v1Scope, channels: ['print'], territory: 'WORLD', durationMonths: 12 }, v1Scope, 30000, DEFAULT_CARD);
    expect(sum(g.lines)).toBe(g.totalCents);
  });
  it('exclusive is unpriced', () => {
    expect(price({ ...v1Scope, exclusive: true }, DEFAULT_CARD).totalCents).toBe(30000);
  });
  it('throws on a card missing an option', () => {
    const { print: _drop, ...partial } = DEFAULT_CARD;
    expect(() => price({ ...v1Scope, channels: ['print'] }, partial as typeof DEFAULT_CARD)).toThrow(/print/);
  });
});

describe('§7.2 v1, print upgrade, v2 = combined minus paid', () => {
  it('v1 social/US/6mo = 30000', () => {
    expect(price(v1Scope, DEFAULT_CARD).totalCents).toBe(30000);
  });
  it('adding print: gap = 42000', () => {
    const g = gap({ ...v1Scope, channels: ['print'] }, v1Scope, 30000, DEFAULT_CARD);
    expect(g.totalCents).toBe(42000);
    expect(g.newOptionIds).toEqual(['print']);
    expect(g.refused).toBe(false);
    expect(g.lines.at(-1)).toEqual({ optionId: PAID_CREDIT_OPTION_ID, cents: -30000 });
  });
  it('v2 = price(combined) - paid, for territory and duration changes too', () => {
    const requested: Scope = { channels: ['web'], territory: 'NA', durationMonths: 12, exclusive: false };
    const combined = combine(v1Scope, requested);
    expect(combined).toEqual({ channels: ['social', 'web'], territory: 'NA', durationMonths: 12, exclusive: false });
    const g = gap(requested, v1Scope, 30000, DEFAULT_CARD);
    expect(g.totalCents).toBe(price(combined, DEFAULT_CARD).totalCents - 30000); // 65000 - 30000
    expect(g.totalCents).toBe(35000);
    expect(g.newOptionIds).toEqual(['web', 'NA', '12mo']);
  });
  it('uses the frozen card passed in, not the default', () => {
    const frozen = { ...DEFAULT_CARD, print: 40000 };
    expect(gap({ ...v1Scope, channels: ['print'] }, v1Scope, 30000, frozen).totalCents).toBe(40000);
  });
});

describe('§7.3 billboard', () => {
  it('gap = 90000 and unsellable flags billboard', () => {
    const g = gap({ ...v1Scope, channels: ['billboard'] }, v1Scope, 30000, DEFAULT_CARD);
    expect(g.totalCents).toBe(90000);
    expect(unsellable(g.newOptionIds, settings)).toEqual(['billboard']);
  });
  it('unsellable flags exclusive, ignores territory/duration and sellable channels', () => {
    expect(unsellable(['social', 'print', 'WORLD', '12mo', 'exclusive', 'TV', 'TV'], settings)).toEqual(['exclusive', 'TV']);
  });
});

describe('§7.4 portfolio v1 from an empty licence', () => {
  it('goes through gap() and equals the plain price', () => {
    const requested: Scope = { channels: ['social', 'web'], territory: 'US', durationMonths: 12, exclusive: false };
    const g = gap(requested, null, 0, DEFAULT_CARD);
    const p = price(requested, DEFAULT_CARD);
    expect(g.totalCents).toBe(p.totalCents);
    expect(g.lines).toEqual(p.lines);
    expect(g.newOptionIds).toEqual(['social', 'web', 'US', '12mo']);
    expect(g.refused).toBe(false);
  });
});

describe('§7.5 gap <= 0 is refused, not thrown', () => {
  it('re-requesting what is held: gap 0', () => {
    const g = gap(v1Scope, v1Scope, 30000, DEFAULT_CARD);
    expect(g.totalCents).toBe(0);
    expect(g.refused).toBe(true);
    expect(g.newOptionIds).toEqual([]);
  });
  it('paid more than the combined price: negative gap', () => {
    const g = gap(v1Scope, v1Scope, 50000, DEFAULT_CARD);
    expect(g.totalCents).toBe(-20000);
    expect(g.refused).toBe(true);
  });
  it('rejects a non-integer paid amount', () => {
    expect(() => gap(v1Scope, null, 1.5, DEFAULT_CARD)).toThrow();
  });
});
