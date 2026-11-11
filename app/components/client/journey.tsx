// B16: the client journey in four steps, shared by the portfolio, the pay page and the receipt so a client always
// knows where they are. Display only: `current` comes from what the page already knows.
import { Check } from 'lucide-react';

export const JOURNEY = ['Pick a photo', 'Ask for a licence', 'Pay with PayPal', 'Receipt and file'] as const;

export function JourneySteps({ current, className = '' }: { current: 0 | 1 | 2 | 3; className?: string }) {
  return (
    <nav aria-label="Your licence, step by step" className={className}>
      <ol className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px]">
        {JOURNEY.map((s, i) => (
          <li key={s} className="flex items-center gap-2" aria-current={i === current ? 'step' : undefined}>
            {i > 0 && <span aria-hidden="true" className="h-px w-4 bg-white/20" />}
            <span className={i === current ? 'font-medium text-white' : i < current ? 'text-white/70' : 'g-muted'}>
              {i < current && <Check aria-hidden className="mr-1 inline size-3.5 align-[-2px]" />}
              {s}
              {i < current && <span className="sr-only"> (done)</span>}
            </span>
          </li>
        ))}
      </ol>
    </nav>
  );
}
