'use client';
// Batch 7C phase 2: plain-language explanations added on top of the dashboard (add only). All fixed text: no
// numbers are computed here. Tips open on click, tap or keyboard (never hover-only, docs/ui/README.md).
import { Check, CircleHelp } from 'lucide-react';
import type { ReactNode } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { STATUS_LABEL } from '@/lib/format';

// ---------- "?" term tips ----------

export const TERMS = {
  rules: {
    title: 'Rules R1 to R5',
    body: [
      'R1: the client is on your list of clients the agent may invoice.',
      'R2: the price is within your per-deal cap.',
      'R3: the agent has sends left today, and this client stays under your 30-day cap.',
      'R4: every new use is one you let the agent sell on its own.',
      'R5: every request check is clear (each use is backed by a sentence the client wrote).',
      'All five pass: the agent sends the invoice. Any one stops: it waits in Ask me for your typed total. If PayPal cannot take it (under $1.00, no client email), fix the deal instead.',
    ],
  },
  autopilot: {
    title: 'Autopilot',
    body: ['When every rule passes, the agent sends the PayPal invoice on its own, with no click from you. Anything else waits for you in Ask me.'],
  },
  licenceVersion: {
    title: 'Licence version',
    body: ['v1 is the first licence a client buys for a photo. When they want more (say print on top of social), the new quote is v2: it charges the full new scope minus what they already paid. Only one version is current at a time.'],
  },
  scope: {
    title: 'Scope',
    body: ['What the licence covers: the channels (social, web, print, billboard...), the territory (US, North America, worldwide), the term (6 or 12 months) and whether it is exclusive. The price is the sum of those options on your rate card.'],
  },
  typedTotal: {
    title: 'Typed total',
    body: ['Typing the exact amount is how you approve a quote the rules stopped. It must match the quote to the cent; the server checks it again before anything is sent.'],
  },
  ledger: {
    title: 'Ledger',
    body: ['A read-only record of every rule decision, approval and PayPal result. Nothing in it can be edited, so you can always see why something happened.'],
  },
  renewal: {
    title: 'Renewal',
    body: [
      'A week before a licence ends, the agent opens a renewal: the same use, priced from your rate card as it is that day.',
      'If the client ticked "Send me a renewal invoice" on the pay page and every rule passes, the agent sends it. Otherwise it waits in Ask me as Renew? for your typed total.',
      'If the term ends unpaid, the licence expires: downloads stop and the client gets an Expired receipt. A renewal paid early starts the day the current term ends.',
    ],
  },
} as const;

export type TermKey = keyof typeof TERMS;

export function TermTip({ term }: { term: TermKey }) {
  const t = TERMS[term];
  return (
    <Popover>
      <PopoverTrigger
        className="relative inline-flex size-5 shrink-0 items-center justify-center rounded-full align-middle text-muted-foreground before:absolute before:-inset-3 before:content-[''] hover:text-foreground"
        aria-label={`What is ${t.title.toLowerCase()}?`}
        onClick={(e) => e.stopPropagation()}
      >
        <CircleHelp aria-hidden className="size-4" />
      </PopoverTrigger>
      <PopoverContent className="theme-dashboard grid w-80 gap-2 text-body font-normal tracking-normal text-foreground" onClick={(e) => e.stopPropagation()}>
        <p className="text-label">{t.title}</p>
        {t.body.map((line) => <p key={line} className="text-muted-foreground">{line}</p>)}
      </PopoverContent>
    </Popover>
  );
}

// ---------- status meanings ----------

type Meaning = { means: string; next: string; needsYou: boolean };

export const STATUS_MEANING: Record<string, Meaning> = {
  ready: { means: 'The request was read and priced from your rate card.', next: 'The agent quotes it and checks your rules; if they pass it sends the invoice.', needsYou: false },
  needs_creator: { means: 'The agent could not finish reading the request on its own.', next: 'Open the deal, fix what it lists (for example pick the client), and it carries on.', needsYou: true },
  clarify: { means: 'The request is unclear, so nothing was priced.', next: 'Send the client the drafted question, then add their answer.', needsYou: true },
  awaiting_verification: { means: 'Someone asked through your public page and has not confirmed their email yet.', next: 'No email goes out yet: open the deal, get the confirmation link and pass it to them. Once they confirm, the request is read and priced.', needsYou: true },
  awaiting_transcript: { means: 'A screenshot was read into a draft transcript.', next: 'Check who said what and confirm it; then it is priced.', needsYou: true },
  needs_approval: { means: 'A rule stopped the quote, so nothing was sent.', next: 'Type the exact total in Ask me to send it, or reject it. If PayPal cannot take it (under $1.00, no client email), fix the deal instead.', needsYou: true },
  sending: { means: 'The invoice is being created in PayPal right now.', next: 'It usually becomes "Invoice sent" within seconds. If it does not change, open the deal and check before doing anything else.', needsYou: false },
  invoiced: { means: 'PayPal has the invoice and the client has been sent it.', next: 'When the client pays, PayPal tells UseRight and the file unlocks.', needsYou: false },
  failed: { means: 'The invoice could not be confirmed as sent.', next: 'Open the deal and check with PayPal before you retry.', needsYou: true },
  cancelled: { means: 'The invoice was cancelled.', next: 'Edit the deal to make a new quote, if the client still wants it.', needsYou: false },
  rejected: { means: 'You rejected this request.', next: 'Nothing more happens. Add a new request to start again.', needsYou: false },
  paid: { means: 'PayPal confirmed the payment and the client’s file is unlocked.', next: 'Nothing; a rights receipt was issued.', needsYou: false },
  refunded: { means: 'The payment, or an earlier licence this one built on, was refunded in PayPal.', next: 'The licence is revoked and downloads are stopped.', needsYou: false },
  expired: { means: 'The licence term ended without a paid renewal.', next: 'Downloads are stopped and an Expired receipt was issued. If the client pays a renewal invoice later, it starts a new term.', needsYou: false },
};
/** review B7C-2 finding 6: a hard-blocked quote (under $1.00, no client email) cannot be approved, so its tip says so. */
export const HARD_BLOCK_MEANING: Meaning = {
  means: 'PayPal cannot take this quote as it is (under $1.00 or no client email), so nothing was sent.',
  next: 'Open the deal and fix what the rules list; typing the total cannot send it.',
  needsYou: true,
};

/** B11 item 1: a request naming paid promotion cannot be priced, so nothing the creator edits will send it. */
export const PAID_USE_MEANING: Meaning = {
  means: 'The client asked for paid promotion. It is not on your rate card, so the agent will not price or send it.',
  next: 'Reject it, or add a new request without paid use.',
  needsYou: true,
};

export const DEMO_MEANING: Record<string, Meaning> = {
  paid: { means: 'Seeded as paid for the walkthrough. This is not a PayPal payment.', next: 'Nothing; it is demo data.', needsYou: false },
  refunded: { means: 'Seeded as refunded for the walkthrough. No PayPal refund happened.', next: 'Nothing; it is demo data.', needsYou: false },
  invoiced: { means: 'Seeded as sent for the walkthrough. PayPal never saw it and no client will pay it.', next: 'Nothing; PayPal actions are off for demo invoices.', needsYou: false },
};

export function StatusTip({ status, demo = false, hardBlock = false, paidUse = false }: { status: string; demo?: boolean; hardBlock?: boolean; paidUse?: boolean }) {
  const m = (demo && DEMO_MEANING[status]) || (hardBlock && status === 'needs_approval' ? HARD_BLOCK_MEANING : null) || (paidUse && status === 'needs_creator' ? PAID_USE_MEANING : null) || STATUS_MEANING[status];
  if (!m) return null;
  const label = STATUS_LABEL[status] ?? status;
  return (
    <Popover>
      <PopoverTrigger
        className="relative inline-flex size-5 shrink-0 items-center justify-center rounded-full text-muted-foreground before:absolute before:-inset-3 before:content-[''] hover:text-foreground"
        aria-label={`What “${label}” means`}
        onClick={(e) => e.stopPropagation()}
      >
        <CircleHelp aria-hidden className="size-3.5" />
      </PopoverTrigger>
      <PopoverContent className="theme-dashboard grid w-80 gap-2 text-body font-normal text-foreground" onClick={(e) => e.stopPropagation()}>
        <p className="text-label">{label}</p>
        <dl className="grid gap-1.5">
          <div><dt className="text-meta text-muted-foreground">What this means</dt><dd>{m.means}</dd></div>
          <div><dt className="text-meta text-muted-foreground">What happens next</dt><dd>{m.next}</dd></div>
          <div><dt className="text-meta text-muted-foreground">Does it need you?</dt><dd>{m.needsYou ? 'Yes' : 'No'}</dd></div>
        </dl>
      </PopoverContent>
    </Popover>
  );
}

// ---------- how it works ----------

export const FLOW_STEPS = ['Client asks', 'Agent prices', 'You approve (or autopilot)', 'Client pays with PayPal', 'File unlocks'] as const;

/** Index of the flow step a deal is on, from its server status; null when it left the flow. */
export function flowStepFor(status: string): number | null {
  if (['awaiting_verification', 'awaiting_transcript', 'needs_creator', 'clarify'].includes(status)) return 0;
  if (status === 'ready') return 1;
  if (['needs_approval', 'sending', 'failed'].includes(status)) return 2;
  if (status === 'invoiced') return 3;
  if (status === 'paid') return 4;
  return null;
}

export function HowItWorks({ current = null, sentBy = null }: { current?: number | null; /** B11 item 2: names who did the approve step once a real invoice went out. */ sentBy?: 'agent' | 'you' | null }) {
  return (
    <nav aria-label="How it works" className="mb-6">
      <ol className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-meta text-muted-foreground">
        {FLOW_STEPS.map((s, i) => (
          <li key={s} className="flex items-center gap-1.5" aria-current={current === i ? 'step' : undefined}>
            {i > 0 && <span aria-hidden>→</span>}
            <span className={current === i ? 'rounded-full border border-ring px-2 py-0.5 font-medium text-foreground' : current !== null && i < current ? 'text-foreground' : ''}>
              {current !== null && i < current && <Check aria-hidden className="mr-0.5 inline size-3" />}
              {i === 2 && sentBy ? (sentBy === 'agent' ? 'Autopilot' : 'You approved') : s}
              {current === i && <span className="sr-only"> (this deal is here)</span>}
            </span>
          </li>
        ))}
      </ol>
    </nav>
  );
}

// ---------- deal progress ----------

export const PROGRESS_STEPS = ['Received', 'Priced', 'Approved', 'Invoiced', 'Paid', 'Delivered'] as const;

/** How many progress steps a deal has reached, from its server status. */
export function progressFor(status: string): number {
  switch (status) {
    case 'awaiting_verification': case 'awaiting_transcript': case 'needs_creator': case 'clarify': return 1;
    case 'ready': case 'needs_approval': case 'rejected': case 'cancelled': return 2;
    case 'sending': case 'failed': return 3;
    case 'invoiced': return 4;
    case 'refunded': case 'expired': return 5;
    case 'paid': return 6;
    default: return 0;
  }
}

export function DealProgress({ status }: { status: string }): ReactNode {
  const reached = progressFor(status);
  const last = reached > 0 ? PROGRESS_STEPS[reached - 1] : 'Not started';
  // review B7C-2 finding 11: a refunded deal never reads as "Paid" to a screen reader.
  const label = status === 'refunded' ? 'Progress: refunded after payment'
    : status === 'expired' ? 'Progress: paid, then the term ended without a renewal'
    : status === 'cancelled' ? 'Progress: cancelled, nothing will be paid'
      : `Progress: ${reached} of ${PROGRESS_STEPS.length}, ${last}`;
  return (
    <span className="mt-2 flex items-center gap-1" role="img" aria-label={label}>
      {PROGRESS_STEPS.map((s, i) => (
        <span key={s} title={s} className={`h-1 w-4 rounded-full ${i < reached ? (status === 'refunded' && i === reached - 1 ? 'bg-destructive' : 'bg-foreground/70') : 'bg-foreground/15'}`} />
      ))}
    </span>
  );
}

// ---------- a stopped rule in plain words ----------

const cents = (s: string | undefined) => (s && /^\d+$/.test(s) ? Number(s) : null);
const dollars = (c: number | null) => (c === null ? null : `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);

/**
 * What a stopped rule means against the limit, in plain words. The amounts are the ones the server wrote into the
 * rule code (for example `over_deal_cap:90000:50000`); nothing is recomputed.
 */
export function ruleInPlainWords(code: string, clientName: string): string | null {
  const [prefix, a, b] = code.split(':');
  switch (prefix) {
    case 'client_not_allowed':
      return `${clientName} is not on your list of clients the agent may invoice (Settings, Clients).`;
    case 'over_deal_cap':
      return dollars(cents(a)) && dollars(cents(b)) ? `This quote is ${dollars(cents(a))}; your per-deal cap is ${dollars(cents(b))} (Settings, Autopilot limits).` : null;
    case 'daily_max_reached':
      return `The agent already sent ${a} invoice${a === '1' ? '' : 's'} today, which is your daily limit.`;
    case 'rolling_cap_reached':
      return dollars(cents(a)) && dollars(cents(b)) ? `With this quote ${clientName} would reach ${dollars(cents(a))} in 30 days; your 30-day cap is ${dollars(cents(b))}.` : null;
    case 'needs_approval':
      return a ? `${a === 'OOH' ? 'Out-of-home' : a === 'exclusive' ? 'Exclusive rights' : a[0]!.toUpperCase() + a.slice(1)} is not set to “Agent sells on its own” (Settings, What the agent may sell).` : null;
    case 'checks_not_clear':
      return 'Not every use is backed by a sentence the client wrote. Open the deal to check.';
    case 'amount_too_small':
      return 'PayPal does not accept invoices under $1.00.';
    case 'missing_client_email':
      return 'The client has no valid email address, so PayPal has nowhere to send the invoice.';
    case 'renewal_needs_ok':
      return `${clientName} did not tick “Send me a renewal invoice” on the pay page, so the agent asks you before sending this renewal.`;
    default:
      return null;
  }
}
