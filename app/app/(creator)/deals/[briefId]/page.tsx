'use client';
// /deals/:briefId (batch-4 §3). Fetches GET /api/briefs/:id and wires DealRoomView's actions to the routes.
import { useRouter } from 'next/navigation';
import { use, useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { DealRoomView } from '@/components/creator/deal-room';
import { LoadingRows } from '@/components/creator/page-bits';
import type { Options } from '@/components/creator/deal-setup';
import type { BriefView } from '@/lib/briefs';
import type { LedgerRow } from '@/lib/ledger';

const send = (url: string, method: string, body: unknown) =>
  fetch(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

/** Batch-6 review F14: Re-check PayPal shows what PayPal actually said, not a fixed "Checked". */
function recheckOutcome(body: Record<string, unknown>): { notice?: string; error?: string } {
  const r = body.recheck as { checked?: boolean; reason?: string; outcome?: string; message?: string } | undefined;
  if (!r) return { notice: 'Checked with PayPal.' };
  if (!r.checked) return { notice: r.reason === 'throttled' ? 'PayPal was checked a moment ago. Try again in a few seconds.' : 'There is nothing to check with PayPal for this deal yet.' };
  if (r.outcome === 'unavailable') return { error: r.message ?? 'PayPal could not be reached, so nothing was changed.' };
  // review #15: the server's reason already says what happened (not paid yet, stale quote, file not ready...).
  if (r.outcome === 'refused') return { error: r.message ?? 'PayPal did not confirm the payment.' };
  return { notice: r.message ?? 'Checked with PayPal.' };
}

/** review 18: the notice says what the returned deal shows, not what was asked for. */
function afterStatus(expected: string, text: string) {
  return (body: Record<string, unknown>): { notice?: string } => {
    const v = (body.brief ? body : body.view) as { status?: string } | undefined;
    if (!v?.status || v.status === expected) return { notice: text };
    return { notice: 'Done. The deal below shows what the server holds now.' };
  };
}

export default function DealRoomPage({ params }: { params: Promise<{ briefId: string }> }) {
  const { briefId } = use(params);
  const router = useRouter();
  const [view, setView] = useState<BriefView | null>(null);
  const [options, setOptions] = useState<Options | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [verifyLink, setVerifyLink] = useState<{ url: string; email: string } | null>(null);
  const [notFound, setNotFound] = useState(false);
  // Batch 7C: this deal's rows from the read-only ledger, for the agent timeline. Re-read when the status changes.
  const [timeline, setTimeline] = useState<LedgerRow[] | null>(null);
  useEffect(() => {
    let live = true;
    fetch('/api/ledger').then(async (r) => {
      if (!r.ok) return;
      const body = await r.json() as { rows?: LedgerRow[] };
      if (live && Array.isArray(body.rows)) setTimeline(body.rows.filter((row) => row.briefId === briefId));
    }).catch(() => {});
    return () => { live = false; };
  // review B7C-2 finding 9: re-read only when the deal's status changes, not on every 2-second send poll.
  }, [briefId, view?.status]);

  // A poll that started before an action finished must not overwrite the action's newer result.
  const generation = useRef(0);
  const load = useCallback(async () => {
    const gen = generation.current;
    try {
      const res = await fetch(`/api/briefs/${briefId}`);
      if (res.status === 401) return router.replace(`/login?next=/deals/${briefId}`);
      const body = await res.json();
      if (gen !== generation.current) return;
      if (res.ok) setView(body);
      else if (res.status === 404) setNotFound(true);
      else setError(body.error ?? 'Couldn’t refresh the deal. Check your connection and try again.');
    } catch {
      setError('Couldn’t refresh the deal. Check your connection and try again.');
    }
  }, [briefId, router]);

  useEffect(() => {
    void load();
    void fetch('/api/options').then(async (r) => r.ok && setOptions(await r.json())).catch(() => {});
  }, [load]);

  // B5 review 2: while a send is in flight (here or in another tab) re-read the deal every 2 s, for at most
  // 2 minutes, and stop as soon as it reaches a terminal state.
  const sending = busy || view?.status === 'sending';
  useEffect(() => {
    if (!sending) return;
    let polls = 0;
    const t = setInterval(() => {
      if (++polls > 60) return clearInterval(t);
      void load();
    }, 2000);
    return () => clearInterval(t);
  }, [sending, load]);

  type Outcome = { notice?: string; error?: string };
  async function act(fn: () => Promise<Response>, ok?: string | ((body: Record<string, unknown>) => Outcome)) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fn();
      const body = await res.json().catch(() => ({}));
      generation.current++;
      if (!res.ok) {
        setError(body.error ?? 'Something went wrong.');
        await load(); // show what the server holds now before another try
        return;
      }
      const out: Outcome = typeof ok === 'function' ? ok(body) : { notice: ok };
      if (out.notice) setNotice(out.notice);
      if (out.error) setError(out.error);
      if (body.brief) setView(body);
      else if (body.view?.brief) setView(body.view);
      else await load();
    } catch {
      // B5 review 3: a network failure never leaves the buttons disabled.
      generation.current++;
      setError('Could not reach the server, so the result is unknown. Check the deal below before trying again.');
      await load();
    } finally {
      setBusy(false);
    }
  }

  if (notFound && !view) {
    return (
      <section className="grid justify-items-start gap-3">
        <h1 className="text-d-page">This deal wasn’t found.</h1>
        <Link href="/deals" className="text-label underline underline-offset-4">All deals</Link>
      </section>
    );
  }
  if (!view) {
    return error
      ? <p role="alert" className="rounded-md border border-destructive/40 bg-destructive-bg p-3 text-body text-destructive">{error}</p>
      : <LoadingRows label="Loading this usage request…" rows={3} height="h-40" />;
  }

  return (
    <div className="grid gap-4">
      <div className="grid gap-2">
        {error && <p role="alert" className="rounded-md border border-destructive/40 bg-destructive-bg p-3 text-body text-destructive">{error}</p>}
        {notice && <p role="status" className="rounded-md border bg-card p-3 text-body">{notice}</p>}
      </div>
      <DealRoomView
        key={view.version?.id ?? 'no-version'}
        view={view}
        options={options}
        busy={busy}
        verifyLink={verifyLink}
        timeline={timeline}
        publicPath={(options as { creatorSlug?: string } | null)?.creatorSlug ? `/c/${(options as { creatorSlug?: string }).creatorSlug}` : null}
        actions={{
          onIssueVerifyLink: async () => {
            setBusy(true);
            setError(null);
            try {
              const res = await send(`/api/briefs/${briefId}/verify-link`, 'POST', {});
              const body = await res.json().catch(() => ({}));
              if (res.ok) setVerifyLink({ url: body.url, email: body.email });
              else setError(body.error ?? 'Could not create the link.');
            } catch {
              // review re-check 4: a network failure never leaves the controls disabled.
              setError('Could not reach the server. Check your connection, then get the link again.');
            } finally {
              setBusy(false);
            }
          },
          onEdit: (e) => act(() => send(`/api/briefs/${briefId}`, 'PATCH', e)),
          onConfirm: (lines) => act(() => send(`/api/briefs/${briefId}/transcript`, 'POST', { lines })),
          onDecide: (action, typedTotal) =>
            act(
              () => send(`/api/briefs/${briefId}/decide`, 'POST', typedTotal === undefined ? { action } : { action, typedTotal }),
              action === 'recheck' ? recheckOutcome
                : action === 'approve' ? afterStatus('invoiced', 'Approved by you, invoice sent.')
                : action === 'reject' ? afterStatus('rejected', 'Rejected.')
                  : action === 'cancel_requote' ? afterStatus('cancelled', 'Invoice cancelled. Edit the deal to re-quote.')
                    : ({ retry: 'Checked with PayPal.', rotate_link: 'New client link made. The old link and its downloads no longer work; send the client the new one.' } as Record<string, string>)[action],
            ),
          onCopy: async (text) => {
            // F17: say "Copied" only once the clipboard accepted it; a blocked clipboard is shown.
            try {
              await navigator.clipboard.writeText(text);
              setError(null);
              setNotice('Copied.');
            } catch {
              setNotice(null);
              setError('Could not copy: the browser blocked the clipboard. Select the link and copy it by hand.');
            }
          },
          onError: setError,
        }}
      />
    </div>
  );
}
