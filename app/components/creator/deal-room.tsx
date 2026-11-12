'use client';
// Deal room body (batch-4 §3, docs/ui/deal-room.md). Pure: renders a BriefView in any state, including those with
// no price yet. Order: header, observed work, source | licence + price, rules, next step (approval), invoice, setup.
// Every stage shown is read from the view; nothing is marked done without the row that proves it. A seeded demo
// invoice (`invoice.demo`) never reads as PayPal evidence and offers no PayPal actions.
import { AlertTriangle, Check, ChevronDown, Circle, Clock, Loader2, X } from 'lucide-react';
import Link from 'next/link';
import { useRef, useState, type ReactNode } from 'react';
import { DealSetup, type Edit, type Options } from '@/components/creator/deal-setup';
import { GapTable, LicenceCard } from '@/components/creator/licence';
import { AgentTimeline, ClientPreviewLink, GapEquation, WhatHappensNext, WhyThisPrice } from '@/components/creator/deal-extras';
import { TermTip, type TermKey } from '@/components/creator/explain';
import { HelpPanel } from '@/components/creator/guide';
import { DemoChip, StatusBadge } from '@/components/creator/page-bits';
import { TranscriptPanel } from '@/components/creator/transcript-panel';
import { TypedTotalField, typedMatches } from '@/components/creator/typed-total';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import type { TranscriptLine } from '@/lib/ai/types';
import type { BriefView } from '@/lib/briefs';
import type { LedgerRow } from '@/lib/ledger';
import { SOURCE_LABEL, shortDate, usd } from '@/lib/format';
import { describeReason, hasPaidUse, PAID_USE_REFUSAL } from '@/lib/reasons';
import { replyDraft } from '@/lib/reply-draft';

export type DecideAction = 'approve' | 'reject' | 'retry' | 'cancel_requote' | 'recheck' | 'rotate_link';

export type DealRoomActions = {
  onEdit: (e: Edit) => void;
  onConfirm: (lines: TranscriptLine[]) => void;
  /** typedTotal is the dollar text the creator typed; the server parses it (batch-5 fix 20). */
  onDecide: (action: DecideAction, typedTotal?: string) => void;
  onCopy: (text: string) => void | Promise<void>;
  onError: (message: string) => void;
  /** review P1: creator asks for the pending email-confirm link (stand-in until outbound email). */
  onIssueVerifyLink?: () => void;
};

const TITLE: Record<string, string> = {
  clarify: 'Ask the client first',
  awaiting_verification: 'Waiting',
  awaiting_transcript: 'Next step',
  ready: 'Checks',
  needs_approval: 'This request needs your approval.',
  failed: 'Send failed',
  cancelled: 'Invoice cancelled',
  rejected: 'Rejected',
  refunded: 'Refunded',
};

const STOP_STATUSES = new Set(['needs_creator', 'clarify', 'needs_approval']);
const DEMO_REFUNDED = 'Seeded as refunded for the walkthrough. No PayPal refund happened.';

// ---------- observed work rail ----------

type StepState = 'done' | 'working' | 'waiting' | 'stop' | 'failed' | 'todo' | 'skipped';
type Step = { label: string; state: StepState; detail: string };

function observedSteps(view: BriefView): Step[] {
  const v = view.version;
  const s = view.status;
  const x = view.extraction;
  const demo = !!v?.invoice?.demo;
  const steps: Step[] = [];
  // B11 item 5: a renewal has no client message, so nothing was read or checked.
  const notNeeded = (label: string): Step => ({ label, state: 'skipped', detail: 'Not needed: renewal of the same scope' });
  const renewal = view.brief.source === 'renewal';
  steps.push(renewal ? notNeeded('Read') : view.brief.state === 'awaiting_verification'
    ? { label: 'Read', state: 'waiting', detail: 'Waiting for email confirmation' }
    : view.transcript?.confirmed_at ? { label: 'Read', state: 'done', detail: 'Transcript confirmed' }
      : view.brief.state === 'awaiting_transcript' ? { label: 'Read', state: 'waiting', detail: 'Confirm the transcript' }
        : { label: 'Read', state: 'todo', detail: 'Not recorded' });
  steps.push(renewal ? notNeeded('Checks') : !x ? { label: 'Checks', state: 'todo', detail: 'Not run yet' }
    : x.status === 'ready' ? { label: 'Checks', state: 'done', detail: `${view.checks?.kept.length ?? 0} use${(view.checks?.kept.length ?? 0) === 1 ? '' : 's'} with a client sentence` }
      : { label: 'Checks', state: 'stop', detail: x.status === 'clarify' ? 'Ask the client first' : 'Needs you' });
  steps.push(view.gapPreview ? { label: 'Price', state: 'done', detail: `${usd(view.gapPreview.totalCents)} from your rate card` } : { label: 'Price', state: 'todo', detail: 'No price yet' });
  const failing = v?.policy?.results.filter((r) => !r.pass).length ?? 0;
  steps.push(!v?.policy ? { label: 'Rules', state: 'todo', detail: 'Not evaluated' }
    : v.policy.pass ? { label: 'Rules', state: 'done', detail: 'R1-R5 passed' }
      : { label: 'Rules', state: 'stop', detail: `${failing} rule${failing === 1 ? '' : 's'} stopped` });
  const inv = v?.invoice;
  steps.push(s === 'sending' ? { label: 'Invoice', state: 'working', detail: 'Sending to PayPal' }
    : s === 'failed' ? { label: 'Invoice', state: 'failed', detail: 'Not confirmed as sent' }
      : inv?.state === 'cancelled' ? { label: 'Invoice', state: 'failed', detail: 'Cancelled' }
        : inv && ['sent', 'paid', 'refunded'].includes(inv.state)
          // B11 item 2, kept after B12 E5 removed the step crumb: the rail names who sent it.
          ? { label: 'Invoice', state: 'done', detail: demo ? 'Seeded (demo)' : view.sentBy === 'agent' ? 'Sent by Autopilot' : view.sentBy === 'you' ? 'You approved, then sent' : 'Sent' }
          : { label: 'Invoice', state: 'todo', detail: 'Not sent' });
  steps.push(s === 'paid' ? { label: 'Paid', state: 'done', detail: demo ? 'Seeded as paid (demo)' : 'File unlocked' }
    : s === 'refunded' ? { label: 'Paid', state: 'failed', detail: demo ? 'Seeded as refunded (demo)' : 'Refunded, downloads stopped' }
      : { label: 'Paid', state: 'todo', detail: 'Not paid' });
  return steps;
}

const STEP_LOOK: Record<StepState, { icon: ReactNode; words: string; tone: string }> = {
  done: { icon: <Check aria-hidden className="size-3.5" />, words: 'done', tone: 'border-foreground/30 text-foreground' },
  working: { icon: <Loader2 aria-hidden className="size-3.5 motion-safe:animate-spin" />, words: 'in progress', tone: 'border-ring text-foreground' },
  waiting: { icon: <Clock aria-hidden className="size-3.5" />, words: 'waiting for a person', tone: 'border-ring text-foreground' },
  stop: { icon: <AlertTriangle aria-hidden className="size-3.5" />, words: 'stopped', tone: 'border-warning/50 bg-warning-bg text-warning' },
  failed: { icon: <X aria-hidden className="size-3.5" />, words: 'failed', tone: 'border-destructive/40 bg-destructive-bg text-destructive' },
  todo: { icon: <Circle aria-hidden className="size-2.5" />, words: 'not reached', tone: 'border-border text-muted-foreground' },
  skipped: { icon: <Circle aria-hidden className="size-2.5" />, words: 'not needed', tone: 'border-border text-muted-foreground' },
};

function WorkRail({ view }: { view: BriefView }) {
  const steps = observedSteps(view);
  return (
    <section aria-labelledby="work-title">
      <h2 id="work-title" className="sr-only">Observed work</h2>
      <ol className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {steps.map((st) => {
          const look = STEP_LOOK[st.state];
          return (
            <li key={st.label} className="flex items-start gap-2">
              <span className={`mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-full border ${look.tone}`}>{look.icon}</span>
              <span className="grid min-w-0">
                <span className="text-label">{st.label}<span className="sr-only">: {look.words}</span></span>
                <span className="text-meta text-muted-foreground">{st.detail}</span>
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

// ---------- rule strip ----------

function RuleStrip({ policy }: { policy: NonNullable<NonNullable<BriefView['version']>['policy']> }) {
  const passed = policy.results.filter((r) => r.pass).length;
  const stopped = policy.results.length - passed;
  return (
    <div className="grid gap-3">
      <p className="text-meta text-muted-foreground">{passed} passed, {stopped} stopped.</p>
      <ul className="grid gap-x-6 gap-y-2 md:grid-cols-2">
        {policy.results.map((r, i) => (
          <li key={`${r.rule}-${i}`} className="flex items-start gap-2 text-body">
            <span className={`mt-0.5 inline-flex h-6 shrink-0 items-center gap-1 rounded-md border px-1.5 font-mono text-id ${r.pass ? 'text-foreground' : 'border-warning/50 bg-warning-bg text-warning'}`}>
              {r.pass ? <Check aria-hidden className="size-3.5" /> : <AlertTriangle aria-hidden className="size-3.5" />}
              {r.rule}
              <span className="sr-only">{r.pass ? ' passed' : ' stopped'}</span>
            </span>
            <span className={r.pass ? 'text-muted-foreground' : ''}>{r.message}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Section({ title, id, children, className = '', focusable = false, tip }: { title: string; id: string; children: ReactNode; className?: string; focusable?: boolean; tip?: TermKey }) {
  return (
  // B18: min-w-0 lets a card shrink to its column; without it a long unbroken line (the pay link) widened the left column over the right one.
    <section aria-labelledby={id} className={`grid min-w-0 content-start ${className}`}>
      <Card className="min-w-0 gap-4 p-5 shadow-none">
      <CardHeader className="flex items-center gap-2 px-0 py-0">
        <h2 id={id} tabIndex={focusable ? -1 : undefined} className="text-d-section outline-none">{title}</h2>
        {tip && <TermTip term={tip} />}
      </CardHeader>
      <CardContent className="grid content-start gap-3 px-0">{children}</CardContent>
      </Card>
    </section>
  );
}

const focusSoon = (el: () => HTMLElement | null | undefined) => setTimeout(() => el()?.focus(), 0);

export function DealRoomView({ view, options, busy, actions, verifyLink = null, timeline = null, publicPath = null }: {
  view: BriefView; options: Options | null; busy: boolean; actions: DealRoomActions;
  verifyLink?: { url: string; email: string } | null;
  /** Batch 7C: this deal's ledger rows (read only), for the agent timeline; null hides it. */
  timeline?: LedgerRow[] | null;
  /** Batch 7C: the creator's public page, for the client-preview link. */
  publicPath?: string | null;
}) {
  const [typedTotal, setTypedTotal] = useState('');
  const [typedBlurred, setTypedBlurred] = useState(false);
  // Batch-6 review F17: replacing the client link is destructive, so it asks first.
  const [confirmRotate, setConfirmRotate] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const cancelTrigger = useRef<HTMLButtonElement>(null);
  const keepInvoice = useRef<HTMLButtonElement>(null);
  const rotateTrigger = useRef<HTMLButtonElement>(null);
  const keepLink = useRef<HTMLButtonElement>(null);
  const { status, reasons } = view;
  const question = view.extraction?.clarifying_question ?? null;
  // B11 item 1: the paid-use stop offers Reject only, so Setup does not open itself; an edit there could not send it anyway.
  const paidUse = status === 'needs_creator' && hasPaidUse(reasons);
  const needsSetup = !view.client || !view.asset || (status === 'needs_creator' && !paidUse);
  const [setupOpen, setSetupOpen] = useState(needsSetup);

  const v = view.version;
  const canApprove = status === 'needs_approval' && !v?.policy?.hardBlock;
  const demo = !!v?.invoice?.demo;
  const stopped = STOP_STATUSES.has(status);
  const approveTotal = v?.status === 'pending' ? v.totalCents : view.gapPreview?.totalCents ?? null;
  const showApproveForm = !paidUse && (canApprove || (status === 'needs_creator' && !!view.gapPreview)) && approveTotal !== null;
  const matches = approveTotal !== null && typedMatches(typedTotal, approveTotal);
  const draft = replyDraft(view);
  const reasonText = (r: string) => (demo && r === 'refunded' ? DEMO_REFUNDED : describeReason(r));

  function approve() {
    if (!matches) return setTypedBlurred(true);
    actions.onDecide('approve', typedTotal.trim());
  }

  const nextStep = reasons.length > 0 && (
    <section
      id="next-step"
      aria-labelledby="next-title"
      className={`grid gap-3 rounded-md border p-4 ${stopped ? 'border-warning/50 bg-warning-bg' : status === 'refunded' || status === 'failed' ? 'border-destructive/40 bg-destructive-bg' : 'bg-card'}`}
    >
      <h2 id="next-title" className={`flex items-center gap-2 text-d-section ${stopped ? 'text-warning' : ''}`}>
        {stopped && <AlertTriangle aria-hidden className="size-4" />}
        {TITLE[status] ?? 'Why this needs you'}
      </h2>
      <ul className="grid gap-1 text-body">
        {reasons.map((r) => <li key={r}>{reasonText(r)}</li>)}
      </ul>
      {paidUse && <p className="text-body font-medium">{PAID_USE_REFUSAL}</p>}
      {status === 'awaiting_verification' && actions.onIssueVerifyLink && (
        <div className="grid gap-2 border-t pt-3 text-body">
          <p className="max-w-prose">Until emails are sent automatically, you can pass this one-time link to the requester yourself. It confirms their address only; they are not added to your allowed clients.</p>
          {verifyLink ? (
            <p className="break-all">
              For {verifyLink.email}: <code className="font-mono text-id">{verifyLink.url}</code>{' '}
              <Button size="sm" variant="outline" onClick={() => actions.onCopy(new URL(verifyLink.url, window.location.origin).href)}>Copy link</Button>
            </p>
          ) : (
            <Button variant="outline" className="w-fit" disabled={busy} onClick={actions.onIssueVerifyLink}>
              {busy ? 'Creating confirmation link…' : 'Get the confirmation link'}
            </Button>
          )}
        </div>
      )}
      {status === 'clarify' && question && (
        <div className="grid gap-2 border-t pt-3 text-body">
          <blockquote className="max-w-prose font-medium">{question}</blockquote>
          <Button variant="outline" className="w-fit" onClick={() => actions.onCopy(question)}>Copy question</Button>
        </div>
      )}
      {(canApprove || status === 'needs_creator') && (
        <form className="flex flex-wrap items-start gap-3 border-t pt-3" onSubmit={(e) => { e.preventDefault(); approve(); }}>
          {showApproveForm && (
            <>
              <TypedTotalField id="typed" value={typedTotal} totalCents={approveTotal!} blurred={typedBlurred} disabled={busy}
                onChange={setTypedTotal} onBlur={() => setTypedBlurred(true)}
                actions={<>
                  <Button type="submit" className="h-11" disabled={busy || !matches}>Approve and send {usd(approveTotal!)} invoice</Button>
                  <Button type="button" className="h-11" disabled={busy} variant="outline" onClick={() => actions.onDecide('reject')}>Reject</Button>
                </>} />
            </>
          )}
          {!showApproveForm && <Button type="button" className="h-11" disabled={busy} variant="outline" onClick={() => actions.onDecide('reject')}>Reject</Button>}
        </form>
      )}
      {status === 'needs_approval' && v?.policy?.hardBlock && (
        <p className="text-body">Approving cannot fix this. Change the deal or client record first.</p>
      )}
    </section>
  );

  return (
    <article className="grid gap-8">
      {/* B16: the deal's header is type on the ground, not a card (impeccable: don't wrap everything in a container). */}
      <header className="grid gap-4 border-b pb-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid gap-2">
        <Link href="/deals" className="w-fit text-label text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">All deals</Link>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-d-page">{view.client?.name ?? 'Unknown sender'} · {view.asset?.title ?? 'no photo picked'}</h1>
          <StatusBadge status={status} demo={demo} hardBlock={!!v?.policy?.hardBlock} paidUse={paidUse} />
        </div>
        </div>
        {reasons.length > 0 && <Button asChild className="min-h-11"><a href="#next-step">Review the next step</a></Button>}
      </div>
      <div className="grid gap-3">
        <p className="text-body text-muted-foreground">
          {view.brief.source === 'renewal' ? 'Opened by the agent' : <>From {(SOURCE_LABEL[view.brief.source] ?? view.brief.source).toLowerCase()}{view.brief.claimed_sender ? `, signed "${view.brief.claimed_sender}"` : ''}, received {shortDate(view.brief.created_at)}</>}
        </p>
        <ClientPreviewLink view={view} publicPath={publicPath} />
        <GapEquation view={view} />
      </div>
      </header>

      <HelpPanel id="deal-room">
        <p>This is one client request from start to finish. The row of steps shows only what has really happened: read, checked, priced, rules, invoice, paid.</p>
        <p><strong>The client’s words</strong> highlights each sentence the model used; the small number on it matches a line in <strong>Price</strong>. The model only reads. Code prices each amount from your rate card, minus what the client already paid, and an AI price suggestion is shown struck out and never used.</p>
        <p><strong>Rules</strong> R1 to R5 decide whether the agent may send the invoice on its own. If any stops, the next step below asks for your typed total.</p>
      </HelpPanel>

      <div className="grid gap-3">
        <WorkRail view={view} />
        <WhatHappensNext view={view} />
      </div>

      {view.notes.length > 0 && (
        <Section title="Noted (you reviewed these)" id="notes-title">
          <p className="text-body text-muted-foreground">These would normally stop the deal. You edited the uses yourself, so they do not.</p>
          <ul className="grid gap-1 text-body text-muted-foreground">
            {view.notes.map((n) => <li key={n}>{describeReason(n)}</li>)}
          </ul>
        </Section>
      )}

      <div className="grid gap-8 lg:grid-cols-[minmax(0,35fr)_minmax(0,26.5fr)] lg:gap-6">
        <div className="grid content-start gap-8">
        <Section title="The client’s words" id="source-title">
          {view.brief.source === 'renewal'
            ? (
              // Batch 8 plan fix 5: a renewal has no client message; the agent opened it before the licence ends.
              <p className="max-w-prose text-body text-muted-foreground">No client message: {view.brief.raw}</p>
            )
            : <TranscriptPanel view={view} onConfirm={actions.onConfirm} busy={busy} />}
        </Section>
        {/* B16: the reply draft fills the left column under the client's words, so both columns end together. */}
        {draft && (
          <Section title="Reply draft" id="reply-title">
            <p className="max-w-prose text-label text-muted-foreground">Written by code from the client’s sentences, your rate card and the pay link. The app sends nothing: copy it into your own reply.</p>
            <pre className="rounded-md bg-muted p-4 font-sans text-body text-[13px] leading-relaxed [overflow-wrap:anywhere] whitespace-pre-wrap">{draft}</pre>
            <Button variant="outline" className="w-fit" onClick={() => actions.onCopy(draft)}>Copy reply</Button>
          </Section>
        )}
        </div>
        <div className="grid content-start gap-8">
          <Section title="Current licence" id="licence-title" tip="licenceVersion">{paidUse && !view.licence ? <p className="text-body text-muted-foreground">No licence yet.</p> : <LicenceCard licence={view.licence} />}</Section>
          {!paidUse && <Section title="Price" id="price-title" tip="scope"><GapTable view={view} /><WhyThisPrice view={view} /></Section>}
        </div>
      </div>

      {v?.policy && <Section title="Rules" id="rules-title" tip="rules"><RuleStrip policy={v.policy} /></Section>}

      {/* review 9: the decision comes after the evidence, price and rules. */}
      {nextStep}

      {v && (status === 'sending' || status === 'invoiced' || status === 'failed' || status === 'cancelled' || status === 'paid' || status === 'refunded') && (
        <Section title="Invoice" id="invoice-title" focusable>
          {status === 'sending' && <p role="status" className="text-body">Sending the invoice to PayPal now. This page will not send it twice.</p>}
          {demo && (
            <div className="flex max-w-prose flex-wrap items-start gap-2 rounded-md border border-dashed p-3 text-body text-muted-foreground">
              <DemoChip />
              <p>Demo data: this invoice and its payment were seeded for the walkthrough. They were not sent through PayPal, so the PayPal actions are off.</p>
            </div>
          )}
          {v.invoice && (
            <dl className="grid max-w-3xl gap-x-6 gap-y-2 text-body sm:grid-cols-[10rem_minmax(0,1fr)]">
              <dt className="text-muted-foreground">Quote</dt><dd>v{v.versionNo}, <span className="font-mono tabular">{usd(v.totalCents)}</span></dd>
              <dt className="text-muted-foreground">Invoice number</dt><dd className="font-mono text-id break-all">{v.invoice.invoiceNumber}</dd>
              <dt className="text-muted-foreground">{demo ? 'Demo invoice id' : 'PayPal invoice id'}</dt><dd className="font-mono text-id break-all">{v.invoice.paypalInvoiceId ?? '—'}</dd>
              <dt className="text-muted-foreground">State</dt><dd>{v.invoice.state}</dd>
              {view.proof && (
                <>
                  <dt className="text-muted-foreground">Last PayPal re-check</dt>
                  <dd>{view.proof.lastCheck ? <>{view.proof.lastCheck.message} <span className="text-muted-foreground">({new Date(view.proof.lastCheck.at).toLocaleString()})</span></> : <span className="text-muted-foreground">Not checked yet</span>}</dd>
                  <dt className="text-muted-foreground">PayPal webhook</dt>
                  <dd>{view.proof.webhook ? <>{view.proof.webhook.type}, signature verified by PayPal <span className="text-muted-foreground">({new Date(view.proof.webhook.at).toLocaleString()})</span></> : <span className="text-muted-foreground">No webhook for this invoice yet. Only a re-check unlocks the file either way.</span>}</dd>
                </>
              )}
              {v.invoice.payerUrl && !demo && (<><dt className="text-muted-foreground">Payer link</dt><dd><a className="break-all underline underline-offset-4" href={v.invoice.payerUrl} target="_blank" rel="noreferrer">{v.invoice.payerUrl}<span className="sr-only"> (opens in a new tab)</span></a></dd></>)}
            </dl>
          )}
          {status === 'failed' && (
            <>
              <p role="alert" className="text-body text-destructive">{v.sendError ?? 'The invoice could not be confirmed as sent. Check with PayPal before retrying.'}</p>
              {!demo && <Button className="w-fit" disabled={busy} onClick={() => actions.onDecide('retry')}>Retry</Button>}
            </>
          )}
          {status === 'invoiced' && (
            <div className="grid gap-3">
              <p className="text-body">{demo ? 'Seeded as sent. No client will pay it.' : 'Invoice sent. Waiting for PayPal to confirm payment.'}</p>
              {!v.invoice?.payerUrl && !demo && (
                <Button variant="outline" className="w-fit" disabled={busy} onClick={() => actions.onDecide('retry')}>Get the payer link from PayPal</Button>
              )}
              {!demo && (
                <>
                  <p className="text-body text-muted-foreground">The scope and recipient are locked while this invoice is out. To change them, cancel it first.</p>
                  {!confirmCancel ? (
                    <Button ref={cancelTrigger} variant="outline" className="w-fit" disabled={busy}
                      onClick={() => { setConfirmCancel(true); focusSoon(() => keepInvoice.current); }}>
                      Cancel invoice and re-quote
                    </Button>
                  ) : (
                    <div role="group" aria-labelledby="cancel-title" className="grid max-w-prose gap-2 rounded-md border border-warning/50 bg-warning-bg p-3">
                      <p id="cancel-title" className="text-body font-medium">Cancel this invoice? The client will need a new quote.</p>
                      <div className="flex flex-wrap gap-2">
                        <Button ref={keepInvoice} variant="outline" disabled={busy}
                          onClick={() => { setConfirmCancel(false); focusSoon(() => cancelTrigger.current); }}>
                          Keep invoice
                        </Button>
                        <Button disabled={busy}
                          onClick={() => { setConfirmCancel(false); actions.onDecide('cancel_requote'); focusSoon(() => document.getElementById('invoice-title')); }}>
                          Cancel invoice
                        </Button>
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          )}
          {status === 'cancelled' && <p className="text-body text-muted-foreground">Invoice cancelled. Edit the uses, client or photo to make a new quote.</p>}
          {status === 'paid' && (demo
            ? <p role="status" className="text-body">Seeded as paid for the walkthrough. This is not a PayPal payment, and PayPal unlocked nothing.</p>
            : <p role="status" className="flex items-center gap-2 text-body font-medium text-success"><Check aria-hidden className="size-4" />Paid and verified with PayPal. The client&apos;s file is unlocked and a rights receipt was issued.</p>)}
          {status === 'refunded' && <p role="status" className="text-body text-destructive">{demo ? DEMO_REFUNDED : 'Refunded in PayPal. The licence is revoked and downloads are stopped.'}</p>}
          {v.invoice?.payPath && !demo && (status === 'invoiced' || status === 'paid') && (
            <div className="grid max-w-3xl gap-2 rounded-md border p-3">
              <p className="text-label">Client link</p>
              <p className="font-mono text-id break-all">{v.invoice.payUrl ?? v.invoice.payPath}</p>
              {!confirmRotate ? (
                <>
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant="outline" onClick={() => actions.onCopy(v.invoice!.payUrl ?? new URL(v.invoice!.payPath!, window.location.origin).href)}>Copy client link</Button>
                    <Button ref={rotateTrigger} size="sm" variant="ghost" disabled={busy}
                      onClick={() => { setConfirmRotate(true); focusSoon(() => keepLink.current); }}>
                      Replace link
                    </Button>
                  </div>
                  <p className="text-meta text-muted-foreground">This is the same link PayPal&apos;s invoice email carries.</p>
                </>
              ) : (
                <div role="alertdialog" aria-labelledby="rotate-title" aria-describedby="rotate-desc" className="grid gap-2 rounded-md border border-destructive/40 bg-destructive-bg p-3">
                  <p id="rotate-title" className="text-body font-medium">Replace the client link?</p>
                  <p id="rotate-desc" className="text-body">
                    The link you already shared, including the one in PayPal&apos;s invoice email, stops working at once, and any download links issued from it stop too. You will need to send the client the new link.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Button ref={keepLink} size="sm" variant="outline" disabled={busy}
                      onClick={() => { setConfirmRotate(false); focusSoon(() => rotateTrigger.current); }}>
                      Keep current link
                    </Button>
                    <Button size="sm" variant="destructive" disabled={busy}
                      onClick={() => { setConfirmRotate(false); actions.onDecide('rotate_link'); focusSoon(() => document.getElementById('invoice-title')); }}>
                      Replace link
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}
          {(status === 'invoiced' || status === 'paid') && !demo && (
            <div className="flex flex-wrap items-center gap-3">
              <Button variant="outline" className="w-fit" disabled={busy} onClick={() => actions.onDecide('recheck')}>Re-check PayPal</Button>
              {v.invoice?.lastCheckedAt && <span className="text-meta text-muted-foreground">PayPal last checked: {new Date(v.invoice.lastCheckedAt).toLocaleString()}</span>}
            </div>
          )}
        </Section>
      )}

      <AgentTimeline rows={timeline} />

      <Collapsible open={setupOpen} onOpenChange={setSetupOpen} className="border-t pt-4">
        <CollapsibleTrigger asChild>
          <Button variant="ghost" className="-ml-3 gap-2">
            <ChevronDown aria-hidden className={`size-4 transition-transform ${setupOpen ? 'rotate-180' : ''}`} />
            Setup and technical details
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="pt-4">
          <Section title="Deal setup" id="setup-title">
            <DealSetup view={view} options={options} onEdit={actions.onEdit} busy={busy} />
          </Section>
        </CollapsibleContent>
      </Collapsible>
    </article>
  );
}
