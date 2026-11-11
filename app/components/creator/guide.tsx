'use client';
// Batch 7C: guidance added on top of the dashboard pages (add only). Fixed help text and next-step banners built
// from data the page already loaded. No numbers are computed here: every amount shown is a server total.
import { ArrowRight, ChevronDown, Info } from 'lucide-react';
import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import type { DealRow } from '@/lib/deals';
import { usd } from '@/lib/format';
import type { AskAlert, AskItem } from '@/lib/ledger';

/** "What happens here?": short fixed text, closed by default. */
export function HelpPanel({ children, id }: { children: ReactNode; id: string }) {
  const [open, setOpen] = useState(false);
  return (
    // B16: a quiet text control, not a full-width bordered bar (impeccable: don't wrap everything in a container).
    <Collapsible open={open} onOpenChange={setOpen} className="mb-6">
      <CollapsibleTrigger
        className="-ml-2 inline-flex min-h-9 items-center gap-1.5 rounded-md px-2 text-left text-label text-muted-foreground hover:text-foreground"
        aria-controls={`${id}-help`}
      >
        <Info aria-hidden className="size-4 shrink-0" />
        What happens here?
        <ChevronDown aria-hidden className={`size-4 transition-transform ${open ? 'rotate-180' : ''}`} />
      </CollapsibleTrigger>
      <CollapsibleContent id={`${id}-help`} className="mt-2 grid max-w-prose gap-2 rounded-lg border bg-card p-4 text-body text-muted-foreground [&_strong]:font-medium [&_strong]:text-foreground">
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}

export type NextStep = { key: string; text: string; href: string; action: string };

/** A banner of what needs the creator next, most urgent first. Renders nothing when the list is empty. */
export function NextStepBanner({ steps, calm, note }: { steps: NextStep[]; calm?: string; note?: string }) {
  if (steps.length === 0) {
    return calm ? <p className="mb-6 text-body text-muted-foreground">{calm}{note ? ` ${note}` : ''}</p> : null;
  }
  const [first, ...rest] = steps;
  return (
    // B16: the page's lead. No box: the first step in large type with one real button (Vercel: one strong line per view).
    <section aria-labelledby="next-steps-title" className="mb-8 grid gap-2">
      <h2 id="next-steps-title" className="text-label text-warning">Next step</h2>
      <p className="flex flex-wrap items-center gap-x-4 gap-y-2 text-lg leading-7 font-semibold tracking-tight">
        <span>{first!.text}</span>
        <Button asChild size="sm"><Link href={first!.href}>
          {first!.action}<ArrowRight aria-hidden className="size-3.5" />
        </Link></Button>
      </p>
      {rest.length > 0 && (
        <ul className="grid gap-1 text-body text-muted-foreground">
          {rest.map((s) => (
            <li key={s.key} className="flex flex-wrap items-center gap-x-3">
              <span>{s.text}</span>
              <Link href={s.href} className="text-label text-foreground underline underline-offset-4">{s.action}</Link>
            </li>
          ))}
        </ul>
      )}
      {note && <p className="text-meta text-muted-foreground">{note}</p>}
    </section>
  );
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);
/** Server totals as a list of amounts, never added up here. */
const amounts = (cents: (number | null)[]) => {
  const shown = cents.filter((c): c is number => c !== null).slice(0, 3).map(usd);
  if (shown.length === 0) return '';
  return `: ${shown.join(', ')}${cents.length > 3 ? ' and more' : ''}`;
};

/** `listDeals` in lib/deals.ts returns at most this many deals (its default limit); the banner says so when reached. */
export const DEALS_LOADED_MAX = 200;

/** Next steps for the Deals page, from its rows (status comes from the server's dealState). */
export function dealsNextSteps(deals: DealRow[]): NextStep[] {
  const by = (statuses: string[]) => deals.filter((d) => statuses.includes(d.status));
  const steps: NextStep[] = [];
  const approval = by(['needs_approval']);
  // review B7C-1 finding 5: a Deals row cannot tell a hard block from an approvable stop, so this says "review".
  if (approval.length) steps.push({
    key: 'approval', href: '/ask', action: 'Review',
    text: `${approval.length} ${plural(approval.length, 'quote the rules stopped needs', 'quotes the rules stopped need')} your review${amounts(approval.map((d) => d.gapTotalCents))}`,
  });
  const failed = by(['failed']);
  if (failed.length) steps.push({
    key: 'failed', href: `/deals/${failed[0]!.briefId}`, action: 'Open deal',
    text: `${failed.length} ${plural(failed.length, 'invoice', 'invoices')} could not be confirmed as sent`,
  });
  const transcript = by(['awaiting_transcript']);
  if (transcript.length) steps.push({
    key: 'transcript', href: `/deals/${transcript[0]!.briefId}`, action: 'Confirm transcript',
    text: `${transcript.length} ${plural(transcript.length, 'screenshot needs', 'screenshots need')} you to check who said what`,
  });
  const check = by(['needs_creator', 'clarify']);
  if (check.length) steps.push({
    key: 'check', href: `/deals/${check[0]!.briefId}`, action: 'Open deal',
    text: `${check.length} ${plural(check.length, 'request needs', 'requests need')} you to check it`,
  });
  // review B7C-1 finding 4: seeded demo invoices are never counted as live invoices out with PayPal.
  const out = by(['invoiced']).filter((d) => !d.demo);
  if (out.length) steps.push({
    key: 'invoiced', href: `/deals/${out[0]!.briefId}`, action: 'See invoice',
    text: `${out.length} ${plural(out.length, 'invoice is', 'invoices are')} out, waiting for the client to pay${amounts(out.map((d) => d.gapTotalCents))}`,
  });
  const demoOut = by(['invoiced']).filter((d) => d.demo);
  if (demoOut.length) steps.push({
    key: 'invoiced-demo', href: `/deals/${demoOut[0]!.briefId}`, action: 'See it',
    text: `Demo: ${demoOut.length} seeded ${plural(demoOut.length, 'invoice is', 'invoices are')} shown as unpaid${amounts(demoOut.map((d) => d.gapTotalCents))}. PayPal never saw ${plural(demoOut.length, 'it', 'them')}`,
  });
  return steps;
}

/** Next steps for Ask me, from its queue and alerts. */
export function askNextSteps(items: AskItem[], alerts: AskAlert[]): NextStep[] {
  const steps: NextStep[] = [];
  // review B7C-2 finding 2: a quote whose send failed is not "waiting for approval"; the safe step is to check the deal.
  const open = items.filter((i) => !i.hardBlock && !i.sendError);
  if (open.length) steps.push({
    key: 'approve', href: `#quote-${open[0]!.versionId}`, action: 'Review',
    text: `${open.length} ${plural(open.length, 'quote waits', 'quotes wait')} for your typed approval${amounts(open.map((i) => i.totalCents))}`,
  });
  const sendFailed = items.filter((i) => !i.hardBlock && i.sendError);
  if (sendFailed.length) steps.push({
    key: 'send-failed', href: `/deals/${sendFailed[0]!.briefId}`, action: 'Check the deal',
    text: `${sendFailed.length} ${plural(sendFailed.length, 'invoice', 'invoices')} could not be confirmed as sent. Check with PayPal before approving again`,
  });
  const blocked = items.filter((i) => i.hardBlock);
  if (blocked.length) steps.push({
    key: 'blocked', href: `/deals/${blocked[0]!.briefId}`, action: 'Open deal',
    text: `${blocked.length} ${plural(blocked.length, 'quote needs', 'quotes need')} a change in the deal before it can be approved`,
  });
  if (alerts.length) steps.push({
    key: 'alerts', href: '#exceptions-title', action: 'See below',
    text: `${alerts.length} payment ${plural(alerts.length, 'problem needs', 'problems need')} you`,
  });
  return steps;
}
