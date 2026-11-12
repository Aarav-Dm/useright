'use client';
// /deals (batch-4 §2, docs/ui/deals.md): fetches GET /api/deals and hands the rows to DealsTable.
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { DealsTable } from '@/components/creator/deals-table';
import { STATUS_MEANING } from '@/components/creator/explain';
import { DEALS_LOADED_MAX, dealsNextSteps, HelpPanel, NextStepBanner } from '@/components/creator/guide';
import { OPEN_REQUEST_EVENT } from '@/components/creator/request-sheet';
import { EmptyState, LoadError, LoadingRows, PageHeader } from '@/components/creator/page-bits';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import type { DealRow } from '@/lib/deals';

type Filter = 'all' | 'needs' | 'moving' | 'done';
const DONE = new Set(['paid', 'refunded', 'rejected', 'cancelled']);
const FILTERS: { key: Filter; label: string; test: (status: string) => boolean }[] = [
  { key: 'all', label: 'All', test: () => true },
  { key: 'needs', label: 'Needs you', test: (s) => !!STATUS_MEANING[s]?.needsYou },
  { key: 'moving', label: 'In progress', test: (s) => !STATUS_MEANING[s]?.needsYou && !DONE.has(s) },
  { key: 'done', label: 'Done', test: (s) => DONE.has(s) },
];

export default function DealsPage() {
  const [filter, setFilter] = useState<Filter>('all');
  const router = useRouter();
  const [deals, setDeals] = useState<DealRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/deals');
      if (res.status === 401) return router.replace('/login?next=/deals');
      if (!res.ok) throw new Error(String(res.status));
      setDeals((await res.json()).deals);
      setError(null);
    } catch {
      // Rows already on screen stay; only the message is added.
      setError('Couldn’t load deals. Try again.');
    } finally {
      setLoading(false);
    }
  }, [router]);
  useEffect(() => { void load(); }, [load]);

  // B18: opens the dashboard's request sheet (the toolbar's RequestSheet listens), never the /dev/intake test page.
  const add = (
    <Button type="button" className="h-11 md:h-10" onClick={() => window.dispatchEvent(new Event(OPEN_REQUEST_EVENT))}>
      Add a request
    </Button>
  );

  return (
    <section>
      <PageHeader title="Deals" description="Client requests, newest first. Open one to see the price and the rules behind it." actions={add} />
      <HelpPanel id="deals">
        <p>Every request a client sends, newest first. UseRight reads the message, finds what the client wants to use the photo for, and prices only what is new from your rate card.</p>
        <p><strong>Ready</strong> or <strong>Invoice sent</strong> means the agent is handling it within your limits. <strong>Needs you</strong> and <strong>Needs your approval</strong> mean it stopped and waits for you.</p>
        <p>Open a row to see the client’s words, the price lines and the rules behind each decision.</p>
      </HelpPanel>
      {deals && (
        <NextStepBanner
          steps={dealsNextSteps(deals)}
          // review B7C-1 finding 7: at the load limit the queue may hide older deals, so the all-clear is qualified.
          calm={deals.length >= DEALS_LOADED_MAX ? `Nothing needs you in your newest ${DEALS_LOADED_MAX} deals.` : 'Nothing needs you right now.'}
          note={deals.length >= DEALS_LOADED_MAX ? `These counts cover your newest ${DEALS_LOADED_MAX} deals only; older deals are not loaded here.` : undefined}
        />
      )}
      {error && <LoadError message={error} onRetry={() => void load()} retrying={loading} />}
      {deals === null && !error && <LoadingRows label="Loading usage requests…" />}
      {deals?.length === 0 && (
        <EmptyState>No requests yet. Paste a client message or screenshot to check its usage.</EmptyState>
      )}
      {deals && deals.length > 0 && (
        <div className="mb-4 grid gap-3">
          <div role="group" aria-label="Show all deals"><Button size="sm" variant={filter === 'all' ? 'secondary' : 'ghost'} aria-pressed={filter === 'all'} className="h-9 gap-2" onClick={() => setFilter('all')}>All <span className="font-mono text-meta text-muted-foreground">{deals.length}</span></Button></div>
          <div role="group" aria-label="Filter deals" className="grid gap-3 sm:grid-cols-3">
            {FILTERS.filter((f) => f.key !== 'all').map((f) => {
              const n = deals.filter((d) => f.test(d.status)).length;
              const meaning = f.key === 'needs' ? 'Stopped and waiting for your decision.' : f.key === 'moving' ? 'The agent is handling it within your limits.' : 'Paid, refunded, rejected or cancelled.';
              return <Card key={f.key} className={`gap-2 py-0 shadow-none ${filter === f.key ? 'border-ring' : ''}`}><CardHeader className="px-4 pt-4 pb-0"><h3 className="text-label text-muted-foreground">{f.label}</h3></CardHeader><CardContent className="px-4 pb-4"><button type="button" aria-label={`${f.label} ${n}`} aria-pressed={filter === f.key} className="grid min-h-16 w-full gap-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2" onClick={() => setFilter(f.key)}><span className="font-mono text-money">{n}</span><span className="text-meta text-muted-foreground">{meaning}</span></button></CardContent></Card>;
            })}
          </div>
        </div>
      )}
      {deals && deals.length > 0 && (() => {
        const shown = deals.filter((d) => FILTERS.find((f) => f.key === filter)!.test(d.status));
        // B9 9.4: the longest wait comes first.
        if (filter === 'needs') shown.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
        return shown.length === 0
          ? <EmptyState action={<Button variant="outline" onClick={() => setFilter('all')}>Show all deals</Button>}>No deals in this view.</EmptyState>
          : <DealsTable deals={shown} waiting={filter === 'needs'} onOpen={(id) => router.push(`/deals/${id}`)} />;
      })()}
    </section>
  );
}
