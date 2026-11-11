'use client';
// /ask (batch-5 §3, fix 13; docs/ui/ask.md): quotes the autopilot stopped. The creator types the exact total to
// approve. Typed-total guidance uses the shared parser only; the server re-checks amount, version and permission.
import { AlertTriangle, ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ruleInPlainWords, TermTip } from '@/components/creator/explain';
import { askNextSteps, HelpPanel, NextStepBanner, type NextStep } from '@/components/creator/guide';
import { DemoChip, EmptyState, LoadError, LoadingRows, PageHeader } from '@/components/creator/page-bits';
import { TypedTotalField, typedMatches } from '@/components/creator/typed-total';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { shortDate, usd } from '@/lib/format';
import type { AskAlert, AskItem } from '@/lib/ledger';

type Outcome = { kind: 'error' | 'done'; text: string; briefId?: string; payerUrl?: string | null };
type Busy = { id: string; action: 'approve' | 'reject' } | null;

const STALE = 'This quote changed. Review the latest version before approving.';

export default function AskPage() {
  const router = useRouter();
  const [items, setItems] = useState<AskItem[] | null>(null);
  /** Cards the server no longer lists, kept so their outcome (done, stale, uncertain) stays readable. */
  const [gone, setGone] = useState<Set<string>>(new Set());
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [blurred, setBlurred] = useState<Record<string, boolean>>({});
  const [outcome, setOutcome] = useState<Record<string, Outcome>>({});
  const [busy, setBusy] = useState<Busy>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [alerts, setAlerts] = useState<AskAlert[]>([]);
  const outcomeRef = useRef(outcome);
  const headingRef = useRef<HTMLDivElement>(null);
  useEffect(() => { outcomeRef.current = outcome; }, [outcome]);

  /** Fresh queue from the server; cards with a result stay until the creator dismisses them (review 4, review 10). */
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/ask');
      if (res.status === 401) return router.replace('/login?next=/ask');
      if (!res.ok) throw new Error(String(res.status));
      const payload = (await res.json()) as { items: AskItem[]; alerts?: AskAlert[] };
      const fresh = payload.items;
      setAlerts(payload.alerts ?? []);
      setLoadError(null);
      setItems((prev) => {
        const kept = (prev ?? []).filter((i) => outcomeRef.current[i.versionId] && !fresh.some((f) => f.versionId === i.versionId));
        setGone(new Set(kept.map((i) => i.versionId)));
        return [...kept, ...fresh];
      });
    } catch {
      setLoadError('Couldn’t load approvals. Try again.');
    } finally {
      setLoading(false);
    }
  }, [router]);
  useEffect(() => { void load(); }, [load]);

  // The ref is updated at once, so a reload started right after this result already keeps the card.
  const setOne = (id: string, o: Outcome) => {
    outcomeRef.current = { ...outcomeRef.current, [id]: o };
    setOutcome((all) => ({ ...all, [id]: o }));
  };
  const focusOutcome = (id: string) => setTimeout(() => document.getElementById(`o-${id}`)?.focus(), 0);

  async function act(item: AskItem, action: 'approve' | 'reject') {
    setBusy({ id: item.versionId, action });
    try {
      const res = await fetch('/api/ask', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ versionId: item.versionId, action, typedTotal: typed[item.versionId] ?? '' }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setOne(item.versionId, { kind: 'error', text: body.code === 'stale' ? STALE : body.error ?? 'Something went wrong.', briefId: item.briefId });
        if (body.code === 'stale') await load(); // review 10: the card was out of date; show the current quote
        return;
      }
      setOne(item.versionId, action === 'approve'
        ? { kind: 'done', text: `Approved by you, invoice sent. PayPal invoice ${body.paypalInvoiceId} (${body.invoiceNumber}).`, briefId: item.briefId, payerUrl: body.payerUrl ?? null }
        : { kind: 'done', text: 'Rejected. No new invoice was sent by this action.', briefId: item.briefId });
      focusOutcome(item.versionId);
    } catch {
      // review 3: a network failure never leaves the buttons disabled; re-read the queue before another try.
      setOne(item.versionId, { kind: 'error', text: 'Could not reach the server. Couldn’t confirm the result. Open the deal before trying again.', briefId: item.briefId });
      await load();
    } finally {
      setBusy(null);
    }
  }

  function dismiss(versionId: string) {
    const list = items ?? [];
    const at = list.findIndex((i) => i.versionId === versionId);
    const next = list[at + 1] ?? list[at - 1];
    setOutcome(({ [versionId]: _gone, ...rest }) => rest);
    setItems((all) => (all ?? []).filter((i) => i.versionId !== versionId));
    // Focus moves to the next quote, or to the page heading when none is left (or the next card is gone).
    setTimeout(() => {
      const target = (next && document.getElementById(`quote-${next.versionId}`)) || headingRef.current;
      target?.focus();
    }, 0);
    void load();
  }

  return (
    <section className="max-w-[60rem]">
      <div ref={headingRef} className="outline-none" tabIndex={-1}>
        <PageHeader title="Ask me" description="Quotes the agent stopped. Your typed total is the approval." />
      </div>
      <HelpPanel id="ask">
        <p>The agent stops a quote and brings it here when one of your rules says so, for example: the client is not on your list, the price is over your per-deal cap, you reached today’s send limit or the client’s 30-day cap, the use (for example billboard) is set to always ask you, or a request check is not clear.</p>
        <p>To send it, type the exact total. That typed total is your approval; nothing else sends it. To stop it, choose Reject.</p>
        <p><strong>Payments that need you</strong> lists PayPal events a person must look at, such as a refund on a licence that other quotes built on.</p>
      </HelpPanel>
      {items && (() => {
        // review B7C-1 finding 6: a card whose decision failed or could not be confirmed is still open on the server;
        // it stays in the banner with a safe next step. Done cards and cards the server no longer lists leave it.
        const listed = items.filter((i) => !gone.has(i.versionId));
        const errored = listed.filter((i) => outcome[i.versionId]?.kind === 'error');
        const unsure: NextStep[] = errored.length ? [{
          key: 'unsure', href: `/deals/${errored[0]!.briefId}`, action: 'Check the deal',
          text: `${errored.length} ${errored.length === 1 ? 'decision' : 'decisions'} did not go through or could not be confirmed. Check before trying again`,
        }] : [];
        return <NextStepBanner steps={[...unsure, ...askNextSteps(listed.filter((i) => !outcome[i.versionId]), alerts)]} />;
      })()}
      {loadError && <LoadError message={loadError} onRetry={() => void load()} retrying={loading} />}

      {alerts.length > 0 && (
        <section aria-labelledby="exceptions-title" className="mb-8 grid gap-3 rounded-md border border-warning/50 bg-warning-bg p-4">
          <h2 id="exceptions-title" className="flex items-center gap-2 text-d-section text-warning">
            <AlertTriangle aria-hidden className="size-4" />
            Payments that need you
          </h2>
          <ul className="grid gap-3 text-body">
            {alerts.map((a) => (
              <li key={a.eventId} className="grid gap-1">
                <p className="max-w-prose">{a.message}</p>
                <p className="flex flex-wrap items-center gap-3 text-meta text-muted-foreground">
                  {a.demo && <DemoChip />}
                  <time dateTime={new Date(a.createdAt).toISOString()}>{shortDate(a.createdAt)}</time>
                  {a.briefId && <Link className="text-label text-foreground underline underline-offset-4" href={`/deals/${a.briefId}`}>Open deal</Link>}
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}

      {items === null && !loadError && <LoadingRows label="Loading quotes that need your approval…" rows={2} height="h-48" />}
      {items?.length === 0 && <EmptyState>Nothing waiting. Quotes the agent cannot send on its own appear here.</EmptyState>}

      <div className="grid gap-10">
        {items?.map((item) => {
          const o = outcome[item.versionId];
          const closed = gone.has(item.versionId);
          const value = typed[item.versionId] ?? '';
          const matches = typedMatches(value, item.totalCents);
          const mine = busy?.id === item.versionId;
          return (
            <Card key={item.versionId} role="region" id={`quote-${item.versionId}`} tabIndex={-1} aria-labelledby={`q-${item.versionId}`} className="gap-5 p-5 shadow-none outline-none">
              <CardHeader className="flex flex-wrap items-start justify-between gap-4 px-0 py-0">
                <div className="grid gap-1">
                  <h2 id={`q-${item.versionId}`} className="text-d-section">
              {/* Batch 8: a renewal the agent opened before the licence ends. */}
              {item.renewal && <span className="mr-2 inline-flex items-center gap-1 rounded-md border border-warning/50 bg-warning-bg px-2 py-0.5 align-middle text-label font-medium text-warning">Renew? <TermTip term="renewal" /></span>}
                    <Link href={`/deals/${item.briefId}`} className="underline-offset-4 hover:underline">{item.client.name} · {item.asset.title}</Link>
                    <Badge variant="outline" className="ml-2 align-middle font-mono text-id font-normal">v{item.versionNo}</Badge>
                  </h2>
                  <p className="text-body text-muted-foreground">{item.scope}</p>
                  <p className="text-meta text-muted-foreground">Invoice goes to <span className="font-mono text-id">{item.client.email}</span></p>
                </div>
                <p className="text-lead">{usd(item.totalCents)}</p>
              </CardHeader>
              <CardContent className="grid gap-5 px-0">

              {/* B16: one line, not a box inside the card; the tip stays on the sentence's line. */}
              {!closed && <p role="note" className="flex items-center gap-2 text-body font-medium text-warning"><ShieldCheck aria-hidden className="size-4 shrink-0" /><span>Your approval is needed before this invoice is sent. <TermTip term="autopilot" /></span></p>}
              <div className="grid gap-2">
              <h3 className="text-label">Why the agent stopped</h3>
              <ul className="grid gap-3" aria-label="Why the agent stopped">
                {item.failing.slice(0, 3).map((f) => (
                  <li key={f.code} className="flex items-start gap-2 text-body">
                    <AlertTriangle aria-hidden className="mt-1 size-4 shrink-0 text-warning" />
                    <span className="grid gap-0.5">
                      {/* B16: the plain sentence leads; the rule code is a quiet reference after it. */}
                      <span>{f.message} <span className="font-mono text-id text-muted-foreground">{f.rule}<span className="sr-only"> stopped</span></span></span>
                      {ruleInPlainWords(f.code, item.client.name) && <span className="text-meta text-muted-foreground">{ruleInPlainWords(f.code, item.client.name)}</span>}
                    </span>
                  </li>
                ))}
                {item.sendError && <li className="text-body text-destructive">Last send failed: {item.sendError}</li>}
              </ul>
              {item.failing.length > 3 && <Collapsible>
                <CollapsibleTrigger className="min-h-11 text-label underline underline-offset-4">Show all {item.failing.length} reasons</CollapsibleTrigger>
                <CollapsibleContent><ul className="grid gap-2 pt-2">{item.failing.slice(3).map((f) => <li key={f.code} className="flex items-start gap-2 text-body"><AlertTriangle aria-hidden className="mt-1 size-4 shrink-0 text-warning" /><span className="grid gap-0.5"><span>{f.message} <span className="font-mono text-id text-muted-foreground">{f.rule}<span className="sr-only"> stopped</span></span></span>{ruleInPlainWords(f.code, item.client.name) && <span className="text-meta text-muted-foreground">{ruleInPlainWords(f.code, item.client.name)}</span>}</span></li>)}</ul></CollapsibleContent>
              </Collapsible>}
              </div>
              <p className="text-meta text-muted-foreground">
                <Link href={`/deals/${item.briefId}`} className="underline underline-offset-4">Open the deal</Link> to see the price breakdown and the client sentences behind it.
              </p>

              {o?.kind === 'done' || closed ? null : item.hardBlock ? (
                <p className="text-body">Approving cannot fix this. <Link href={`/deals/${item.briefId}`} className="underline underline-offset-4">Open the deal to change it.</Link></p>
              ) : (
                <form className="grid gap-3 border-t pt-5" onSubmit={(e) => { e.preventDefault(); if (matches) void act(item, 'approve'); else setBlurred({ ...blurred, [item.versionId]: true }); }}>
                  <p className="text-label">Approve this quote</p>
                  <p className="text-meta text-muted-foreground">Type the exact total to approve. Nothing else sends it.</p>
                  <TypedTotalField id={`t-${item.versionId}`} value={value} totalCents={item.totalCents} blurred={!!blurred[item.versionId]}
                    onBlur={() => setBlurred({ ...blurred, [item.versionId]: true })}
                    onChange={(v) => setTyped({ ...typed, [item.versionId]: v })}
                    actions={<>
                      <Button type="submit" className="h-11" disabled={mine || !value.trim() || !matches}>
                        {mine && busy?.action === 'approve' ? 'Approving and sending…' : `Approve and send ${usd(item.totalCents)} invoice`}
                      </Button>
                      <Button type="button" variant="outline" className="h-11" disabled={mine} onClick={() => void act(item, 'reject')}>
                        {mine && busy?.action === 'reject' ? 'Rejecting…' : 'Reject'}
                      </Button>
                    </>} />
                </form>
              )}
              <div aria-live="polite" className="min-h-0">
                {o && (
                  <p id={`o-${item.versionId}`} tabIndex={-1}
                    className={`text-body outline-none ${o.kind === 'error' ? 'rounded-md border border-destructive/40 bg-destructive-bg p-3 text-destructive' : 'font-medium'}`}>
                    {o.text}
                  </p>
                )}
              </div>
              {(o?.kind === 'done' || closed) && (
                <div className="flex flex-wrap items-center gap-4">
                  {o?.briefId && <Link href={`/deals/${o.briefId}`} className="text-label underline underline-offset-4">Open deal</Link>}
                  {o?.payerUrl && <a href={o.payerUrl} target="_blank" rel="noreferrer" className="text-label underline underline-offset-4">Payer link</a>}
                  <Button type="button" size="sm" variant="ghost" onClick={() => dismiss(item.versionId)}>Dismiss</Button>
                </div>
              )}
              </CardContent>
            </Card>
          );
        })}
      </div>
    </section>
  );
}
