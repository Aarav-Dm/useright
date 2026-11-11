'use client';
import type { ReactNode } from 'react';
// The typed-total approval field shared by Ask me and the deal room (docs/ui/ask.md). Guidance only: it parses
// with the shared strict parser and compares integer cents; the server re-parses and decides (lib/send.ts approve).
import { Check } from 'lucide-react';
import { TermTip } from '@/components/creator/explain';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { usd } from '@/lib/format';
import { centsToValue, parseCents } from '@/lib/money';

export type TotalHint = { tone: 'neutral' | 'match' | 'mismatch'; text: string };

export function totalHint(typed: string, totalCents: number, blurred: boolean): TotalHint {
  if (!typed.trim()) return { tone: 'neutral', text: `Type ${centsToValue(totalCents)} to approve.` };
  const cents = parseCents(typed);
  if (cents === totalCents) return { tone: 'match', text: 'Matches this quote’s total.' };
  if (!blurred) return { tone: 'neutral', text: `Type ${centsToValue(totalCents)} to approve.` };
  return cents === null
    ? { tone: 'mismatch', text: `That isn’t an amount; this quote totals ${usd(totalCents)}.` }
    : { tone: 'mismatch', text: `That is ${usd(cents)}; this quote totals ${usd(totalCents)}.` };
}

/** True only when the typed text parses to exactly the quote total. */
export const typedMatches = (typed: string, totalCents: number) => parseCents(typed) === totalCents;

export function TypedTotalField({ id, value, totalCents, blurred, disabled, onChange, onBlur, actions }: {
  id: string; value: string; totalCents: number; blurred: boolean; disabled?: boolean;
  onChange: (v: string) => void; onBlur: () => void;
  /** B16: the approve and reject buttons, kept on the input's line. */
  actions?: ReactNode;
}) {
  const hint = totalHint(value, totalCents, blurred);
  const hintId = `${id}-hint`;
  return (
    <div className="grid gap-2">
      <div className="flex items-center gap-2">
        <Label htmlFor={id}>Type the total to approve ($)</Label>
        <TermTip term="typedTotal" />
      </div>
      <div className="flex flex-wrap items-center gap-2">
      <Input id={id} inputMode="decimal" autoComplete="off" className="h-11 w-40 font-mono" placeholder={(totalCents / 100).toFixed(2)}
        value={value} disabled={disabled} aria-describedby={hintId} aria-invalid={hint.tone === 'mismatch' || undefined}
        onBlur={onBlur} onChange={(e) => onChange(e.target.value)} />
      {actions}
      </div>
      <p id={hintId} className={`flex items-center gap-1.5 text-meta ${hint.tone === 'mismatch' ? 'text-destructive' : 'text-muted-foreground'}`}>
        {hint.tone === 'match' && <Check aria-hidden className="size-3.5" />}
        {hint.text}
      </p>
    </div>
  );
}
