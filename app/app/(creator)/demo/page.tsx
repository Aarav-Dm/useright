'use client';
// /demo (batch 8 §4): the demo control panel. Both actions are labelled Demo and exist only in demo mode
// (DEMO_MODE=1); in live mode the API answers 404 and the page says the panel is off. Read-only except these two
// creator-guarded POSTs, which move the demo clock forward and run the renewal tick.
import { CalendarClock, Play, Plus } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { HelpPanel } from '@/components/creator/guide';
import { DemoChip, LoadError, LoadingRows, PageHeader } from '@/components/creator/page-bits';
import { Button } from '@/components/ui/button';
import { shortDate } from '@/lib/format';

type Tick = { now: string; renewals: { created: number; sent: number; held: number; cancelled?: number }; expired: number; seededExpired?: number; deals?: string[] };
type Clock = { demoMode: true; now: string; offsetDays: number; tickPending?: boolean };

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
function tickSummary(t: Tick): string {
  const parts = [
    t.renewals.created ? `${plural(t.renewals.created, 'renewal opened', 'renewals opened')}` : null,
    t.renewals.sent ? `${plural(t.renewals.sent, 'renewal invoice sent', 'renewal invoices sent')}` : null,
    t.renewals.held ? `${plural(t.renewals.held, 'renewal waits', 'renewals wait')} in Ask me` : null,
    t.renewals.cancelled ? `${plural(t.renewals.cancelled, 'renewal cancelled', 'renewals cancelled')} (the licence had changed)` : null,
    t.expired ? `${plural(t.expired, 'licence expired', 'licences expired')}${t.seededExpired ? ` (${t.seededExpired} of them seeded Demo)` : ''}` : null,
  ].filter(Boolean);
  return parts.length ? `${parts.join(', ')}.` : 'Nothing was due.';
}

function movedText(b: { now?: string; moved?: boolean; days?: number }): string {
  if (!b.moved) return 'The clock did not move: no renewal window lies ahead of it. ';
  return `Clock moved forward ${plural(b.days ?? 0, 'day', 'days')} to ${shortDate(b.now ?? null)}. `;
}

export default function DemoPage() {
  const router = useRouter();
  const [clock, setClock] = useState<Clock | null>(null);
  const [off, setOff] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'clock' | 'tick' | 'fresh' | null>(null);
  const [dealLabel, setDealLabel] = useState('Open the renewal deal');
  const [result, setResult] = useState<string | null>(null);
  // Review fix 9 (review 9): the renewal deal this tick opened or sent, linked under the result.
  const [deal, setDeal] = useState<string | null>(null);
  // Review fix 6: shown only when the clock moved but the tick that follows it failed. It never moves the clock.
  const [tickAgain, setTickAgain] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/demo');
      if (res.status === 401) return router.replace('/login?next=/demo');
      if (res.status === 404) { setOff(true); return; }
      if (!res.ok) throw new Error(String(res.status));
      setClock(await res.json());
      setError(null);
    } catch {
      setError('Couldn’t load the demo clock. Try again.');
    }
  }, [router]);
  useEffect(() => { void load(); }, [load]);

  async function freshDeal() {
    setBusy('fresh');
    setResult(null);
    setDeal(null);
    setDealLabel('Open the renewal deal');
    try {
      const res = await fetch('/api/demo/fresh-deal', { method: 'POST' });
      const body = await res.json().catch(() => ({})) as { briefId?: string; sample?: string; reused?: boolean; error?: string };
      if (!res.ok || !body.briefId) { setResult(body.error ?? 'That did not work. Try again.'); return; }
      setResult(body.reused
        ? `Clock back at real time. ${body.sample} is still open, so no new request or invoice was added.`
        : `Clock back at real time. Added a new request: ${body.sample}.`);
      setDeal(body.briefId);
      setDealLabel(body.reused ? 'Open the deal' : 'Open the new deal');
    } catch {
      setResult('Could not reach the server, so the result is unknown.');
    } finally {
      setBusy(null);
      await load();
    }
  }

  async function run(kind: 'clock' | 'tick') {
    setBusy(kind);
    setResult(null);
    setDeal(null);
    setDealLabel('Open the renewal deal');
    try {
      const res = await fetch(kind === 'clock' ? '/api/demo/clock' : '/api/demo/tick', { method: 'POST' });
      const body = await res.json().catch(() => ({})) as { tick?: Tick | null; tickError?: string; now?: string; moved?: boolean; days?: number; error?: string };
      const moved = kind === 'clock' && res.ok ? movedText(body) : '';
      if (res.ok && body.tickError) {
        setTickAgain(true);
        setResult(`${moved}${body.tickError}`);
        await load();
        return;
      }
      if (!res.ok || !body.tick) { setResult(body.error ?? 'That did not work. Try again.'); return; }
      setTickAgain(false);
      setResult(`${moved}Tick: ${tickSummary(body.tick)}`);
      setDeal(body.tick.deals?.[0] ?? null);
      await load();
    } catch {
      setResult('Could not reach the server, so the result is unknown.');
      await load(); // the rows say whether a tick is still owed
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="max-w-[48rem]">
      <PageHeader title="Demo" description="Move time forward to show renewals and expiry. Only in demo mode." />
      <HelpPanel id="demo">
        <p><strong>Advance to the next renewal</strong> moves the demo clock forward (never back) to the day the soonest licence’s renewal is due, a week before it ends, and runs the tick straight away, so the ledger, the pay page and the receipts agree.</p>
        <p>The tick does what the daily tick does: a licence within 7 days of its end gets a renewal (sent if the client asked for one and every rule passes, otherwise it waits in Ask me), and a licence past its end expires.</p>
        <p>If a tick did not finish, <strong>Run tick again</strong> takes the place of Advance until one does. It runs only the tick and never moves the clock.</p>
        <p><strong>Start a fresh deal</strong> puts the clock back to real time and adds one new sample request, which the agent handles as usual, so it may send an invoice. If a sample deal is still unsettled it opens that one instead and sends nothing new. It deletes nothing: earlier deals and PayPal ids stay.</p>
        <p>Live mode ignores the demo clock, and this page is off there.</p>
      </HelpPanel>
      {off && <p className="text-body text-muted-foreground">The demo panel is off. It works only when the app runs with DEMO_MODE=1.</p>}
      {error && <LoadError message={error} onRetry={() => void load()} />}
      {!off && !error && clock === null && <LoadingRows label="Loading the demo clock…" rows={1} />}
      {clock && (
        <div className="grid gap-6">
          <dl className="grid gap-1 rounded-md border bg-card p-4 text-body">
            <dt className="text-meta text-muted-foreground">Demo clock</dt>
            <dd className="font-mono">{shortDate(clock.now)}</dd>
            <dd className="text-meta text-muted-foreground">{clock.offsetDays ? `${clock.offsetDays} days ahead of real time` : 'Same as real time'}</dd>
          </dl>
          <div className="flex flex-wrap items-center gap-3">
            {!(tickAgain || clock.tickPending) && (
              <Button onClick={() => void run('clock')} disabled={busy !== null} className="gap-2">
                <CalendarClock aria-hidden className="size-4" />
                {busy === 'clock' ? 'Moving the clock…' : 'Advance to the next renewal'}
              </Button>
            )}
            {(tickAgain || clock.tickPending) && (
              <Button variant="outline" onClick={() => void run('tick')} disabled={busy !== null} className="gap-2">
                <Play aria-hidden className="size-4" />
                {busy === 'tick' ? 'Running the tick…' : 'Run tick again'}
              </Button>
            )}
            <Button variant="outline" onClick={() => void freshDeal()} disabled={busy !== null} className="gap-2">
              <Plus aria-hidden className="size-4" />
              {busy === 'fresh' ? 'Adding a request…' : 'Start a fresh deal'}
            </Button>
            <DemoChip />
          </div>
          <p aria-live="polite" className="text-body">{result}</p>
          {deal && <Link href={`/deals/${deal}`} className="text-label underline underline-offset-4">{dealLabel}</Link>}
        </div>
      )}
    </section>
  );
}
