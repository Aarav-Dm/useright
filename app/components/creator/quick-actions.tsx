'use client';
// Batch 7C phase 3: the search box (Cmd+K or Ctrl+K, or the "Search" button). Go to a page, add a client request
// (opens the existing sheet), or find a deal by client or photo. Read only: deals come from the existing
// GET /api/deals; nothing here prices, sends or approves.
import { FilePlus2, Images, Inbox, LayoutDashboard, RotateCw, ScrollText, Search, ShieldCheck, SlidersHorizontal, type LucideIcon } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { DEALS_LOADED_MAX } from '@/components/creator/guide';
import { DemoChip } from '@/components/creator/page-bits';
import { OPEN_REQUEST_EVENT } from '@/components/creator/request-sheet';
import { Button } from '@/components/ui/button';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { STATUS_LABEL } from '@/lib/format';
import type { DealRow } from '@/lib/deals';

/** review B7C-3 finding 6: everyday words per page, so "rate card" or "refund" finds the right place. */
export const PAGES: { href: string; label: string; icon: LucideIcon; words: string[] }[] = [
  { href: '/overview', label: 'Overview', icon: LayoutDashboard, words: ['home', 'totals', 'earned', 'money', 'summary'] },
  { href: '/deals', label: 'Deals', icon: Inbox, words: ['requests', 'clients', 'quotes', 'queue'] },
  { href: '/ask', label: 'Ask me', icon: ShieldCheck, words: ['approve', 'approval', 'waiting', 'typed total', 'stopped', 'reject'] },
  { href: '/ledger', label: 'Ledger', icon: ScrollText, words: ['receipts', 'refunds', 'history', 'invoices', 'payments', 'events'] },
  { href: '/portfolio', label: 'Portfolio', icon: Images, words: ['photos', 'images', 'public page', 'licences'] },
  { href: '/settings', label: 'Settings', icon: SlidersHorizontal, words: ['rate card', 'prices', 'rules', 'autopilot', 'limits', 'caps', 'clients list'] },
];

// review B7C-3 finding 11: the selected item uses white 6%, the dashboard's row highlight, not the 8% accent glass.
const ITEM = 'min-h-11 gap-3 px-3 text-body! cursor-pointer data-[selected=true]:bg-white/6!';

/**
 * Word match, not fuzzy letters: every typed word must appear in the item's words. Items pass their searchable words
 * as `keywords` and keep an id-only `value`, so a deal's id never matches (review B7C-3 finding 2); with no keywords the
 * value is searched.
 */
export const matchWords = (value: string, search: string, keywords: string[] = []) => {
  const hay = (keywords.length ? keywords.join(' ') : value).toLowerCase();
  return search.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w)) ? 1 : 0;
};

/** Seeded paid or refunded deals never read as a PayPal result (same words as the Deals table). */
const dealStatus = (d: DealRow) =>
  d.demo && d.status === 'paid' ? 'Seeded as paid' : d.demo && d.status === 'refunded' ? 'Seeded as refunded' : STATUS_LABEL[d.status] ?? d.status;

export function QuickActions() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const openRef = useRef(false);
  const [deals, setDeals] = useState<DealRow[] | 'error' | null>(null);
  // review B7C-3 finding 7: no shortcut hint until the platform is known, so it never flips from "Ctrl K" to "⌘K".
  const [mac, setMac] = useState<boolean | null>(null);
  const openSheet = useRef(false);
  const request = useRef(0);
  const returnTo = useRef<HTMLElement | null>(null);

  useEffect(() => { openRef.current = open; }, [open]);
  /** Opens the box, remembering where focus was so closing it can put focus back. */
  const show = useCallback(() => {
    returnTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setOpen(true);
  }, []);
  useEffect(() => { setMac(/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)); }, []);

  // Cmd+K on a Mac, Ctrl+K elsewhere, from anywhere on a creator page.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // review B7C-3 finding 3: autofill sends keydown with no key; a held key repeats.
      if (typeof e.key !== 'string' || e.repeat) return;
      if (e.key.toLowerCase() !== 'k' || !(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      // review B7C-3 finding 10 / review finding 9: never stack this box over another open dialog (the request sheet).
      if (!openRef.current && document.querySelector('[role="dialog"][data-state="open"]')) return;
      e.preventDefault();
      if (openRef.current) setOpen(false); else show();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [show]);

  const loadDeals = useCallback(async () => {
    const mine = ++request.current; // review B7C-3 finding 8: a slower, older response never replaces a newer one
    setDeals(null);
    try {
      const res = await fetch('/api/deals');
      if (!res.ok) throw new Error(String(res.status));
      const body = await res.json() as { deals?: DealRow[] };
      if (mine === request.current) setDeals(Array.isArray(body.deals) ? body.deals : 'error');
    } catch {
      if (mine === request.current) setDeals('error');
    }
  }, []);
  useEffect(() => { if (open) void loadDeals(); }, [open, loadDeals]);

  const go = (href: string) => {
    setOpen(false);
    router.push(href);
  };
  const addRequest = () => {
    openSheet.current = true;
    setOpen(false);
  };

  // review B7C-3 findings 4 and 5 / review finding 5: the deals state lives outside the list (a live line), so a search
  // typed before deals arrive never reads "Nothing matches".
  const status = deals === null ? 'Loading deals…'
    : deals === 'error' ? 'Couldn’t load deals, so they are not searched yet.'
      : deals.length >= DEALS_LOADED_MAX ? `Searching your newest ${DEALS_LOADED_MAX} deals.` : '';
  const empty = deals === null ? 'Still loading deals…' : deals === 'error' ? 'Nothing matches in pages. Deals could not be loaded.' : 'Nothing matches. Try a client or photo name.';

  return (
    <>
      <Button variant="outline" className="h-11 gap-2 max-sm:w-11 max-sm:px-0 md:h-10" onClick={show} aria-label="Search" aria-keyshortcuts="Meta+K Control+K">
        <Search aria-hidden className="size-4" />
        {/* review B7C-3 findings 7 and 8: it says what it does, and is icon-only on a phone so the toolbar keeps one row. */}
        <span className="max-sm:sr-only">Search</span>
        {mac !== null && <kbd className="ml-1 hidden rounded border px-1.5 font-mono text-meta text-muted-foreground md:inline">{mac ? '⌘K' : 'Ctrl K'}</kbd>}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          showCloseButton={false}
          // review B7C-3 finding 9: on a phone the box sits at the top, above the on-screen keyboard.
          className="theme-dashboard dash-glass gap-0 overflow-hidden p-0 text-foreground max-sm:top-4 max-sm:translate-y-0 sm:max-w-xl"
          onCloseAutoFocus={() => {
            // The box has no Radix DialogTrigger, and Radix's own close handler already stops the default focus
            // restore, so focus is put back by hand: to where it was before the box opened, except for
            // "Add client request", where the sheet takes focus instead (review B7C-3 finding 1a).
            if (openSheet.current) {
              openSheet.current = false;
              window.dispatchEvent(new Event(OPEN_REQUEST_EVENT));
              return;
            }
            returnTo.current?.focus();
          }}
        >
          <DialogTitle className="sr-only">Search</DialogTitle>
          <DialogDescription className="sr-only">Go to a page, add a client request, or find a deal by client or photo.</DialogDescription>
          <Command loop filter={matchWords} className="bg-transparent">
            <CommandInput placeholder="Go to a page, add a request, or find a client…" aria-label="Search pages, actions and deals" className="h-12 text-body!" />
            <p aria-live="polite" className="px-3 pt-2 text-meta text-muted-foreground empty:hidden">{status}</p>
            <CommandList className="max-h-[min(60vh,26rem)] pb-2 max-sm:max-h-[40dvh]">
              <CommandEmpty className="py-6 text-center text-body text-muted-foreground">{empty}</CommandEmpty>
              <CommandGroup heading="Actions">
                <CommandItem value="action:add-request" keywords={['Add client request', 'new', 'paste', 'screenshot', 'message']} onSelect={addRequest} className={ITEM}>
                  <FilePlus2 aria-hidden />
                  Add client request
                </CommandItem>
              </CommandGroup>
              {deals === 'error' && (
                <CommandGroup heading="Deals" forceMount>
                  <CommandItem value="action:retry-deals" forceMount onSelect={() => void loadDeals()} className={ITEM}>
                    <RotateCw aria-hidden />
                    Try loading deals again
                  </CommandItem>
                </CommandGroup>
              )}
              <CommandGroup heading="Go to">
                {PAGES.map(({ href, label, icon: Icon, words }) => (
                  <CommandItem key={href} value={`page:${href}`} keywords={[label, 'go to', ...words]} onSelect={() => go(href)} className={ITEM}>
                    <Icon aria-hidden />
                    {label}
                  </CommandItem>
                ))}
              </CommandGroup>
              {Array.isArray(deals) && deals.length > 0 && (
                <CommandGroup heading="Deals">
                  {deals.map((d) => {
                    const client = d.client?.name ?? 'Unknown sender';
                    const photo = d.asset?.title ?? 'no photo';
                    const label = dealStatus(d);
                    return (
                      <CommandItem key={d.briefId} value={`deal:${d.briefId}`} keywords={[client, photo, label]} onSelect={() => go(`/deals/${d.briefId}`)} className={ITEM}>
                        <span className="grid min-w-0 flex-1">
                          <span className="truncate font-medium">{client} · {photo}</span>
                          <span className="text-meta text-muted-foreground">{label}</span>
                        </span>
                        {d.demo && <DemoChip />}
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              )}
            </CommandList>
            {Array.isArray(deals) && deals.length === 0 && <p className="px-3 pb-3 text-meta text-muted-foreground">No deals yet.</p>}
          </Command>
        </DialogContent>
      </Dialog>
    </>
  );
}
