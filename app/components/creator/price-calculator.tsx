'use client';
// Batch 7C phase 2: a read-only price calculator beside the rate card, and a live example of what your rules would do.
// It calls the same pure functions the server uses (price() from lib/pricing, unsellable() from lib/policy-flags) on
// your saved rate card and limits. It never sends, saves or approves anything.
import { useState } from 'react';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { optionLabel, usd } from '@/lib/format';
import { unsellable } from '@/lib/policy-flags';
import { CHANNELS, price, TERRITORIES, type Channel, type RateCard, type Territory } from '@/lib/pricing';
import type { SettingsView } from '@/lib/settings';

export function PriceCalculator({ settings }: { settings: SettingsView }) {
  const [channels, setChannels] = useState<Channel[]>(['social']);
  const [territory, setTerritory] = useState<Territory>('US');
  const [months, setMonths] = useState<6 | 12>(6);
  const scope = { channels, territory, durationMonths: months, exclusive: false };
  const quote = channels.length ? price(scope, settings.rateCard as RateCard) : null;
  const asks = unsellable(channels, { autoChannels: settings.autoChannels });
  const overCap = quote ? quote.totalCents > settings.perDealCapCents : false;

  return (
    <section aria-labelledby="calc-title" className="grid gap-4 rounded-md border bg-card p-4">
      <div className="grid gap-1">
        <h3 id="calc-title" className="text-label">Try a price</h3>
        <p className="text-meta text-muted-foreground">A first licence priced with your saved rate card, the same way the agent prices it. Edits above count after you save.</p>
      </div>
      <fieldset className="grid gap-2">
        <legend className="mb-1 text-meta text-muted-foreground">Channels</legend>
        <div className="flex flex-wrap gap-x-5 gap-y-1">
          {CHANNELS.map((c) => (
            <Label key={c} htmlFor={`calc-${c}`} className="flex min-h-11 cursor-pointer items-center gap-2 font-normal">
              <Checkbox id={`calc-${c}`} checked={channels.includes(c)} onCheckedChange={(on) => setChannels((all) => (on === true ? [...all, c] : all.filter((x) => x !== c)))} />
              {optionLabel(c)}
            </Label>
          ))}
        </div>
      </fieldset>
      <div className="grid gap-4 sm:grid-cols-2">
        <fieldset className="grid gap-1">
          <legend className="mb-1 text-meta text-muted-foreground">Territory</legend>
          <RadioGroup value={territory} onValueChange={(v) => setTerritory(v as Territory)} className="flex flex-wrap gap-x-5" aria-label="Territory">
            {TERRITORIES.map((t) => (
              <Label key={t} htmlFor={`calc-t-${t}`} className="flex min-h-11 cursor-pointer items-center gap-2 font-normal">
                <RadioGroupItem id={`calc-t-${t}`} value={t} />{optionLabel(t)}
              </Label>
            ))}
          </RadioGroup>
        </fieldset>
        <fieldset className="grid gap-1">
          <legend className="mb-1 text-meta text-muted-foreground">Term</legend>
          <RadioGroup value={String(months)} onValueChange={(v) => setMonths(v === '12' ? 12 : 6)} className="flex flex-wrap gap-x-5" aria-label="Term">
            {(['6', '12'] as const).map((m) => (
              <Label key={m} htmlFor={`calc-m-${m}`} className="flex min-h-11 cursor-pointer items-center gap-2 font-normal">
                <RadioGroupItem id={`calc-m-${m}`} value={m} />{m} months
              </Label>
            ))}
          </RadioGroup>
        </fieldset>
      </div>
      <div aria-live="polite" className="grid gap-2 border-t pt-3 text-body">
        {!quote ? <p className="text-muted-foreground">Pick at least one channel.</p> : (
          <>
            <p className="flex flex-wrap items-baseline gap-x-2">
              <span className="text-muted-foreground">Price</span>
              <span className="font-mono text-money">{usd(quote.totalCents)}</span>
              <span className="text-meta text-muted-foreground">{quote.lines.map((l) => `${optionLabel(l.optionId)} ${usd(l.cents)}`).join(' + ')}</span>
            </p>
            <p>
              {overCap || asks.length > 0
                ? `With these rules a ${usd(quote.totalCents)} request would need your approval: ${[
                  overCap ? `it is over your ${usd(settings.perDealCapCents)} per-deal cap` : null,
                  asks.length ? `${asks.map(optionLabel).join(' and ')} ${asks.length === 1 ? 'is' : 'are'} not set to “Agent sells on its own”` : null,
                ].filter(Boolean).join(', and ')}.`
                : `With these rules the agent may send a ${usd(quote.totalCents)} invoice on its own, if the client is on your list and within your daily and 30-day limits.`}
            </p>
          </>
        )}
      </div>
    </section>
  );
}
