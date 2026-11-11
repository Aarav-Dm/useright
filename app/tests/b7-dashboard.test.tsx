// @vitest-environment jsdom
// Batch 7 (7A + review fixes): dashboard pages per docs/ui, rendered in jsdom with fetch stubbed (style of b6-ui.test.tsx).
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DealRoomView, type DealRoomActions } from '@/components/creator/deal-room';
import type { BriefView } from '../lib/briefs';
import type { DealRow } from '../lib/deals';
import type { AskAlert, AskItem, LedgerRow } from '../lib/ledger';
import type { SettingsView } from '../lib/settings';

const router = { replace: vi.fn(), push: vi.fn(), refresh: vi.fn() };
vi.mock('next/navigation', () => ({ useRouter: () => router, usePathname: () => '/deals', useSearchParams: () => new URLSearchParams() }));

const { default: DealsPage } = await import('@/app/(creator)/deals/page');
const { default: AskPage } = await import('@/app/(creator)/ask/page');
const { default: LedgerPage } = await import('@/app/(creator)/ledger/page');
const { default: SettingsPage } = await import('@/app/(creator)/settings/page');
const { default: PortfolioPage } = await import('@/app/(creator)/portfolio/page');
const { default: LoginPage } = await import('@/app/login/page');

const iso = '2026-10-29T12:00:00.000Z';
const BRIEF = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
type Route = (url: string, init?: RequestInit) => Response | Promise<Response>;
let routes: Route;
const calls: string[] = [];
const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

beforeEach(() => {
  calls.length = 0;
  // Radix radio/checkbox measure themselves; jsdom has no ResizeObserver.
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    return routes(url, init);
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const deal = (over: Partial<DealRow>): DealRow => ({
  briefId: BRIEF, client: { id: 'c', name: 'Pinecrest Hotels' }, asset: { id: 'a', title: 'Vineyard Harvest' }, source: 'paste',
  status: 'invoiced', reasons: [], gapTotalCents: 40000, paypalInvoiceId: 'INV2-1', demo: false, createdAt: iso as unknown as Date, ...over,
});

describe('Deals', () => {
  it('shows status words, reasons, no-price and unknown sender; a seeded paid deal is marked demo, not verified', async () => {
    routes = () => ok({ deals: [
      deal({}),
      deal({ briefId: 'b2', client: null, status: 'needs_creator', reasons: ['unknown_sender'], gapTotalCents: null }),
      deal({ briefId: 'b3', client: { id: 'q', name: 'Quayside Press' }, status: 'paid', gapTotalCents: 0, demo: true }),
    ] });
    render(<DealsPage />);
    expect(await screen.findByText('Invoice sent')).toBeTruthy();
    expect(screen.getByText('Unknown sender')).toBeTruthy();
    expect(screen.getByText('No price yet')).toBeTruthy();
    expect(screen.getByText(/The sender is not one of your clients/)).toBeTruthy();
    expect(screen.getByText('$400.00')).toBeTruthy();
    expect(screen.getByText('$400.00').closest('td')?.className).toContain('max-md:pr-6!');
    expect(screen.getByText('Seeded as paid')).toBeTruthy();
    expect(screen.getByText('Demo')).toBeTruthy();
    expect(screen.queryByText('Paid, file unlocked')).toBeNull();
    expect(screen.getByText('Paid')).toBeTruthy(); // the Due column says what happened, not a stale $0.00
    expect(screen.getByRole('link', { name: 'Add a request' }).getAttribute('href')).toBe('/dev/intake');
  });

  it('an initial load error offers Try again, which loads the rows', async () => {
    let fail = true;
    routes = () => { if (fail) throw new TypeError('Failed to fetch'); return ok({ deals: [deal({})] }); };
    render(<DealsPage />);
    expect(await screen.findByText('Couldn’t load deals. Try again.')).toBeTruthy();
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Invoice sent')).toBeTruthy();
    await waitFor(() => expect(screen.queryByText('Couldn’t load deals. Try again.')).toBeNull());
  });

  it('teaches the empty state', async () => {
    routes = () => ok({ deals: [] });
    render(<DealsPage />);
    expect(await screen.findByText('No requests yet. Paste a client message or screenshot to check its usage.')).toBeTruthy();
  });
});

const askItem: AskItem = {
  briefId: BRIEF, versionId: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff', versionNo: 2,
  client: { name: 'Northwind Coffee', email: 'buying@northwind.example' }, asset: { title: 'Morning Pour' },
  scope: 'Social + Billboard, US, 6 mo', totalCents: 90000,
  failing: [
    { rule: 'R2', code: 'over_deal_cap:90000:50000', message: '$900.00 exceeds your $500.00 per-deal cap.' },
    { rule: 'R4', code: 'needs_approval:billboard', message: 'Billboard needs your approval.' },
  ],
  hardBlock: false, sendError: null, createdAt: iso as unknown as Date,
};
const alert: AskAlert = { eventId: 'e1', kind: 'revoked_by_parent_refund', briefId: 'b9', message: 'This quote was withdrawn because the licence it built on was refunded. Re-quote the deal.', createdAt: iso as unknown as Date, demo: true };

describe('Ask me', () => {
  it('guides the typed total: neutral while typing, mismatch after blur, match enables the exact approve action', async () => {
    routes = () => ok({ items: [askItem], alerts: [alert] });
    render(<AskPage />);
    const input = await screen.findByLabelText('Type the total to approve ($)');
    expect(screen.getByText('Payments that need you')).toBeTruthy();
    expect(screen.getByText(alert.message)).toBeTruthy();
    expect(screen.getByText('Demo')).toBeTruthy();
    expect(screen.getByText('Your approval is needed before this invoice is sent.')).toBeTruthy();
    expect(screen.getByText('$900.00 exceeds your $500.00 per-deal cap.')).toBeTruthy();
    expect(screen.getByText('Billboard needs your approval.')).toBeTruthy();
    expect(screen.getByRole('region', { name: /Northwind Coffee · Morning Pour/ })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Why the agent stopped' })).toBeTruthy();
    expect(screen.getByText('Approve this quote')).toBeTruthy();
    expect(screen.getByText('Type the exact total to approve. Nothing else sends it.')).toBeTruthy();
    const approve = screen.getByRole('button', { name: 'Approve and send $900.00 invoice' }) as HTMLButtonElement;
    expect(approve.disabled).toBe(true);
    fireEvent.change(input, { target: { value: '90' } });
    expect(screen.getByText('Type 900.00 to approve.')).toBeTruthy();
    fireEvent.blur(input);
    expect(screen.getByText('That is $90.00; this quote totals $900.00.')).toBeTruthy();
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(approve.disabled).toBe(true);
    // Enter with a mismatch sends nothing.
    fireEvent.submit(input.closest('form')!);
    expect(calls.filter((c) => c.startsWith('POST'))).toHaveLength(0);
    fireEvent.change(input, { target: { value: '900.00' } });
    expect(screen.getByText('Matches this quote’s total.')).toBeTruthy();
    expect(approve.disabled).toBe(false);
  });

  it('review 3: Reject in flight says "Rejecting…" and never relabels Approve', async () => {
    const pending = deferred<Response>();
    routes = (_url, init) => ((init?.method ?? 'GET') === 'GET' ? ok({ items: [askItem], alerts: [] }) : pending.promise);
    render(<AskPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Reject' }));
    expect(screen.getByRole('button', { name: 'Rejecting…' })).toBeTruthy();
    expect(screen.queryByText('Approving and sending…')).toBeNull();
    await act(async () => { pending.resolve(ok({ ok: true })); });
    expect(await screen.findByText('Rejected. No new invoice was sent by this action.')).toBeTruthy();
  });

  it('review 10: a stale result stays readable after the queue reloads without that quote', async () => {
    let queue: AskItem[] = [askItem];
    routes = (_url, init) => {
      if ((init?.method ?? 'GET') === 'GET') return ok({ items: queue, alerts: [] });
      queue = [{ ...askItem, versionId: 'cccccccc-dddd-4eee-8fff-000000000000', versionNo: 3 }];
      return ok({ error: 'this quote changed since you opened it; refresh to see the current one', code: 'stale' }, 409);
    };
    render(<AskPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Reject' }));
    expect(await screen.findByText('This quote changed. Review the latest version before approving.')).toBeTruthy();
    await waitFor(() => expect(screen.getByText('v3')).toBeTruthy());
    expect(screen.getByText('This quote changed. Review the latest version before approving.')).toBeTruthy();
    expect(screen.queryByText(/refresh to see the current one/)).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Dismiss' })).toHaveLength(1);
  });

  it('a hard block offers Open the deal instead of an approve form', async () => {
    routes = () => ok({ items: [{ ...askItem, hardBlock: true }], alerts: [] });
    render(<AskPage />);
    expect(await screen.findByText(/Approving cannot fix this\./)).toBeTruthy();
    expect(screen.queryByLabelText('Type the total to approve ($)')).toBeNull();
  });

  it('a failed load says so and retries', async () => {
    let n = 0;
    routes = () => (++n === 1 ? ok({ error: 'x' }, 500) : ok({ items: [], alerts: [] }));
    render(<AskPage />);
    expect(await screen.findByText('Couldn’t load approvals. Try again.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Nothing waiting. Quotes the agent cannot send on its own appear here.')).toBeTruthy();
  });
});

// ---------------------------------------------------------------- deal room interactions (review 2, review 5)

function roomView(over: Partial<BriefView>): BriefView {
  return {
    brief: { id: BRIEF, creator_id: 'c', client_id: 'cl', asset_id: 'a', source: 'paste', raw: 'x', claimed_sender: null, state: 'extracted', created_at: iso as unknown as Date, hasImage: false, rejected_at: null },
    status: 'needs_approval', reasons: ['over_deal_cap:90000:50000'], notes: [],
    client: { id: 'cl', name: 'Northwind Coffee', email: 'buying@northwind.example', allowed: true },
    asset: { id: 'a', title: 'Morning Pour' },
    transcript: { id: 't', lines: [{ speaker: 'client', text: 'We want a billboard too.' }], confirmed_at: iso as unknown as Date, created_at: iso as unknown as Date },
    extraction: null, checks: null, licence: null, cardSource: null, gapPreview: null, editable: false, webhookLastReceivedAt: null,
    version: {
      id: 'v', versionNo: 2, status: 'pending', totalCents: 90000, scope: { channels: ['social', 'billboard'], territory: 'US', durationMonths: 6, exclusive: false },
      contentHash: 'h', sendState: 'idle', sendError: null, extractionId: 'x', rejectedAt: null, createdAt: iso as unknown as Date, invoice: null,
      policy: { pass: false, hardBlock: false, evaluatedAt: iso, mode: 'autopilot', results: [{ rule: 'R2', pass: false, code: 'over_deal_cap:90000:50000', message: '$900.00 exceeds your $500.00 per-deal cap.' }] },
    },
    ...over,
  } as BriefView;
}

describe('deal room', () => {
  it('review 2: approval needs the exact total, names the amount and sends the typed text', () => {
    const decided: [string, string | undefined][] = [];
    const actions: DealRoomActions = { onEdit: () => {}, onConfirm: () => {}, onDecide: (a, t) => { decided.push([a, t]); }, onCopy: () => {}, onError: () => {} };
    render(<DealRoomView view={roomView({})} options={null} busy={false} actions={actions} />);
    const input = screen.getByLabelText('Type the total to approve ($)');
    const approve = screen.getByRole('button', { name: 'Approve and send $900.00 invoice' }) as HTMLButtonElement;
    fireEvent.change(input, { target: { value: '90' } });
    fireEvent.blur(input);
    expect(approve.disabled).toBe(true);
    expect(screen.getByText('That is $90.00; this quote totals $900.00.')).toBeTruthy();
    expect(input.getAttribute('aria-describedby')).toBe('typed-hint');
    fireEvent.submit(input.closest('form')!);
    expect(decided).toEqual([]);
    fireEvent.change(input, { target: { value: '900.00' } });
    expect(approve.disabled).toBe(false);
    fireEvent.click(approve);
    expect(decided).toEqual([['approve', '900.00']]);
  });

  it('review 5: cancel confirmation keeps keyboard focus through open, back out and confirm', async () => {
    const decided: string[] = [];
    const actions: DealRoomActions = { onEdit: () => {}, onConfirm: () => {}, onDecide: (a) => { decided.push(a); }, onCopy: () => {}, onError: () => {} };
    const base = roomView({});
    const view = roomView({
      status: 'invoiced', reasons: [],
      version: { ...base.version!, sendState: 'sent', policy: null, invoice: { invoiceNumber: 'UR-0123456789abcdef012345', paypalInvoiceId: 'INV2-TEST-0001', state: 'sent', payerUrl: null, sentAt: iso as unknown as Date, payPath: null, payUrl: null, lastCheckedAt: null, demo: false } },
    });
    render(<DealRoomView view={view} options={null} busy={false} actions={actions} />);
    expect(screen.getByText('sent')).toBeTruthy();
    expect(screen.getByText('UR-0123456789abcdef012345')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel invoice and re-quote' }));
    await waitFor(() => expect(document.activeElement?.textContent).toBe('Keep invoice'));
    fireEvent.click(screen.getByRole('button', { name: 'Keep invoice' }));
    await waitFor(() => expect(document.activeElement?.textContent).toBe('Cancel invoice and re-quote'));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel invoice and re-quote' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel invoice' }));
    expect(decided).toEqual(['cancel_requote']);
    await waitFor(() => expect(document.activeElement?.id).toBe('invoice-title'));
  });
});

// ---------------------------------------------------------------- ledger

const lrow = (over: Partial<LedgerRow>): LedgerRow => ({
  eventId: 'e', kind: 'rule', createdAt: iso as unknown as Date, briefId: BRIEF, deal: 'Northwind Coffee · Morning Pour', versionId: 'v', versionNo: 2,
  scope: 'Social + Billboard, US, 6 mo', rule: 'R2', result: 'fail', message: '$900.00 exceeds your $500.00 per-deal cap.', paypalInvoiceId: null,
  invoiceNumber: null, paypalTxnId: null, amountCents: null, label: 'Rule', status: 'pending', expiry: null, renewalDate: null, demo: false, ...over,
});

describe('Ledger', () => {
  it('reads rules as passed/stopped; Verified only for a live grant, Demo for a seeded one; inspects inline under its row', async () => {
    routes = () => ok({ rows: [
      lrow({ eventId: 'r2' }),
      lrow({ eventId: 'r1', rule: 'R1', result: 'pass', message: 'The client is on your allowed list.' }),
      lrow({ eventId: 'g', kind: 'grant', rule: null, result: 'pass', label: 'Granted', deal: 'Quayside Press · Laptop Desk from Above', paypalTxnId: 'SEED-DEMO-0002', paypalInvoiceId: 'INV2-DEMO-SEED-0000-0003', amountCents: 40000, status: 'paid', demo: true }),
      lrow({ eventId: 'live', kind: 'grant', rule: null, result: 'pass', label: 'Granted', deal: 'Harbor Co · Harbor Light', paypalTxnId: 'CAP00000000000042', paypalInvoiceId: 'INV2-LIVE-0001', amountCents: 42000, status: 'paid' }),
    ] });
    render(<LedgerPage />);
    expect(await screen.findByText('stopped')).toBeTruthy();
    expect(screen.getByText('passed')).toBeTruthy();
    expect(screen.getAllByText('Verified')).toHaveLength(1);
    expect(screen.getByText('Seeded as paid')).toBeTruthy();
    expect(screen.getByText('Demo')).toBeTruthy();
    expect(screen.getByText('4 of 4 events')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Filter by deal, event or id'), { target: { value: 'quayside' } });
    expect(screen.getByText('1 of 4 events')).toBeTruthy();
    expect(screen.queryByText('Verified')).toBeNull();
    const inspect = screen.getByRole('button', { name: /^Inspect/ });
    fireEvent.click(inspect);
    const detail = screen.getByRole('region', { name: /Seeded as paid \(demo\)/ });
    // review 7: the detail is the row right after the inspected one, and focus moves into it.
    expect(inspect.closest('tr')!.nextElementSibling!.contains(detail)).toBe(true);
    await waitFor(() => expect(detail.contains(document.activeElement)).toBe(true));
    expect(within(detail).getByText('Demo data seeded for the walkthrough. PayPal never saw this event.')).toBeTruthy();
    expect(within(detail).getByText('INV2-DEMO-SEED-0000-0003')).toBeTruthy();
    expect(within(detail).getByText('Demo invoice id')).toBeTruthy();
    expect(within(detail).getByText('(current state, not at event time)')).toBeTruthy();
    fireEvent.click(within(detail).getByRole('button', { name: 'Close details' }));
    expect(screen.queryByRole('region', { name: /Seeded as paid/ })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(inspect));

    fireEvent.change(screen.getByLabelText('Filter by deal, event or id'), { target: { value: 'nothing-like-this' } });
    expect(screen.getByText('No events match these filters.')).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: 'Clear' })[0]!);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Filter by deal, event or id')));
  });
});

// ---------------------------------------------------------------- settings

const settings: SettingsView = {
  rateCard: { social: 15000, web: 10000, print: 42000, billboard: 90000, OOH: 90000, TV: 150000, US: 0, NA: 10000, WORLD: 30000, '6mo': 15000, '12mo': 30000 },
  perDealCapCents: 50000, rolling30CapCents: 150000, dailyMaxSends: 10, timezone: 'America/New_York',
  autoChannels: ['social', 'web', 'print'], askChannels: ['billboard', 'exclusive'], allowedClientIds: ['c1'],
  clients: [{ id: 'c1', name: 'Northwind Coffee', email: 'buying@northwind.example', allowed: true }],
} as SettingsView;

describe('Settings', () => {
  it('Save is off until something changes; a refused save links the issue to its field by label and clears it on edit', async () => {
    routes = (url, init) => {
      if ((init?.method ?? 'GET') === 'GET') return ok(settings);
      return ok({ error: 'invalid settings', issues: [{ path: 'perDealCapCents', message: 'Number must be greater than or equal to 0' }] }, 400);
    };
    render(<SettingsPage />);
    const save = await screen.findByRole('button', { name: 'Save settings' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect((screen.getByLabelText('Per-deal cap') as HTMLInputElement).value).toBe('500.00');
    expect(screen.getAllByRole('radio', { name: 'Always ask me', checked: true })).toHaveLength(2); // billboard, exclusive
    expect(within(screen.getByRole('radiogroup', { name: 'Billboard' })).getByRole('radio', { name: 'Always ask me' }).getAttribute('aria-checked')).toBe('true');
    // review 3: no choice promises the option cannot be sold.
    expect(screen.queryByText('Not offered')).toBeNull();
    expect(screen.getByText(/you can still approve it by hand/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Per-deal cap'), { target: { value: 'abc' } });
    expect(screen.getByText('You have unsaved changes.')).toBeTruthy();
    await act(async () => { fireEvent.click(save); });
    expect(await screen.findByText('Check the highlighted settings.')).toBeTruthy();
    const cap = screen.getByLabelText('Per-deal cap');
    expect(cap.getAttribute('aria-invalid')).toBe('true');
    expect(cap.getAttribute('aria-describedby')).toBe('cap-err');
    expect((cap as HTMLInputElement).value).toBe('abc');
    expect(screen.getByRole('link', { name: 'Per-deal cap' }).getAttribute('href')).toBe('#cap');
    fireEvent.change(cap, { target: { value: '500.00' } });
    expect(cap.getAttribute('aria-invalid')).toBeNull();
  });

  it('review 17: dollars become cents through the strict parser', async () => {
    let put: Record<string, unknown> | null = null;
    routes = (url, init) => {
      if ((init?.method ?? 'GET') === 'GET') return ok(settings);
      put = JSON.parse(String(init!.body));
      return ok(settings);
    };
    render(<SettingsPage />);
    fireEvent.change(await screen.findByLabelText('Per-deal cap'), { target: { value: '0.29' } });
    fireEvent.change(screen.getByLabelText('Per-client 30-day cap'), { target: { value: '12345678.00' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save settings' })); });
    await waitFor(() => expect(put).not.toBeNull());
    expect(put!.perDealCapCents).toBe(29);
    expect(put!.rolling30CapCents).toBeNull(); // NaN serialises as null; the server names the issue
  });

  it('a network failure keeps the changes and says so', async () => {
    routes = (url, init) => {
      if ((init?.method ?? 'GET') === 'GET') return ok(settings);
      throw new TypeError('Failed to fetch');
    };
    render(<SettingsPage />);
    fireEvent.change(await screen.findByLabelText('Per-deal cap'), { target: { value: '600.00' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save settings' })); });
    expect(await screen.findByText('Couldn’t save settings. Your changes are still here. Try again.')).toBeTruthy();
    expect((screen.getByLabelText('Per-deal cap') as HTMLInputElement).value).toBe('600.00');
  });
});

// ---------------------------------------------------------------- portfolio

describe('Portfolio', () => {
  it('counts and labels only the photos the public page shows', async () => {
    const photo = { num: '01', src: '/portfolio/imani/01.jpg', alt: 'Overhead view of a desk', width: 1200, height: 800, orientation: 'landscape', blurDataUrl: 'data:image/jpeg;base64,AA' };
    routes = () => ok({ creatorSlug: 'imani', publicPath: '/c/imani', assets: [
      { id: '1', title: 'Morning Pour', isPublic: true, onPublicPage: false, createdAt: iso, photo: null },
      { id: '2', title: 'Studio Portrait', isPublic: false, onPublicPage: false, createdAt: iso, photo: null },
      { id: '3', title: 'Laptop and Coffee Cup', isPublic: true, onPublicPage: true, createdAt: iso, photo },
    ] });
    render(<PortfolioPage />);
    expect(await screen.findByText('Laptop and Coffee Cup')).toBeTruthy();
    expect(screen.getByAltText('Overhead view of a desk').getAttribute('src')).toBe('/portfolio/imani/01.jpg');
    expect(screen.getAllByText('Shown on public portfolio')).toHaveLength(1);
    expect(screen.getByText('Public, not on the page (no portfolio photo)')).toBeTruthy();
    expect(screen.getByText('Private')).toBeTruthy();
    expect(screen.getByText('1').closest('p')!.textContent).toContain('1 of your 3 photos are shown at /c/imani');
    expect(screen.getByRole('link', { name: 'View portfolio' }).getAttribute('href')).toBe('/c/imani');
    // Batch 12: upload has no handler, so no placeholder for it either.
    expect(screen.queryByText(/Add photos|isn’t available in this build/)).toBeNull();
    expect(screen.queryByText(/watermarked/)).toBeNull();
  });
});

// ---------------------------------------------------------------- login

describe('Login', () => {
  it('names a wrong token without mentioning environment variables, and recovers from a network error', async () => {
    let mode: 'wrong' | 'down' = 'wrong';
    routes = () => { if (mode === 'down') throw new TypeError('Failed to fetch'); return ok({ error: 'wrong token' }, 401); };
    render(<LoginPage />);
    const field = await screen.findByLabelText('Creator token');
    fireEvent.change(field, { target: { value: 'nope' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Sign in' })); });
    expect(await screen.findByText('That creator token wasn’t recognised. Check it and try again.')).toBeTruthy();
    expect(screen.queryByText(/CREATOR_TOKEN/)).toBeNull();
    expect(field.getAttribute('aria-describedby')).toBe('login-error');
    mode = 'down';
    fireEvent.change(field, { target: { value: 'nope2' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Sign in' })); });
    expect(await screen.findByText('Couldn’t sign in. Check your connection and try again.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Sign in' }) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('B9 9.4: Needs you', () => {
  it('lists the oldest first with its waiting age; All stays newest first with no age', async () => {
    const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
    const rows = [
      deal({ briefId: 'new', client: { id: 'n', name: 'Newest Client' }, status: 'needs_creator', createdAt: hoursAgo(3) as unknown as Date }),
      deal({ briefId: 'mid', client: { id: 'm', name: 'Middle Client' }, status: 'invoiced', createdAt: hoursAgo(30) as unknown as Date }),
      deal({ briefId: 'old', client: { id: 'o', name: 'Oldest Client' }, status: 'needs_approval', createdAt: hoursAgo(75) as unknown as Date }),
    ];
    routes = () => ok({ deals: rows });
    render(<DealsPage />);
    await screen.findByText('Newest Client');
    const names = () => screen.getAllByRole('link').map((l) => l.textContent).filter((t) => /Client$/.test(t ?? ''));
    expect(names()).toEqual(['Newest Client', 'Middle Client', 'Oldest Client']);
    expect(screen.queryByText(/^Waiting /)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^Needs you/ }));
    expect(names()).toEqual(['Oldest Client', 'Newest Client']);
    expect(screen.getByText('Waiting 3 days')).toBeTruthy();
    expect(screen.getByText('Waiting 3 hours')).toBeTruthy();
  });
});
