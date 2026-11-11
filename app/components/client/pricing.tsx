'use client';
// Rate card from the creator's real settings plus an estimator: pick channels, territory and duration and the
// total rolls to the new value. Uses lib/pricing price(), the same function the agent prices with.
import { animate, motion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { usd } from '@/lib/format';
import { CHANNELS, price, type Channel, type DurationMonths, type RateCard, type Territory } from '@/lib/pricing';
import { MagneticButton } from './magnetic';
import { Reveal } from './reveal';
import { useReduce } from './motion-pref';

const CHANNEL_LABEL: Record<Channel, string> = { social: 'Social', web: 'Web', print: 'Print', billboard: 'Billboard', OOH: 'Out of home', TV: 'TV' };
const TERRITORY_LABEL: Record<Territory, string> = { US: 'United States', NA: 'North America', WORLD: 'Worldwide' };

function Rolling({ cents }: { cents: number }) {
  const reduce = useReduce();
  const [shown, setShown] = useState(cents);
  const from = useRef(cents);
  useEffect(() => {
    if (reduce) { setShown(cents); from.current = cents; return; }
    const c = animate(from.current, cents, { duration: 0.45, ease: [0.23, 1, 0.32, 1], onUpdate: (v) => { setShown(v); from.current = v; } });
    return () => c.stop();
  }, [cents, reduce]);
  return <span aria-live="polite">{usd(Math.round(shown))}</span>;
}

function Toggle<T extends string>({ group, value, options, label, onChange, multi }: {
  group: string; value: T[]; options: readonly T[]; label: (v: T) => string; onChange: (v: T) => void; multi?: boolean;
}) {
  return (
    <div role="group" aria-label={group} className="flex flex-wrap gap-2">
      {options.map((o) => {
        const on = value.includes(o);
        return (
          <button key={o} type="button" aria-pressed={on} onClick={() => onChange(o)}
            className={`relative h-9 rounded-full border px-4 text-sm transition-[color,border-color,transform] duration-150 active:scale-[0.97] ${on ? 'border-white/30 text-white' : 'border-white/10 g-muted hover:border-white/25 hover:text-white'}`}>
            {on && <motion.span layoutId={multi ? undefined : `pill-${group}`} className="absolute inset-0 -z-10 rounded-full bg-white/15"
              initial={multi ? { opacity: 0, scale: 0.9 } : false} animate={{ opacity: 1, scale: 1 }} transition={{ type: 'spring', duration: 0.35, bounce: 0.15 }} />}
            {label(o)}
          </button>
        );
      })}
    </div>
  );
}

export function Pricing({ card, onRequest }: { card: RateCard; onRequest: (draft: string) => void }) {
  const [channels, setChannels] = useState<Channel[]>(['social']);
  const [territory, setTerritory] = useState<Territory>('US');
  const [months, setMonths] = useState<DurationMonths>(6);
  const total = channels.length ? price({ channels, territory, durationMonths: months, exclusive: false }, card).totalCents : 0;
  const toggleChannel = (c: Channel) => setChannels((cs) => (cs.includes(c) ? cs.filter((x) => x !== c) : [...cs, c]));

  return (
    <section id="pricing" aria-labelledby="pricing-title" className="mx-auto max-w-[1200px] scroll-mt-24 px-4 py-28 sm:px-8">
      <Reveal as="p" className="g-mono mb-3 text-xs uppercase tracking-[0.14em] text-[var(--g-accent)]">Rate card</Reveal>
      <h2 id="pricing-title" className="g-display mb-14 text-5xl sm:text-6xl"><Reveal as="span" words>Clear prices, set by the photographer.</Reveal></h2>
      <div className="grid gap-5 lg:grid-cols-[1fr_1.1fr]">
        <Reveal className="g-card p-7">
          <h3 className="mb-5 text-sm uppercase tracking-[0.12em] g-muted">Per use</h3>
          <ul className="divide-y divide-white/[0.07]">
            {CHANNELS.map((c) => (
              <li key={c} className="flex items-center justify-between py-3">
                <span>{CHANNEL_LABEL[c]}</span><span className="g-mono text-white">{usd(card[c])}</span>
              </li>
            ))}
          </ul>
          <h3 className="mb-3 mt-7 text-sm uppercase tracking-[0.12em] g-muted">Add-ons</h3>
          <ul className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
            <li className="flex justify-between"><span className="g-muted">North America</span><span className="g-mono">+{usd(card.NA)}</span></li>
            <li className="flex justify-between"><span className="g-muted">Worldwide</span><span className="g-mono">+{usd(card.WORLD)}</span></li>
            <li className="flex justify-between"><span className="g-muted">6 months</span><span className="g-mono">+{usd(card['6mo'])}</span></li>
            <li className="flex justify-between"><span className="g-muted">12 months</span><span className="g-mono">+{usd(card['12mo'])}</span></li>
          </ul>
        </Reveal>

        <Reveal delay={0.1} className="g-card relative overflow-hidden p-7">
          <div className="pointer-events-none absolute -right-24 -top-24 h-64 w-64 rounded-full bg-[#ffecd2]/10 blur-3xl" aria-hidden="true" />
          <h3 className="mb-6 text-sm uppercase tracking-[0.12em] g-muted">Estimate your licence</h3>
          <div className="grid gap-5">
            <div><p className="mb-2 text-sm">Where it runs</p>
              <Toggle group="Channels" multi value={channels} options={CHANNELS} label={(c) => CHANNEL_LABEL[c]} onChange={toggleChannel} /></div>
            <div><p className="mb-2 text-sm">Territory</p>
              <Toggle group="Territory" value={[territory]} options={['US', 'NA', 'WORLD'] as const} label={(t) => TERRITORY_LABEL[t]} onChange={setTerritory} /></div>
            <div><p className="mb-2 text-sm">Duration</p>
              <Toggle group="Duration" value={[String(months)]} options={['6', '12'] as const} label={(m) => `${m} months`} onChange={(m) => setMonths(Number(m) as DurationMonths)} /></div>
          </div>
          <div className="mt-8 flex flex-wrap items-end justify-between gap-4 border-t border-white/10 pt-6">
            <div>
              <p className="text-xs g-muted">Estimated total</p>
              <p className="g-mono text-5xl text-white">{channels.length ? <Rolling cents={total} /> : '—'}</p>
              <p className="mt-1 text-xs g-muted">The final price comes in your PayPal invoice.</p>
            </div>
            <MagneticButton arrow onClick={() => onRequest(`Use: ${channels.map((c) => CHANNEL_LABEL[c]).join(', ') || 'to discuss'}; ${TERRITORY_LABEL[territory]}; ${months} months.`)}>Request this licence</MagneticButton>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
