'use client';
// Batch 7C phase 3: the activity bell. Lists recent payments (file unlocked), refunds and rule stops from the existing
// read-only GET /api/ledger. "New" only remembers, in this browser, the newest event you have already seen; it changes
// nothing on the server. Seeded demo rows keep their Demo chip, never say PayPal confirmed them, and never count as new.
import { Bell, CalendarX2, CircleCheck, Hourglass, OctagonAlert, RefreshCw, Undo2 } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { HARD_RULES, isCascadedRevoke, ruleHeld } from '@/components/creator/deal-extras';
import { DemoChip } from '@/components/creator/page-bits';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { shortDateTime, usd } from '@/lib/format';
import type { LedgerRow } from '@/lib/ledger';

export const SEEN_KEY = 'useright.activity.seenAt';
const LIMIT = 10;
/** review B7C-3 finding 12: refresh on open and on this slow interval, not on every page change. */
export const BELL_REFRESH_MS = 60_000;

/** The events the bell shows: paid and unlocked, refunded or revoked, held by a rule. */
export const isBellEvent = (r: Pick<LedgerRow, 'kind' | 'result'>) =>
  (r.kind === 'grant' && r.result === 'pass') || r.kind === 'revoked' || (r.kind === 'rule' && r.result === 'fail')
  // Batch 8: renewals the agent sent, held or cancelled, and licences that ended.
  || r.kind === 'renewal.sent' || r.kind === 'renewal.draft' || r.kind === 'renewal.cancelled' || r.kind === 'expired';

/**
 * review B7C-3 finding 2: plain words, not "Stopped by R2". review final N1: past tense ("Held for your OK"), because the bell
 * is history: the same quote may since have been approved, sent and paid.
 */
export function bellText(r: Pick<LedgerRow, 'kind' | 'demo' | 'message' | 'rule'>): string {
  if (r.kind === 'grant') return r.demo ? 'Seeded as paid' : 'Paid with PayPal, file unlocked';
  if (r.kind === 'renewal.sent') return 'Renewal invoice sent';
  if (r.kind === 'renewal.draft') return 'Renewal held for your OK';
  if (r.kind === 'renewal.cancelled') return 'Renewal cancelled, the licence had changed';
  if (r.kind === 'expired') return r.demo ? 'Seeded licence ended' : 'Licence ended, downloads stopped';
  if (r.kind === 'revoked') {
    if (r.demo) return 'Seeded as refunded';
    return isCascadedRevoke(r) ? 'Licence revoked: an earlier licence it built on was refunded' : 'Refunded in PayPal, licence revoked';
  }
  const held = ruleHeld(r.rule);
  return held.charAt(0).toUpperCase() + held.slice(1);
}

/** One bell line. A quote's failing rules from one run are one item (review B7C-3 finding 7, review finding 4). */
export type BellItem = { key: string; row: LedgerRow; rules: string[]; messages: string[] };

/**
 * Newest first, rule stops collapsed: for each version only its newest failing run is kept, as one item with every
 * failing rule. Hard blocks lead, because they cannot be approved.
 */
export function bellItems(rows: LedgerRow[], limit = LIMIT): BellItem[] {
  const items: BellItem[] = [];
  const runs = new Map<string, { at: number; item: BellItem }>();
  for (const r of rows) {
    if (!isBellEvent(r)) continue;
    if (r.kind !== 'rule' || !r.versionId) {
      items.push({ key: r.eventId, row: r, rules: r.rule ? [r.rule] : [], messages: r.message ? [r.message] : [] });
      continue;
    }
    const at = new Date(r.createdAt).getTime();
    const run = runs.get(r.versionId);
    if (!run) {
      const item: BellItem = { key: r.eventId, row: r, rules: r.rule ? [r.rule] : [], messages: r.message ? [r.message] : [] };
      runs.set(r.versionId, { at, item });
      items.push(item);
    } else if (run.at === at) {
      if (r.rule) run.item.rules.push(r.rule);
      if (r.message) run.item.messages.push(r.message);
      if (r.rule && HARD_RULES.has(r.rule)) run.item.row = r;
    } // an older run of the same quote is left out
  }
  return items.slice(0, limit);
}

const time = (d: Date | string) => new Date(d).getTime();

function readSeen(): number | null {
  try {
    const v = window.localStorage.getItem(SEEN_KEY);
    return v ? time(v) : null;
  } catch {
    return null;
  }
}
function writeSeen(at: string) {
  try { window.localStorage.setItem(SEEN_KEY, at); } catch { /* private mode: the count just clears in memory */ }
}

export function ActivityBell() {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<BellItem[] | 'error' | null>(null);
  const [seen, setSeen] = useState<number | null>(null);
  // What counted as seen when the list was opened, so the "New" marks stay while it is open.
  const [seenAtOpen, setSeenAtOpen] = useState<number | null>(null);
  const request = useRef(0);
  const firstLoad = useRef(true);

  const load = useCallback(async () => {
    const mine = ++request.current; // review B7C-3 finding 8: a slower, older response never replaces a newer one
    try {
      const res = await fetch('/api/ledger');
      if (!res.ok) throw new Error(String(res.status));
      const body = await res.json() as { rows?: LedgerRow[] };
      if (mine !== request.current) return;
      if (!Array.isArray(body.rows)) { setItems((r) => (Array.isArray(r) ? r : 'error')); return; }
      const next = bellItems(body.rows);
      // review B7C-3 finding 1: with no saved mark, what is there now counts as seen, so a first visit shows no count.
      if (firstLoad.current) {
        firstLoad.current = false;
        if (readSeen() === null && next[0]) {
          const at = new Date(next[0].row.createdAt).toISOString();
          writeSeen(at);
          setSeen(time(at));
        }
      }
      setItems(next);
    } catch {
      if (mine === request.current) setItems((r) => (Array.isArray(r) ? r : 'error'));
    }
  }, []);
  useEffect(() => { setSeen(readSeen()); }, []);
  useEffect(() => {
    void load();
    const id = setInterval(() => { void load(); }, BELL_REFRESH_MS);
    return () => clearInterval(id);
  }, [load]);

  const list = Array.isArray(items) ? items : [];
  // Seeded demo rows are listed but never count as new.
  const isNew = (i: BellItem, after: number | null) => !i.row.demo && (after === null || time(i.row.createdAt) > after);
  const fresh = list.filter((i) => isNew(i, seen)).length;

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) return;
    setSeenAtOpen(seen);
    void load();
  };

  // While the list is open, what it shows counts as seen (remembered in this browser only).
  const newestAt = list[0] ? new Date(list[0].row.createdAt).toISOString() : null;
  useEffect(() => {
    if (!open || !newestAt) return;
    writeSeen(newestAt);
    setSeen(time(newestAt));
  }, [open, newestAt]);

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button variant="outline" className="relative size-11 p-0 md:size-10" aria-label={fresh ? `Activity, ${fresh} new` : 'Activity'}>
          <Bell aria-hidden className="size-4" />
          {fresh > 0 && (
            <span aria-hidden className="absolute -top-1.5 -right-1.5 grid h-5 min-w-5 place-items-center rounded-full bg-primary px-1 font-mono text-meta text-primary-foreground">
              {fresh > 9 ? '9+' : fresh}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="theme-dashboard grid w-[min(24rem,calc(100vw-2rem))] gap-0 p-0 text-body text-foreground">
        <div className="border-b px-4 py-3">
          <p className="text-label">Recent activity</p>
          <p className="text-meta text-muted-foreground">Payments, refunds and quotes held by your rules, newest first.</p>
        </div>
        {items === null && <p className="px-4 py-3 text-muted-foreground">Loading activity…</p>}
        {items === 'error' && (
          <div className="flex flex-wrap items-center gap-2 px-4 py-3">
            <p className="text-muted-foreground">Couldn’t load activity.</p>
            <Button size="sm" variant="ghost" onClick={() => void load()}>Try again</Button>
          </div>
        )}
        {Array.isArray(items) && items.length === 0 && <p className="px-4 py-3 text-muted-foreground">No payments, refunds or held quotes yet.</p>}
        {list.length > 0 && (
          <ol aria-label="Recent activity" className="grid max-h-[min(60vh,24rem)] divide-y overflow-y-auto">
            {list.map((i) => {
              const r = i.row;
              const hard = i.rules.some((x) => HARD_RULES.has(x));
              const Icon = r.kind === 'grant' ? CircleCheck : r.kind === 'revoked' ? Undo2 : r.kind === 'expired' ? CalendarX2
                : r.kind.startsWith('renewal.') ? RefreshCw : hard ? OctagonAlert : Hourglass;
              const showAmount = r.kind !== 'rule' && !isCascadedRevoke(r) && r.amountCents !== null;
              // review final N1: every row opens its deal, where the current status shows (a held quote may since have
              // been approved and paid, so Ask me may no longer list it).
              const href = r.briefId ? `/deals/${r.briefId}` : null;
              const body = (
                <>
                  <Icon aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <span className="grid min-w-0 flex-1 gap-0.5">
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="font-medium">{bellText(r)}</span>
                      {showAmount && <span className="font-mono tabular">{usd(r.amountCents!)}</span>}
                      {r.demo && <DemoChip />}
                      {open && isNew(i, seenAtOpen) && <span className="text-meta text-muted-foreground">New</span>}
                    </span>
                    {r.kind !== 'grant' && i.messages.map((m) => <span key={m} className="text-meta text-muted-foreground">{m}</span>)}
                    <span className="text-meta text-muted-foreground">
                      {r.deal ?? 'Unknown deal'}{r.kind === 'rule' && i.rules.length ? ` · ${i.rules.join(', ')}` : ''} · <time dateTime={new Date(r.createdAt).toISOString()}>{shortDateTime(r.createdAt)}</time>
                    </span>
                  </span>
                </>
              );
              return (
                <li key={i.key}>
                  {href
                    ? <Link href={href} onClick={() => setOpen(false)} className="flex gap-3 px-4 py-3 hover:bg-white/6">{body}</Link>
                    : <div className="flex gap-3 px-4 py-3">{body}</div>}
                </li>
              );
            })}
          </ol>
        )}
        <div className="border-t px-4 py-3">
          <Link href="/ledger" onClick={() => setOpen(false)} className="text-meta underline underline-offset-4">Open the full ledger</Link>
        </div>
      </PopoverContent>
    </Popover>
  );
}
