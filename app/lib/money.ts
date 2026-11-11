// Money as integer cents (batch-5 fix 20). String math only: no parseFloat, no Number of a decimal.

export const MAX_TYPED_CENTS = 100_000_000; // $1,000,000

/** "900", "900.5" or "900.00" -> cents. Rejects "$", commas, signs, spaces inside, >2 decimals. null when invalid. */
export function parseCents(input: string): number | null {
  const s = input.trim();
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return null;
  const whole = m[1]!.replace(/^0+(?=\d)/, '');
  if (whole.length > 7) return null; // keeps the multiply below exact and under MAX_TYPED_CENTS
  const cents = Number(whole) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
  return cents <= MAX_TYPED_CENTS ? cents : null;
}

/** Integer cents -> PayPal amount string "420.00". */
export function centsToValue(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents < 0) throw new Error('cents must be a non-negative integer');
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}
