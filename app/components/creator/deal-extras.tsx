'use client';
// Batch 7C phase 2: additions to the deal room (add only). "What happens next", "Why this price", the agent's
// timeline from the ledger, and a client-preview link. Every amount is a line the server priced (gapPreview).
import { ExternalLink } from 'lucide-react';
import { DEMO_MEANING, HARD_BLOCK_MEANING, PAID_USE_MEANING, STATUS_MEANING } from '@/components/creator/explain';
import { DemoChip } from '@/components/creator/page-bits';
import type { BriefView } from '@/lib/briefs';
import { optionLabel, scopeParts, shortDateTime, usd } from '@/lib/format';
import type { LedgerRow } from '@/lib/ledger';
import { hasPaidUse } from '@/lib/reasons';

// review B7C-2 finding 3: one demo table, shared with the status tips (explain.tsx).
const DEMO_NEXT = DEMO_MEANING;

export function WhatHappensNext({ view }: { view: BriefView }) {
  const demo = !!view.version?.invoice?.demo;
  const m = (demo && DEMO_NEXT[view.status]) || (view.status === 'needs_approval' && view.version?.policy?.hardBlock ? HARD_BLOCK_MEANING : null) || (view.status === 'needs_creator' && hasPaidUse(view.reasons) ? PAID_USE_MEANING : null) || STATUS_MEANING[view.status];
  if (!m) return null;
  const needsYou = 'needsYou' in m && m.needsYou;
  const message = <div className="grid gap-1">
      <h2 id="happens-next-title" className="text-meta font-medium text-muted-foreground">What happens next</h2>
      {view.status === 'invoiced' && view.sentBy === 'agent' && <p className="text-body font-medium">The agent sent this with no click from you.</p>}
      <p className="text-body">{m.means}</p>
      <p className="text-body font-medium">{m.next}{needsYou ? ' This needs you.' : ''}</p>
  </div>;
  // B16: plain text under the rail; the one amber box on the page is the decision below it (no two warnings stacked).
  return <section aria-labelledby="happens-next-title" className={`grid max-w-prose gap-1 ${needsYou ? '[&_p:last-child]:text-warning' : ''}`}>{message}</section>;
}

const words = (s: Parameters<typeof scopeParts>[0]) => scopeParts(s).map((p) => p.label).join(', ');

/** B12 E5: the gap as one equation at the top of the deal room, from the same gapPreview the Price table shows. */
export function GapEquation({ view }: { view: BriefView }) {
  const g = view.gapPreview;
  if (!g) return null;
  return (
    <p className="text-lg leading-7 font-semibold tracking-tight">
      {g.current && g.paidCents > 0
        ? <>{words(g.current)} → {words(g.combined)}: <span className="font-mono tabular">{usd(g.combinedCents)} − {usd(g.paidCents)} = {usd(g.totalCents)}</span></>
        : <>{words(g.combined)}: <span className="font-mono tabular">{usd(g.totalCents)}</span> from your rate card</>}
    </p>
  );
}

/** One sentence per priced line: the rate-card amount, and the client sentence that asked for it. */
export function WhyThisPrice({ view }: { view: BriefView }) {
  const g = view.gapPreview;
  if (!g) return null;
  const quote = new Map<string, string>();
  for (const k of view.checks?.kept ?? []) if (!quote.has(k.optionId)) quote.set(k.optionId, k.quote);
  // B16: one client sentence often backs several lines; quote it once, under the first line it backs.
  const quoted = new Set<string>();
  const firstQuote = (id: string) => { const q = quote.get(id); if (!q || quoted.has(q)) return null; quoted.add(q); return q; };
  return (
    <section aria-labelledby="why-price-title" className="grid gap-2">
      <h3 id="why-price-title" className="text-label">Why this price</h3>
      <ul className="grid gap-2 text-body">
        {g.lines.map((l) => (
          <li key={l.optionId} className="grid gap-0.5">
            <span>
              <span className="font-medium">{optionLabel(l.optionId)}</span>{' '}
              <span className="font-mono tabular">{usd(l.cents)}</span>{' '}
              <span className="text-muted-foreground">
                {l.optionId === 'credit:paid' ? 'already paid on the earlier licence, taken off'
                  : view.renewalParent ? 'same use'
                  : g.newOptionIds.includes(l.optionId) ? 'new'
                    : 'already licensed, priced again in the combined scope'}
              </span>
            </span>
            {(() => { const q = firstQuote(l.optionId); return q && <span className="text-meta text-muted-foreground">The client wrote: “{q}”</span>; })()}
          </li>
        ))}
      </ul>
      <p className="text-body">
        Total <span className="font-mono tabular">{usd(g.totalCents)}</span>
        <span className="text-muted-foreground"> {g.paidCents > 0 ? `= ${usd(g.combinedCents)} for the full scope minus ${usd(g.paidCents)} already paid` : '= the full scope on your rate card'}. Prices from your {view.cardSource ?? 'rate card'}.</span>
      </p>
    </section>
  );
}

const WHY: Record<string, (r: LedgerRow) => string> = {
  rule: (r) => `${ruleTitle(r)}${r.message ? `: ${r.message}` : ''}`,
  approved: () => 'You approved the quote with the typed total.',
  rejected: () => 'You rejected the quote.',
  'invoice.creating': () => 'The agent started creating the PayPal invoice.',
  'invoice.sent': (r) => `The invoice was sent${r.paypalInvoiceId ? ` (${r.paypalInvoiceId})` : ''}.`,
  'invoice.failed': (r) => `The invoice could not be confirmed as sent${r.message ? `: ${r.message}` : '.'}`,
  'invoice.cancelled': () => 'The invoice was cancelled.',
  grant: (r) => (r.result === 'pass' ? (r.demo ? 'Seeded as paid for the walkthrough.' : 'PayPal confirmed the payment; the file was unlocked.') : `Payment not verified${r.message ? `: ${r.message}` : '.'}`),
  revoked: (r) => (r.demo ? 'Seeded as refunded for the walkthrough.' : r.message ?? 'The payment was refunded; the licence was revoked.'),
};

/** One plain sentence for a ledger row (used by the deal timeline and the ledger). */
export const ledgerSentence = (r: LedgerRow): string => (WHY[r.kind] ?? ((x: LedgerRow) => x.message ?? x.label))(r);

/**
 * One shared check (review B7C-2 finding 1, B7C-3 finding 3, review B7C-3 finding 6): a version revoked only because an
 * earlier licence it built on was refunded. `revokeVersion` (lib/grant.ts) writes this message on those rows; PayPal
 * kept their money, so they are never shown as a refund or with an amount.
 */
export const isCascadedRevoke = (r: Pick<LedgerRow, 'kind' | 'message'>) =>
  r.kind === 'revoked' && !!r.message?.startsWith('Revoked because an earlier licence');

/** Rule ids PayPal cannot take as they are (lib/policy.ts hard blocks); every other stop waits for a typed OK. */
export const HARD_RULES = new Set(['MIN', 'EMAIL']);

/**
 * review B7C final N1 and N2: one past-tense wording for a rule that stopped a quote, used by the bell, the ledger, the
 * deal timeline and the Overview's recent activity. The ledger is history, so it says what happened then, not what
 * is true now ("held", never "waiting").
 */
export const ruleHeld = (rule: string | null) => (rule && HARD_RULES.has(rule) ? 'held: PayPal can’t take it as it is' : 'held for your OK');

/** "R2 passed" or "R2 stopped, held for your OK" (the original words, with the plain wording added after them). */
export const ruleTitle = (r: Pick<LedgerRow, 'rule' | 'result'>) => `${r.rule} ${r.result === 'pass' ? 'passed' : `stopped, ${ruleHeld(r.rule)}`}`;

/** What the agent did on this deal and why, oldest first, from the read-only ledger. */
export function AgentTimeline({ rows }: { rows: LedgerRow[] | null }) {
  if (rows === null) return null;
  const ordered = [...rows].reverse();
  return (
    <section aria-labelledby="timeline-title" className="grid gap-3">
      <h2 id="timeline-title" className="text-d-section">What the agent did</h2>
      {ordered.length === 0 ? <p className="text-body text-muted-foreground">No recorded steps yet.</p> : (
        <ol className="grid gap-2 border-l pl-4 text-body">
          {ordered.map((r) => (
            <li key={r.eventId} className="grid gap-0.5">
              <span className="flex flex-wrap items-center gap-2">
                <time className="text-meta text-muted-foreground" dateTime={new Date(r.createdAt).toISOString()}>{shortDateTime(r.createdAt)}</time>
                {r.demo && <DemoChip />}
              </span>
              <span>{ledgerSentence(r)}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/** "Preview what the client sees": the client's own pay page when one exists, otherwise the public page. */
export function ClientPreviewLink({ view, publicPath }: { view: BriefView; publicPath: string | null }) {
  const inv = view.version?.invoice;
  const href = inv?.payPath && !inv.demo ? inv.payPath : publicPath;
  if (!href) return null;
  return (
    <a href={href} target="_blank" rel="noreferrer" className="inline-flex w-fit items-center gap-1.5 text-label underline underline-offset-4">
      {inv?.payPath && !inv.demo ? 'Preview what the client sees (their pay page)' : 'Preview what clients see (your public page)'}
      <ExternalLink aria-hidden className="size-3.5" />
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}
