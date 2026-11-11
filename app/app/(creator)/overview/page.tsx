'use client';
// /overview (batch 7C phase 2): everything at a glance, read only, over GET /api/overview. Every amount is a server
// total; seeded demo money is always shown apart from PayPal-verified money.
import { ArrowRight, ChevronRight } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { askNextSteps, dealsNextSteps, HelpPanel, NextStepBanner } from '@/components/creator/guide';
import { ruleTitle } from '@/components/creator/deal-extras';
import { TermTip } from '@/components/creator/explain';
import { DemoChip, EmptyState, LoadError, LoadingRows, PageHeader, StatusBadge } from '@/components/creator/page-bits';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { shortDate, shortDateTime, usd } from '@/lib/format';
import type { Money, Overview } from '@/lib/overview';

function Total({ label, money, note, extra }: { label: string; money: Money; note: string; extra?: ReactNode }) {
  return (
    <><dt className="sr-only">{label}</dt><dd className="m-0 grid content-start gap-1 p-5">
      <span aria-hidden="true" className="text-label text-muted-foreground">{label}</span>
      <div className="grid gap-1">
        <span className="text-lead">{usd(money.liveCents)}</span>
        <span className="text-meta text-muted-foreground">{money.liveCount} {note}</span>
        <span className="text-meta text-muted-foreground">{label === 'Earned' ? 'PayPal confirmed for licences.' : label === 'Waiting for payment' ? 'Invoices clients have not paid yet.' : 'Paid back in PayPal; those licences are revoked.'}</span>
        {extra}
      </div>
    </dd></>
  );
}

/** B16: one waiting item as a row that opens the work. */
function WaitRow({ href, text, tip }: { href: string; text: string; tip?: ReactNode }) {
  return (
    <li className="row-link flex items-center gap-2 px-5 py-3">
      <Link href={href} className="font-medium underline-offset-4 hover:underline">{text}</Link>{tip}
      <ChevronRight aria-hidden className="ml-auto size-4 shrink-0 text-muted-foreground" />
    </li>
  );
}

/** Batch 12: seeded money stays out of every total and labelled. B16: shown as its own dashed strip with readable
 *  figures, so the walkthrough's money is visible without ever joining the PayPal-verified totals above it. */
function SeededLine({ totals }: { totals: Overview['totals'] }) {
  const parts = ([['Earned', 'earned', totals.earned], ['Waiting for payment', 'waiting', totals.pending], ['Refunded', 'refunded', totals.refunded]] as const)
    .filter(([, , m]) => m.demoCount > 0);
  if (!parts.length) return null;
  return (
    <section aria-label="Seeded demo money" className="grid gap-3 rounded-xl border border-dashed p-5">
      <p className="flex flex-wrap items-center gap-2 text-label text-muted-foreground"><DemoChip /> Seeded for the demo, not PayPal money and not in these totals</p>
      <dl className="grid gap-4 sm:grid-cols-3">
        {parts.map(([label, w, m]) => (
          <div key={w} className="grid gap-0.5">
            <dt className="text-label text-muted-foreground">{label}</dt>
            <dd className="text-money tabular">{usd(m.demoCents)} <span className="text-label font-normal text-muted-foreground">{w} ({m.demoCount})</span></dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/** B16: activity grouped by deal (Vercel deployment list): the deal once, its checks and events under it. */
function groupByDeal(rows: Overview['recent']) {
  const groups: { key: string; deal: string | null; demo: boolean; at: string | Date; rows: Overview['recent'] }[] = [];
  for (const r of rows) {
    const last = groups[groups.length - 1];
    if (last && last.deal === (r.deal ?? null)) { last.rows.push(r); last.demo ||= !!r.demo; }
    else groups.push({ key: String(r.eventId), deal: r.deal ?? null, demo: !!r.demo, at: r.createdAt, rows: [r] });
  }
  return groups;
}

/** review B7C-2 finding 1: money kept on a licence revoked only because an earlier one it built on was refunded. */
function KeptNote({ kept }: { kept: Money }) {
  if (kept.liveCount + kept.demoCount === 0) return null;
  const parts = [kept.liveCount ? `${usd(kept.liveCents)} (${kept.liveCount})` : null, kept.demoCount ? `${usd(kept.demoCents)} seeded (${kept.demoCount})` : null].filter(Boolean);
  return <p className="mt-1 text-meta text-muted-foreground">Includes {parts.join(' and ')} on licences revoked because an earlier licence they built on was refunded. That money was not paid back.</p>;
}

/** review B7C-2 finding 5: a partial refund keeps the licence, and its refunded part is not stored, so it is only noted. */
function PartialNote({ n }: { n: number }) {
  if (n === 0) return null;
  return <p className="mt-1 text-meta text-muted-foreground">Includes {n} {n === 1 ? 'payment' : 'payments'} partly refunded in PayPal; the refunded part is not taken off here.</p>;
}

export default function OverviewPage() {
  const router = useRouter();
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/overview');
      if (res.status === 401) return router.replace('/login?next=/overview');
      if (!res.ok) throw new Error(String(res.status));
      setData(await res.json());
      setError(null);
    } catch {
      setError('Couldn’t load the overview. Try again.');
    } finally {
      setLoading(false);
    }
  }, [router]);
  useEffect(() => { void load(); }, [load]);

  const waitingTotal = data ? data.waiting.approvals + data.waiting.blocked + data.waiting.checks + data.waiting.failed : 0;

  return (
    <section>
      <PageHeader title="Overview" />
      <HelpPanel id="overview">
        <p><strong>Earned</strong> is money PayPal confirmed for licences. <strong>Waiting for payment</strong> is invoices clients have not paid yet. <strong>Refunded</strong> is money paid back in PayPal; those licences are revoked. A licence revoked only because an earlier licence it built on was refunded keeps its money, so it stays in Earned with a note.</p>
        <p>Seeded demo rows are counted on their own line, so they are never mixed with real PayPal money. Every number comes from the ledger and your deals.</p>
      </HelpPanel>
      {error && <LoadError message={error} onRetry={() => void load()} retrying={loading} />}
      {data === null && !error && <LoadingRows label="Loading your overview…" rows={3} height="h-24" />}

      {data && (
        <NextStepBanner
          calm="Nothing needs you right now."
          steps={[
            // Ask's in-page anchors point at the Ask page from here. review B7C-2 finding 8: alerts have no resolved state,
            // so they get their own line below instead of a "needs you" step.
            ...askNextSteps(data.ask, []).map((s) => (s.href.startsWith('#') ? { ...s, href: `/ask${s.href}` } : s)),
            ...dealsNextSteps(data.unpaid),
          ]}
        />
      )}
      {data && (
        <div className="grid gap-10">
          <section aria-labelledby="money-title" className="grid gap-3">
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1"><h2 id="money-title" className="text-d-section">Money</h2><p className="text-label text-muted-foreground">PayPal-verified totals, apart from anything marked Demo.</p></div>
            {/* B16: one divided strip instead of three bordered tiles (design-taste-frontend app rules §5: KPIs are type, not tiles). */}
            <Card className="grid gap-0 divide-y py-0 shadow-none md:grid-cols-3 md:divide-x md:divide-y-0" aria-label="Summary">
              <div className="grid content-start gap-1 p-5"><h3 className="text-label text-muted-foreground">Caught beyond the licence</h3><p className={`text-lead ${data.headline.caught === 0 ? 'text-muted-foreground' : ''}`}>{data.headline.caught}{data.headline.caughtDemo > 0 && <span className="ml-2 text-label font-medium tracking-normal text-foreground">+{data.headline.caughtDemo} seeded</span>}</p><p className="text-meta text-muted-foreground">Requests the agent found outside the current licence.</p></div>
              <div className="grid content-start gap-1 p-5"><h3 className="text-label text-muted-foreground">Gap invoiced</h3><p className={`text-lead ${data.headline.invoicedCents === 0 ? 'text-muted-foreground' : ''}`}>{usd(data.headline.invoicedCents)}</p><p className="text-meta text-muted-foreground">Amount invoiced for that extra use.</p></div>
              <div className="grid content-start gap-1 p-5"><h3 className="text-label text-muted-foreground">Recovered</h3><p className={`text-lead ${data.headline.recoveredCents === 0 ? 'text-muted-foreground' : ''}`}>{usd(data.headline.recoveredCents)}</p><p className="text-meta text-muted-foreground">Amount PayPal confirmed.</p></div>
            </Card>
            {data.totals.earned.liveCount + data.totals.pending.liveCount + data.totals.refunded.liveCount === 0
              // B12 E6: no row of three $0.00 cards on first open.
              ? <p className="text-body text-muted-foreground">No PayPal money yet. Invoices the agent sends, and payments PayPal confirms, appear here.</p>
              : <dl className="grid divide-y rounded-xl border bg-card md:grid-cols-3 md:divide-x md:divide-y-0" aria-label="Totals">
              <Total label="Earned" money={data.totals.earned} note={data.totals.earned.liveCount === 1 ? 'PayPal-verified payment' : 'PayPal-verified payments'} extra={<><KeptNote kept={data.totals.revokedKept} /><PartialNote n={data.partlyRefunded} /></>} />
              <Total label="Waiting for payment" money={data.totals.pending} note="invoices out" />
              <Total label="Refunded" money={data.totals.refunded} note="refunds" />
            </dl>}
            <SeededLine totals={data.totals} />
          </section>

          <div className="grid gap-10 lg:grid-cols-2 lg:gap-6">
          <section aria-labelledby="waiting-title" className="grid content-start gap-3">
            <h2 id="waiting-title" className="flex items-center gap-2 text-d-section">Waiting for you <Badge variant={waitingTotal > 0 ? 'warning' : 'outline'}>{waitingTotal}</Badge></h2>
            {/* B16: plain rows that open the work, not an amber box around a list (impeccable: cards are the lazy answer). */}
            <Card className="gap-0 py-0 shadow-none">
            {waitingTotal === 0 ? <p className="p-5 text-body text-muted-foreground">Nothing needs you right now.</p> : (
              <ul className="grid divide-y text-body">
                {data.waiting.approvals > 0 && <WaitRow href="/ask" text={`${data.waiting.approvals} ${data.waiting.approvals === 1 ? 'quote waits' : 'quotes wait'} for your typed approval`} tip={<TermTip term="typedTotal" />} />}
                {data.waiting.blocked > 0 && <WaitRow href={data.waiting.blockedBriefId ? `/deals/${data.waiting.blockedBriefId}` : '/ask'} text={`${data.waiting.blocked} ${data.waiting.blocked === 1 ? 'quote needs' : 'quotes need'} a change in the deal before it can be approved`} />}
                {data.waiting.checks > 0 && <WaitRow href="/deals" text={`${data.waiting.checks} ${data.waiting.checks === 1 ? 'request needs you to check it' : 'requests need you to check them'}`} />}
                {data.waiting.failed > 0 && <WaitRow href="/deals" text={`${data.waiting.failed} ${data.waiting.failed === 1 ? 'invoice' : 'invoices'} could not be confirmed as sent`} />}
              </ul>
            )}
            {data.alertsShown > 0 && (
              <p className="border-t px-5 py-3 text-label text-muted-foreground">
                Payment alerts (last 20): {data.alertsShown}.{' '}
                <Link href="/ask#exceptions-title" className="text-foreground underline underline-offset-4">Read them in Ask me</Link>
              </p>
            )}
            </Card>
          </section>

          <section aria-labelledby="unpaid-title" className="grid content-start gap-3">
            <div className="grid gap-0.5"><h2 id="unpaid-title" className="flex items-center gap-2 text-d-section">Unpaid invoices <Badge variant="outline">{data.unpaid.length}</Badge></h2>
            <p className="text-label text-muted-foreground">Invoices the agent sent that PayPal has not confirmed as paid.</p></div>
            <Card className="gap-0 py-0 shadow-none">
            {data.unpaid.length === 0 ? <p className="p-5 text-body text-muted-foreground">No invoices are waiting for payment.</p> : (
              <ul className="grid divide-y">
                {data.unpaid.map((d) => (
                  <li key={d.briefId} className="row-link flex flex-wrap items-center justify-between gap-3 px-5 py-3 text-body">
                    <span className="grid min-w-0">
                      <Link href={`/deals/${d.briefId}`} className="font-medium underline-offset-4 hover:underline">{d.client?.name ?? 'Unknown sender'} · {d.asset?.title ?? 'no photo'}</Link>
                      <span className="text-meta text-muted-foreground">Received {shortDate(d.createdAt)}</span>
                    </span>
                    <span className="flex items-center gap-3">
                      <StatusBadge status={d.status} demo={d.demo} />
                      <span className="font-medium tabular">{d.gapTotalCents !== null ? usd(d.gapTotalCents) : '—'}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
            </Card>
          </section>
          </div>

          <section aria-labelledby="recent-title" className="grid gap-3">
            <div className="flex items-center justify-between gap-2">
              <h2 id="recent-title" className="flex items-center gap-2 text-d-section">Recent activity <TermTip term="ledger" /></h2>
              <Button asChild variant="ghost" size="sm"><Link href="/ledger">Open the full ledger <ArrowRight aria-hidden className="size-4" /></Link></Button>
            </div>
            <Card className="gap-0 py-0 shadow-none">
            {data.recent.length === 0 ? <div className="p-5"><EmptyState>No agent activity yet. Add a client request to see it here.</EmptyState></div> : (
              <ol className="grid divide-y text-body">
                {groupByDeal(data.recent).map((g) => (
                  <li key={g.key} className="grid gap-2 px-5 py-4">
                    <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                      <span className="font-medium">{g.deal ?? 'No deal'}</span>
                      <time className="text-meta text-muted-foreground tabular" dateTime={new Date(g.at).toISOString()}>{shortDateTime(g.at)}</time>
                      {g.demo && <span className="ml-auto"><DemoChip /></span>}
                    </p>
                    <ul className="grid gap-1.5">
                      {g.rows.map((r) => (
                        <li key={r.eventId} className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-label">
                          {r.rule ? <><Badge variant={r.result === 'pass' ? 'outline' : 'warning'}>{r.result === 'pass' ? 'Passed' : 'Held'}</Badge><span className={r.result === 'pass' ? 'text-muted-foreground' : ''}>{r.message || ruleTitle(r)}</span></> : <span className="font-medium">{r.label}</span>}
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ol>
            )}
            </Card>
          </section>
        </div>
      )}
    </section>
  );
}
