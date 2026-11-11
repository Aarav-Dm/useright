// @vitest-environment jsdom
// Batch 7C phase 3: the search box (Cmd/Ctrl+K) and the activity bell. Both read existing GET routes only.
// Review fixes (docs/reviews/b7c-review-phase3.md 1-9, b7c-review-phase3.md 1-12): each test below fails if the line it
// names is removed.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActivityBell, bellItems, bellText, isBellEvent, SEEN_KEY } from '@/components/creator/activity-bell';
import { ledgerSentence, ruleHeld, ruleTitle } from '@/components/creator/deal-extras';
import { DEALS_LOADED_MAX } from '@/components/creator/guide';
import { matchWords, QuickActions } from '@/components/creator/quick-actions';
import { OPEN_REQUEST_EVENT, RequestSheet } from '@/components/creator/request-sheet';
import type { DealRow } from '../lib/deals';
import type { LedgerRow } from '../lib/ledger';

const router = { replace: vi.fn(), push: vi.fn(), refresh: vi.fn() };
vi.mock('next/navigation', () => ({ useRouter: () => router, usePathname: () => '/deals', useSearchParams: () => new URLSearchParams() }));

const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
type Route = (url: string, init?: RequestInit) => Response | Promise<Response>;
let routes: Route;
const calls: { url: string; method: string }[] = [];
beforeEach(() => {
  calls.length = 0;
  router.push.mockClear();
  window.localStorage.clear();
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  Element.prototype.scrollIntoView = () => {};
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.releasePointerCapture ??= () => {};
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? 'GET' });
    return routes(url, init);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

/** A response the test releases by hand, to make two loads overlap. */
function deferred() {
  let release!: (r: Response) => void;
  const promise = new Promise<Response>((res) => { release = res; });
  return { promise, release };
}

const deal = (over: Partial<DealRow>): DealRow => ({
  briefId: 'b1', client: { id: 'c', name: 'Northwind Coffee' }, asset: { id: 'a', title: 'Morning Pour' }, source: 'paste',
  status: 'invoiced', reasons: [], gapTotalCents: 42000, paypalInvoiceId: null, demo: false, createdAt: '2026-10-29T12:00:00.000Z' as unknown as Date, ...over,
});
const at = (iso: string) => iso as unknown as Date;
const lrow = (over: Partial<LedgerRow>): LedgerRow => ({
  eventId: 'e', kind: 'rule', createdAt: at('2026-10-29T12:00:00.000Z'), briefId: 'b1', deal: 'Northwind Coffee · Morning Pour',
  versionId: 'v', versionNo: 1, scope: 'Social, US, 6 mo', rule: 'R1', result: 'pass', message: null, paypalInvoiceId: null,
  invoiceNumber: null, paypalTxnId: null, amountCents: null, label: 'Rule', status: 'pending', expiry: null, renewalDate: null, demo: false, ...over,
});

const DEALS = [
  deal({}),
  deal({ briefId: 'b2', client: { id: 'p', name: 'Pinecrest Outfitters' }, asset: { id: 'f', title: 'Rocky Beach' }, status: 'needs_approval', demo: true }),
];
const ctrlK = () => {
  const e = new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true });
  act(() => { window.dispatchEvent(e); });
  return e;
};
async function openBox() {
  fireEvent.click(screen.getByRole('button', { name: 'Search' }));
  return screen.findByRole('dialog', { name: 'Search' });
}

describe('search box', () => {
  beforeEach(() => { routes = (url) => (url === '/api/deals' ? ok({ deals: DEALS }) : ok({}, 404)); });

  it('opens with Ctrl+K and Cmd+K and takes the key press (review 1f); the button says Search', async () => {
    render(<QuickActions />);
    expect(screen.getByRole('button', { name: 'Search' }).getAttribute('aria-keyshortcuts')).toBe('Meta+K Control+K');
    const e = ctrlK();
    expect(e.defaultPrevented).toBe(true);
    expect(await screen.findByRole('dialog', { name: 'Search' })).toBeTruthy();
    ctrlK();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    fireEvent.keyDown(window, { key: 'K', metaKey: true });
    expect(await screen.findByRole('dialog', { name: 'Search' })).toBeTruthy();
  });

  it('ignores a keydown with no key and a held key (review 3)', async () => {
    render(<QuickActions />);
    const errors: unknown[] = [];
    const onError = (e: ErrorEvent) => errors.push(e.error);
    window.addEventListener('error', onError);
    expect(() => act(() => { window.dispatchEvent(new Event('keydown')); })).not.toThrow();
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, repeat: true, bubbles: true, cancelable: true })); });
    window.removeEventListener('error', onError);
    expect(errors).toEqual([]);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('never opens over another open dialog, such as the request sheet (review 9, review 10)', async () => {
    routes = (url) => (url === '/api/options' ? ok({ creatorSlug: 'imani', clients: [], assets: [] }) : ok({ deals: [] }));
    render(<><QuickActions /><RequestSheet /></>);
    fireEvent.click(screen.getByRole('button', { name: 'Add client request' }));
    await screen.findByRole('dialog', { name: 'Add client request' });
    const e = ctrlK();
    expect(e.defaultPrevented).toBe(false);
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
  });

  it('goes to a page, and everyday words find pages (review 6)', async () => {
    render(<QuickActions />);
    const dialog = await openBox();
    for (const label of ['Overview', 'Deals', 'Ask me', 'Ledger', 'Portfolio', 'Settings']) expect(within(dialog).getByRole('option', { name: label })).toBeTruthy();
    fireEvent.change(within(dialog).getByRole('combobox'), { target: { value: 'rate card' } });
    await waitFor(() => expect(within(dialog).queryByRole('option', { name: 'Ledger' })).toBeNull());
    fireEvent.click(within(dialog).getByRole('option', { name: 'Settings' }));
    expect(router.push).toHaveBeenCalledWith('/settings');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('finds a deal by client and opens it; demo deals keep their chip', async () => {
    render(<QuickActions />);
    const dialog = await openBox();
    const pine = await within(dialog).findByRole('option', { name: /Pinecrest Outfitters · Rocky Beach/ });
    expect(within(pine).getByText('Demo')).toBeTruthy();
    fireEvent.change(within(dialog).getByRole('combobox'), { target: { value: 'pinecrest' } });
    await waitFor(() => expect(within(dialog).queryByRole('option', { name: /Northwind/ })).toBeNull());
    fireEvent.click(within(dialog).getByRole('option', { name: /Pinecrest/ }));
    expect(router.push).toHaveBeenCalledWith('/deals/b2');
    expect(calls.every((c) => c.method === 'GET' && c.url === '/api/deals')).toBe(true);
  });

  it('matches whole words, not scattered letters (review 1b): "nwc" does not find Northwind Coffee', async () => {
    render(<QuickActions />);
    const dialog = await openBox();
    await within(dialog).findByRole('option', { name: /Northwind Coffee/ });
    fireEvent.change(within(dialog).getByRole('combobox'), { target: { value: 'nwc' } });
    await waitFor(() => expect(within(dialog).queryByRole('option', { name: /Northwind Coffee/ })).toBeNull());
  });

  it('never matches a deal by its id (review 2): "add" lists the action, not a deal whose id contains add', async () => {
    routes = (url) => (url === '/api/deals' ? ok({ deals: [deal({ briefId: '3fa2c1de-0000-4add-8000-000000000000' })] }) : ok({}, 404));
    render(<QuickActions />);
    const dialog = await openBox();
    await within(dialog).findByRole('option', { name: /Northwind Coffee/ });
    fireEvent.change(within(dialog).getByRole('combobox'), { target: { value: 'add' } });
    await waitFor(() => expect(within(dialog).queryByRole('option', { name: /Northwind Coffee/ })).toBeNull());
    expect(within(dialog).getByRole('option', { name: 'Add client request' })).toBeTruthy();
    expect(matchWords('deal:3fa2c1de-0000-4add-8000-000000000000', 'add', ['Northwind Coffee', 'Morning Pour', 'Invoice sent'])).toBe(0);
    expect(matchWords('Pinecrest Hotels Golden Hour', 'pine')).toBe(1);
  });

  it('a search typed before deals arrive never says "Nothing matches" (review 4, review 5)', async () => {
    const d = deferred();
    routes = (url) => (url === '/api/deals' ? d.promise : ok({}, 404));
    render(<QuickActions />);
    const dialog = await openBox();
    fireEvent.change(within(dialog).getByRole('combobox'), { target: { value: 'northwind' } });
    expect(within(dialog).getByText('Loading deals…')).toBeTruthy();
    expect(within(dialog).queryByText(/Nothing matches/)).toBeNull();
    await act(async () => { d.release(ok({ deals: DEALS })); });
    expect(await within(dialog).findByRole('option', { name: /Northwind Coffee/ })).toBeTruthy();
  });

  it('a failed load keeps its message and an arrow-key retry; the listbox holds options only (review 5)', async () => {
    let fail = true;
    routes = (url) => (url === '/api/deals' ? (fail ? ok({}, 500) : ok({ deals: DEALS })) : ok({}, 404));
    render(<QuickActions />);
    const dialog = await openBox();
    expect(await within(dialog).findByText('Couldn’t load deals, so they are not searched yet.')).toBeTruthy();
    const listbox = within(dialog).getByRole('listbox');
    expect(listbox.querySelectorAll('p, button')).toHaveLength(0);
    fireEvent.change(within(dialog).getByRole('combobox'), { target: { value: 'northwind' } });
    const retry = within(dialog).getByRole('option', { name: 'Try loading deals again' });
    fail = false;
    fireEvent.click(retry);
    expect(await within(dialog).findByRole('option', { name: /Northwind Coffee/ })).toBeTruthy();
  });

  it('says when only the newest deals are searched (review 8)', async () => {
    routes = (url) => (url === '/api/deals' ? ok({ deals: Array.from({ length: DEALS_LOADED_MAX }, (_, i) => deal({ briefId: `x${i}` })) }) : ok({}, 404));
    render(<QuickActions />);
    const dialog = await openBox();
    expect(await within(dialog).findByText(`Searching your newest ${DEALS_LOADED_MAX} deals.`)).toBeTruthy();
  });

  it('an older deals response never replaces a newer one (review 8)', async () => {
    const first = deferred();
    let n = 0;
    routes = (url) => (url === '/api/deals' ? (++n === 1 ? first.promise : ok({ deals: [deal({ briefId: 'new', client: { id: 'z', name: 'Zephyr Books' } })] })) : ok({}, 404));
    render(<QuickActions />);
    await openBox();
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const dialog = await openBox();
    expect(await within(dialog).findByRole('option', { name: /Zephyr Books/ })).toBeTruthy();
    await act(async () => { first.release(ok({ deals: [deal({ briefId: 'old', client: { id: 'o', name: 'Old Client' } })] })); });
    expect(within(dialog).queryByRole('option', { name: /Old Client/ })).toBeNull();
    expect(within(dialog).getByRole('option', { name: /Zephyr Books/ })).toBeTruthy();
  });

  it('a seeded paid deal never reads as paid', async () => {
    routes = (url) => (url === '/api/deals' ? ok({ deals: [deal({ briefId: 'b3', status: 'paid', demo: true })] }) : ok({}, 404));
    render(<QuickActions />);
    const opt = await within(await openBox()).findByRole('option', { name: /Northwind/ });
    expect(opt.textContent).toContain('Seeded as paid');
    expect(opt.textContent).not.toContain('Paid, file unlocked');
  });

  it('Escape puts focus back where it was before the box opened', async () => {
    render(<QuickActions />);
    const trigger = screen.getByRole('button', { name: 'Search' });
    trigger.focus();
    const dialog = await openBox();
    fireEvent.keyDown(within(dialog).getByRole('combobox'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });

  it('"Add client request" opens the existing sheet with focus inside it, never back on the Search button (review 1a)', async () => {
    routes = (url) => {
      if (url === '/api/deals') return ok({ deals: [] });
      if (url === '/api/options') return ok({ creatorSlug: 'imani', clients: [], assets: [] });
      return ok({}, 404);
    };
    const opened = vi.fn();
    window.addEventListener(OPEN_REQUEST_EVENT, opened);
    render(<><QuickActions /><RequestSheet /></>);
    const trigger = screen.getByRole('button', { name: 'Search' });
    trigger.focus(); // a real click focuses the button; the box returns focus to it on close unless told not to
    const dialog = await openBox();
    const focusedTrigger = vi.fn();
    trigger.addEventListener('focus', focusedTrigger);
    fireEvent.click(within(dialog).getByRole('option', { name: 'Add client request' }));
    await waitFor(() => expect(opened).toHaveBeenCalledTimes(1));
    const sheet = await screen.findByRole('dialog', { name: 'Add client request' });
    await waitFor(() => expect(sheet.contains(document.activeElement)).toBe(true));
    expect(focusedTrigger).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog', { name: 'Search' })).toBeNull();
    window.removeEventListener(OPEN_REQUEST_EVENT, opened);
  });
});

describe('activity bell', () => {
  const T = (h: number) => at(`2026-10-31T${String(h).padStart(2, '0')}:00:00.000Z`);
  const ROWS = [
    lrow({ eventId: 'g1', kind: 'grant', result: 'pass', amountCents: 42000, createdAt: T(10), label: 'Granted', versionId: 'v1' }),
    lrow({ eventId: 'r1', kind: 'rule', rule: 'R2', result: 'fail', message: '$900.00 exceeds your $500.00 per-deal cap.', createdAt: T(9), versionId: 'v2', briefId: 'b2' }),
    lrow({ eventId: 'r2', kind: 'rule', rule: 'R4', result: 'fail', message: 'Billboard needs your approval.', createdAt: T(9), versionId: 'v2', briefId: 'b2' }),
    lrow({ eventId: 'p1', kind: 'rule', rule: 'R1', result: 'pass', createdAt: T(9), versionId: 'v2' }),
    lrow({ eventId: 'r0', kind: 'rule', rule: 'R2', result: 'fail', message: 'An older run.', createdAt: T(7), versionId: 'v2', briefId: 'b2' }),
    lrow({ eventId: 's1', kind: 'invoice.sent', result: 'pass', label: 'Invoice sent', createdAt: T(8) }),
    lrow({ eventId: 'd1', kind: 'grant', result: 'pass', demo: true, amountCents: 40000, briefId: 'b9', deal: 'Quayside · Laptop Desk from Above', createdAt: T(6), versionId: 'v9' }),
    lrow({ eventId: 'c1', kind: 'revoked', result: 'fail', amountCents: 60000, createdAt: T(5), versionId: 'v4', message: 'Revoked because an earlier licence it built on was refunded.' }),
    lrow({ eventId: 'h1', kind: 'revoked', result: 'fail', amountCents: 30000, createdAt: T(5), versionId: 'v3', message: 'Payment refunded in PayPal; licence revoked and downloads stopped.' }),
    lrow({ eventId: 'f1', kind: 'grant', result: 'fail', label: 'Payment not verified', createdAt: T(4) }),
  ];
  beforeEach(() => { routes = (url) => (url === '/api/ledger' ? ok({ rows: ROWS }) : ok({}, 404)); });

  it('collapses one run of failing rules into one item and drops older runs (review 7, review 4)', () => {
    const items = bellItems(ROWS);
    expect(items.map((i) => i.key)).toEqual(['g1', 'r1', 'd1', 'c1', 'h1']);
    expect(items[1]).toMatchObject({ rules: ['R2', 'R4'], messages: ['$900.00 exceeds your $500.00 per-deal cap.', 'Billboard needs your approval.'] });
    expect(ROWS.filter(isBellEvent).map((r) => r.eventId)).toEqual(['g1', 'r1', 'r2', 'r0', 'd1', 'c1', 'h1']);
  });

  it('says what happens next in plain words (review 2) and tells a cascaded revoke from a refund (review 3, review 6)', () => {
    expect(bellText(ROWS[0]!)).toBe('Paid with PayPal, file unlocked');
    expect(bellText(ROWS[1]!)).toBe('Held for your OK');
    expect(bellText(lrow({ kind: 'rule', rule: 'EMAIL', result: 'fail' }))).toBe('Held: PayPal can’t take it as it is');
    expect(bellText(ROWS[6]!)).toBe('Seeded as paid');
    expect(bellText(ROWS[7]!)).toBe('Licence revoked: an earlier licence it built on was refunded');
    expect(bellText(ROWS[8]!)).toBe('Refunded in PayPal, licence revoked');
  });

  it('review final N1: a held quote that was later approved and paid reads as history, and links to its deal', async () => {
    window.localStorage.setItem(SEEN_KEY, T(1) as unknown as string);
    routes = (url) => (url === '/api/ledger' ? ok({ rows: [
      lrow({ eventId: 'pay', kind: 'grant', result: 'pass', amountCents: 90000, createdAt: T(12), versionId: 'v2', briefId: 'b2' }),
      lrow({ eventId: 'hold', kind: 'rule', rule: 'R2', result: 'fail', message: '$900.00 exceeds your $500.00 per-deal cap.', createdAt: T(9), versionId: 'v2', briefId: 'b2' }),
    ] }) : ok({}, 404));
    render(<ActivityBell />);
    fireEvent.click(await screen.findByRole('button', { name: /^Activity/ }));
    const list = await screen.findByRole('list', { name: 'Recent activity' });
    expect(list.textContent).toContain('Paid with PayPal, file unlocked');
    expect(list.textContent).toContain('Held for your OK');
    expect(list.textContent).not.toMatch(/Waiting for your OK|Can’t send to PayPal yet/);
    for (const a of within(list).getAllByRole('link')) expect(a.getAttribute('href')).toBe('/deals/b2');
  });

  it('review final N2: one rule event reads the same in the bell, the ledger, the timeline and Overview', () => {
    const held = lrow({ kind: 'rule', rule: 'R2', result: 'fail', message: '$900.00 exceeds your $500.00 per-deal cap.' });
    const hard = lrow({ kind: 'rule', rule: 'EMAIL', result: 'fail', message: 'The client has no email address.' });
    expect(ruleTitle(held)).toBe('R2 stopped, held for your OK'); // ledger row title and Overview recent activity
    expect(ledgerSentence(held)).toBe('R2 stopped, held for your OK: $900.00 exceeds your $500.00 per-deal cap.'); // deal timeline
    expect(bellText(held).toLowerCase()).toBe(ruleHeld('R2').toLowerCase());
    expect(ruleTitle(hard)).toBe('EMAIL stopped, held: PayPal can’t take it as it is');
    expect(bellText(hard).toLowerCase()).toBe(ruleHeld('EMAIL').toLowerCase());
    expect(ruleTitle(lrow({ rule: 'R1', result: 'pass' }))).toBe('R1 passed');
  });

  it('a first visit shows no count and remembers what is there; a later live event counts as 1 new (review 1)', async () => {
    const { unmount } = render(<ActivityBell />);
    await waitFor(() => expect(window.localStorage.getItem(SEEN_KEY)).toBe('2026-10-31T10:00:00.000Z'));
    expect(screen.getByRole('button', { name: 'Activity' })).toBeTruthy();
    unmount();
    routes = (url) => (url === '/api/ledger' ? ok({ rows: [lrow({ eventId: 'g2', kind: 'grant', result: 'pass', amountCents: 9000, createdAt: T(11), versionId: 'v8' }), ...ROWS] }) : ok({}, 404));
    render(<ActivityBell />);
    expect(await screen.findByRole('button', { name: 'Activity, 1 new' })).toBeTruthy();
  });

  it('counts only live events newer than the mark, and marks only those as New when opened (review 1c)', async () => {
    window.localStorage.setItem(SEEN_KEY, T(8) as unknown as string);
    render(<ActivityBell />);
    const bell = await screen.findByRole('button', { name: 'Activity, 2 new' }); // g1 and the R2/R4 item; demo d1 never counts
    fireEvent.click(bell);
    const list = await screen.findByRole('list', { name: 'Recent activity' });
    const items = within(list).getAllByRole('listitem');
    expect(items.map((li) => li.textContent?.includes('New'))).toEqual([true, true, false, false, false]);
    await waitFor(() => expect(window.localStorage.getItem(SEEN_KEY)).toBe('2026-10-31T10:00:00.000Z'));
  });

  it('lists server amounts, plain words and Demo chips; a cascaded revoke has no refund text and no amount', async () => {
    window.localStorage.setItem(SEEN_KEY, T(1) as unknown as string);
    render(<ActivityBell />);
    fireEvent.click(await screen.findByRole('button', { name: /^Activity/ }));
    const items = within(await screen.findByRole('list', { name: 'Recent activity' })).getAllByRole('listitem') as [HTMLElement, HTMLElement, HTMLElement, HTMLElement, HTMLElement];
    expect(items[0].textContent).toContain('$420.00');
    expect(within(items[0]).getByRole('link').getAttribute('href')).toBe('/deals/b1');
    expect(items[1].textContent).toContain('Held for your OK');
    expect(items[1].textContent).toContain('Billboard needs your approval.');
    expect(items[1].textContent).toContain('R2, R4');
    expect(within(items[1]).getByRole('link').getAttribute('href')).toBe('/deals/b2');
    expect(within(items[2]).getByText('Demo')).toBeTruthy();
    expect(items[2].textContent).not.toContain('PayPal');
    expect(items[3].textContent).toContain('Revoked because an earlier licence it built on was refunded.');
    expect(items[3].textContent).not.toContain('Refunded in PayPal');
    expect(items[3].textContent).not.toContain('$600.00');
    expect(items[4].textContent).toContain('Refunded in PayPal, licence revoked');
    expect(items[4].textContent).toContain('$300.00');
    expect(calls.every((c) => c.method === 'GET' && c.url === '/api/ledger')).toBe(true);
  });

  it('reads the ledger again when opened (replaces the per-page refresh, review 12)', async () => {
    render(<ActivityBell />);
    await waitFor(() => expect(calls.filter((c) => c.url === '/api/ledger')).toHaveLength(1));
    fireEvent.click(await screen.findByRole('button', { name: /^Activity/ }));
    await waitFor(() => expect(calls.filter((c) => c.url === '/api/ledger')).toHaveLength(2));
  });

  it('an older ledger response never replaces a newer one (review 8)', async () => {
    const first = deferred();
    let n = 0;
    routes = (url) => (url === '/api/ledger' ? (++n === 1 ? first.promise : ok({ rows: ROWS })) : ok({}, 404));
    window.localStorage.setItem(SEEN_KEY, T(1) as unknown as string);
    render(<ActivityBell />);
    fireEvent.click(screen.getByRole('button', { name: /^Activity/ }));
    expect(await screen.findByRole('list', { name: 'Recent activity' })).toBeTruthy();
    await act(async () => { first.release(ok({ rows: [] })); });
    expect(within(screen.getByRole('list', { name: 'Recent activity' })).getAllByRole('listitem')).toHaveLength(5);
  });

  it('still works when the browser refuses storage (review 1e)', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
    render(<ActivityBell />);
    fireEvent.click(await screen.findByRole('button', { name: 'Activity' }));
    expect(await screen.findByRole('list', { name: 'Recent activity' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Activity' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Activity' })).toBeTruthy());
  });

  it('says so when the ledger cannot load', async () => {
    routes = () => ok({}, 500);
    render(<ActivityBell />);
    fireEvent.click(await screen.findByRole('button', { name: 'Activity' }));
    expect(await screen.findByText('Couldn’t load activity.')).toBeTruthy();
  });
});
