'use client';
// Client pay page body. Renders what GET /api/pay/:token returns; PayPal is only asked through POST .../check.
// Batch-6 review F14, F20: every response carries a sequence number and only a newer one may replace the view, so a
// slow unpaid poll cannot overwrite a verified check; any failed response shows its error with a retry action.
// Batch 7: glass restyle (docs/superpowers/specs/2026-11-02-client-experience-design.md §5); logic above the JSX unchanged.
import { JourneySteps } from './journey';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { RenewalOptIn } from '@/components/pay/renewal-opt-in';
import { shortDate, usd } from '@/lib/format';
import type { PayView } from '@/lib/pay';
import './glass.css';

const POLL_MS = 3000;
const POLL_FOR_MS = 2 * 60 * 1000;
// B11 item 6: one automatic re-check once the server's 10 s check window (PAY_PAGE_CHECK_MS, server-only) has passed.
const THROTTLE_RETRY_MS = 11_000;
const OFFLINE = 'Could not reach the server. Check your connection, then try again.';
// Chip text. 'paid' is left out on purpose: the chip says Paid only once PayPal has verified the payment.
const STATUS_LABEL: Record<string, string> = { unpaid: 'Waiting for payment', refunded: 'Refunded', cancelled: 'Cancelled', superseded: 'Replaced', expired: 'Ended' };
const fallbackError = (status: number) =>
  status === 429 ? 'Too many requests from this network. Wait a few minutes, then try again.'
  : status === 403 ? 'This request was refused. Open the payment link again from the invoice email, then try again.'
  : status === 404 ? 'This payment link is not valid.'
  : 'Something went wrong on our side. Try again in a moment.';

/** One page per token: a new token starts with fresh state (F14). */
export function PayClient({ token, demo = false }: { token: string; demo?: boolean }) {
  return <PayBody key={token} token={token} demo={demo} />;
}

function PayBody({ token, demo }: { token: string; demo: boolean }) {
  const [view, setView] = useState<PayView | null>(null);
  // Fix round 2 (review #14): a failed check/download stays shown until a check succeeds; a later successful poll only
  // clears a poll error.
  const [readError, setReadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const error = actionError ?? readError;
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pollDone, setPollDone] = useState(false);
  const started = useRef(Date.now());
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seq = useRef(0);
  const applied = useRef(0);
  const base = `/api/pay/${token}`;

  /**
   * Applies a view only if no newer request has already answered. A settled page (paid, refunded...) never goes back
   * to unpaid; genuine later changes such as a refund still apply.
   */
  const current = useRef<PayView | null>(null);
  const apply = useCallback((n: number, v: PayView) => {
    // review #13: a settled result (paid, refunded...) beats an unpaid view whatever order the answers arrive in.
    const settles = v.status !== 'unpaid' && current.current?.status === 'unpaid';
    if (n <= applied.current && !settles) return false;
    if (current.current && current.current.status !== 'unpaid' && v.status === 'unpaid') return false;
    applied.current = Math.max(applied.current, n);
    current.current = v;
    setView(v);
    return true;
  }, []);

  const read = useCallback(async (): Promise<boolean> => {
    const n = ++seq.current;
    try {
      const res = await fetch(base, { cache: 'no-store' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (n >= applied.current) setReadError(body.error ?? fallbackError(res.status));
        return false;
      }
      if (apply(n, body)) setReadError(null);
      return true;
    } catch {
      if (n >= applied.current) setReadError(OFFLINE);
      return false;
    }
  }, [base, apply]);

  const check = useCallback(async (manual: boolean): Promise<boolean> => {
    const n = ++seq.current;
    if (manual) setBusy(true);
    try {
      const res = await fetch(`${base}/check`, { method: 'POST' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setActionError(body.error ?? fallbackError(res.status));
        return false;
      }
      setActionError(null);
      if (body.view) apply(n, body.view);
      if (body.view && body.view.status !== 'unpaid') setNote(null);
      if (manual && body.view?.status === 'unpaid' && body.throttled && !retryTimer.current) {
        retryTimer.current = setTimeout(() => { retryTimer.current = null; void check(false); }, THROTTLE_RETRY_MS);
      }
      if (manual && body.view?.status === 'unpaid') {
        setNote(body.throttled ? 'Checked a moment ago. Payment may still be processing; try again in a few seconds.' : 'Payment may still be processing. PayPal can take a minute to confirm.');
      }
      return true;
    } catch {
      setActionError(OFFLINE);
      return false;
    } finally {
      if (manual) setBusy(false);
    }
  }, [base, apply]);

  async function retry() {
    setNote(null);
    if (await read()) await check(true);
  }

  // On load: read our record, then ask PayPal once. Fix 14: also on focus (back from the PayPal tab).
  useEffect(() => {
    void read().then(() => check(false));
    const onFocus = () => void check(false);
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [read, check]);

  // §2: a 3 s poll of our database only, for at most 2 minutes, while unpaid.
  const unpaid = view?.status === 'unpaid';
  useEffect(() => {
    if (!unpaid) return;
    const t = setInterval(() => {
      if (Date.now() - started.current > POLL_FOR_MS) {
        setPollDone(true);
        clearInterval(t);
        return;
      }
      void read();
    }, POLL_MS);
    return () => {
      clearInterval(t);
      if (retryTimer.current) clearTimeout(retryTimer.current);
      retryTimer.current = null;
    };
  }, [unpaid, read]);

  async function download() {
    setBusy(true);
    setNote(null);
    try {
      const res = await fetch(`${base}/download`, { method: 'POST' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) return setActionError(body.error ?? fallbackError(res.status));
      setActionError(null);
      window.location.assign(body.url);
    } catch {
      setActionError(OFFLINE);
    } finally {
      setBusy(false);
    }
  }

  const errorBox = error && (
    <div role="alert" className="grid gap-3 rounded-2xl border border-[var(--g-danger)]/30 bg-[var(--g-danger)]/10 p-4 text-sm text-[var(--g-danger)]">
      <p>{error}</p>
      <button type="button" className="g-btn g-btn-ghost g-btn-sm w-fit" disabled={busy} onClick={() => void retry()}>Try again</button>
    </div>
  );

  const shell = (children: ReactNode) => (
    <div className="theme-glass flex min-h-screen flex-col">
      <div className="g-backdrop" aria-hidden="true"><div className="g-grain" /></div>
      {children}
    </div>
  );

  if (!view) {
    return shell(
      <main className="flex flex-1 items-center justify-center p-6">
        <div className="w-full max-w-md">
          {errorBox || (
            <div className="g-card grid gap-4 p-6" aria-busy="true">
              <p className="text-sm g-muted">Loading...</p>
              <div className="h-40 animate-pulse rounded-xl bg-white/5" />
              <div className="h-4 w-2/3 animate-pulse rounded bg-white/5" />
            </div>
          )}
        </div>
      </main>,
    );
  }

  const settled = view.status === 'paid' && view.verified;
  const spinner = <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" aria-hidden="true" />;
  return shell(
    <>
      <header className="mx-auto flex h-16 w-full max-w-2xl items-center justify-between px-6">
        <a href="/c/imani" className="g-display text-2xl">{view.creatorName}</a>
        <a href="/c/imani" className="text-sm g-muted transition-colors hover:text-white">View work</a>
      </header>

      <main className="mx-auto flex w-full max-w-xl flex-1 flex-col gap-6 p-6 md:py-10">
        {/* B16: where the client is in the journey; the receipt step is reached only once PayPal verified the payment. */}
        <JourneySteps current={settled ? 3 : 2} />
        <header className="g-rise grid gap-2">
          <p className="text-sm g-muted">Image licence from {view.creatorName}</p>
          <h1 className="g-display text-4xl sm:text-5xl">{view.assetTitle}</h1>
        </header>

        <div className="g-rise overflow-hidden rounded-[20px] border border-white/10 bg-black/30 p-2" style={{ animationDelay: '80ms' }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={view.previewPath} alt={`Watermarked preview of ${view.assetTitle}`} className="mx-auto max-h-64 w-auto rounded-xl object-contain" />
        </div>

        <div className="g-card g-rise flex flex-col gap-5 p-6 text-sm" style={{ animationDelay: '160ms' }}>
          <div className="flex items-center justify-between border-b border-white/10 pb-4">
            <h2 className="text-base font-medium">Licence v{view.versionNo}</h2>
            <span className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs">
              {view.status === 'unpaid'
                ? <span className="g-live-dot" aria-hidden="true" />
                : <span className={`h-2 w-2 rounded-full ${settled ? 'bg-[var(--g-ok)]' : 'bg-white/40'}`} aria-hidden="true" />}
              <span className="g-muted">{settled ? 'Paid' : STATUS_LABEL[view.status] ?? 'Checking with PayPal'}</span>
            </span>
          </div>

            {view.gap && (
              <div className="space-y-2 border-b border-white/10 pb-4 text-sm" aria-label="Licence price breakdown">
                <p>{view.gap.renewal ? `Renewal of ${view.gap.addedScope}. Earlier payments covered the previous term.`
                  : view.gap.currentScope ? `You already hold ${view.gap.currentScope}, paid ${usd(view.gap.paidCents)}.`
                  : 'This is the first licence for this photo.'}</p>
                {!view.gap.renewal && <p>{view.gap.currentScope ? `This adds ${view.gap.addedScope || 'no additional use'} for the rest of the term.` : `Adding ${view.gap.addedScope}.`}</p>}
                <p className="g-mono">{view.gap.renewal ? `${usd(view.totalCents)} for the next term`
                  : view.gap.currentScope ? `${usd(view.gap.combinedCents)} full scope − ${usd(view.gap.paidCents)} paid = ${usd(view.totalCents)} due now`
                  : `${usd(view.totalCents)} on ${view.creatorName}'s rate card`}</p>
              </div>
            )}
            <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2">
            <dt className="g-muted">Use</dt>
            <dd>{view.scope}</dd>
            <dt className="g-muted">{view.gap && view.gap.paidCents > 0 && !view.gap.renewal ? 'Due now' : 'Total'}</dt>
            <dd className="g-mono text-lg text-white">{usd(view.totalCents)} {view.currency}</dd>
            <dt className="g-muted">You get</dt>
            <dd>{view.fileLabel}</dd>
            {view.term.startAt && (
              <>
                <dt className="g-muted">Runs</dt>
                <dd>{shortDate(view.term.startAt)} to {shortDate(view.term.endAt)}</dd>
              </>
            )}
          </dl>

          {/* Batch 8 §2: the renewal choice (before and after payment, until the renewal invoice is out). */}
          {(view.status === 'unpaid' || view.status === 'paid') && <RenewalOptIn token={token} view={view} onView={(v) => apply(++seq.current, v)} />}

          <div className="flex items-center gap-3 rounded-2xl border border-white/10 bg-white/[0.04] p-3 text-xs g-muted">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true" className="shrink-0 text-[var(--g-accent)]">
              <rect x="3" y="7" width="10" height="7" rx="2" stroke="currentColor" strokeWidth="1.4" />
              <path d="M5.5 7V5a2.5 2.5 0 015 0v2" stroke="currentColor" strokeWidth="1.4" />
            </svg>
            <span>Files unlock only after PayPal confirms payment.</span>
          </div>

          {errorBox}

          {view.status === 'unpaid' && view.rail === 'invoice' && (
            <div className="grid gap-3 pt-1">
              {view.refusal && (
                <p role="alert" className="rounded-2xl border border-[var(--g-danger)]/30 bg-[var(--g-danger)]/10 p-3 text-xs text-[var(--g-danger)]">
                  <strong>Payment not verified, file locked.</strong> {view.refusal}
                </p>
              )}
              <div className="flex flex-wrap gap-3">
                {view.payerUrl && (
                  <a className="g-btn g-btn-primary" href={view.payerUrl} target="_blank" rel="noopener noreferrer">
                    Pay with PayPal
                    <svg className="g-arrow" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 8h10M9 4l4 4-4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
                  </a>
                )}
                <button type="button" className="g-btn g-btn-ghost" disabled={busy} onClick={() => void check(true)}>
                  {busy && spinner}
                  I&apos;ve paid, check now
                </button>
              </div>
              {!error && (
                <p className="text-xs g-muted">
                  {pollDone ? 'Still waiting for PayPal. Payment may still be processing; use "check now".' : 'This page updates by itself once PayPal confirms the payment.'}
                </p>
              )}
            </div>
          )}

          {view.status === 'unpaid' && view.rail === 'order' && <div data-slot="card-fields" />}

          {view.status === 'paid' && view.verified && (
            <div className="g-rise grid gap-4 pt-1">
              <p role="status" className="flex items-start gap-3 rounded-2xl border border-[var(--g-ok)]/30 bg-[var(--g-ok)]/10 p-3 text-xs text-[var(--g-ok)]">
                <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true" className="mt-px shrink-0">
                  <circle cx="9" cy="9" r="8" stroke="currentColor" strokeWidth="1.4" />
                  <path className="g-draw" d="M5.5 9.2l2.3 2.3 4.7-5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                <span><strong>Verified with PayPal.</strong> {usd(view.verified.amountCents)} USD, PayPal transaction {view.verified.paypalTransactionId}.</span>
              </p>
              <div className="flex flex-wrap gap-3">
                <button type="button" className="g-btn g-btn-primary" disabled={busy} onClick={() => void download()}>
                  {busy && spinner}
                  Download {view.fileLabel.toLowerCase()}
                </button>
                {view.receiptPath && <a className="g-btn g-btn-ghost" href={view.receiptPath}>Rights receipt</a>}
              </div>
            </div>
          )}

          {view.status === 'refunded' && (
            <p role="status" className="rounded-2xl border border-[var(--g-danger)]/30 bg-[var(--g-danger)]/10 p-3 text-xs font-medium text-[var(--g-danger)]">
              This payment was refunded, so the licence is no longer active and the file cannot be downloaded.
            </p>
          )}
          {view.status === 'cancelled' && (
            <p role="status" className="rounded-2xl border border-white/10 bg-white/5 p-3 text-xs g-muted">
              This invoice was cancelled. The photographer will send an updated one.
            </p>
          )}
          {view.status === 'superseded' && (
            <p role="status" className="rounded-2xl border border-white/10 bg-white/5 p-3 text-xs g-muted">
              This licence was replaced by a newer one. Use the link from the newer invoice.
            </p>
          )}
          {view.status === 'expired' && (
            <p role="status" className="rounded-2xl border border-white/10 bg-white/5 p-3 text-xs g-muted">
              This licence has ended.
            </p>
          )}

          {view.receiptPath && view.status !== 'paid' && (
            <a className="mt-1 text-xs text-[var(--g-accent)] underline underline-offset-4" href={view.receiptPath}>Rights receipt</a>
          )}
          {note && <p role="status" className="text-xs italic g-muted">{note}</p>}
        </div>
      </main>

      <footer className="border-t border-white/10 py-6 text-center text-xs g-muted">
        <p>This payment link is unique to your invoice. Files unlock only after PayPal confirms payment.</p>
        {demo && <p className="mt-1">Demo mode: this is PayPal sandbox, and the test logins are in the testing instructions on Devpost.</p>}
      </footer>
    </>,
  );
}
