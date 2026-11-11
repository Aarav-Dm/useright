// @vitest-environment jsdom
// Batch 7C phase 2: overview, explanations, deal progress and filters, plain-word rules, ledger totals and receipts,
// portfolio counts, settings calculator.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DealProgress, flowStepFor, HowItWorks, progressFor, ruleInPlainWords, StatusTip, TermTip } from '@/components/creator/explain';
import { PriceCalculator } from '@/components/creator/price-calculator';
import type { DealRow } from '../lib/deals';
import type { LedgerRow } from '../lib/ledger';
import type { Overview } from '../lib/overview';
import { waitingCounts } from '../lib/overview';
import type { SettingsView } from '../lib/settings';

const router = { replace: vi.fn(), push: vi.fn(), refresh: vi.fn() };
vi.mock('next/navigation', () => ({ useRouter: () => router, usePathname: () => '/deals', useSearchParams: () => new URLSearchParams() }));

const { default: OverviewPage } = await import('@/app/(creator)/overview/page');
const { default: DealsPage } = await import('@/app/(creator)/deals/page');
const { default: LedgerPage } = await import('@/app/(creator)/ledger/page');
const { default: AskPage } = await import('@/app/(creator)/ask/page');

const iso = '2026-10-29T12:00:00.000Z';
type Route = (url: string, init?: RequestInit) => Response | Promise<Response>;
let routes: Route;
const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => routes(url, init)));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const deal = (over: Partial<DealRow>): DealRow => ({
  briefId: 'b', client: { id: 'c', name: 'Northwind Coffee' }, asset: { id: 'a', title: 'Morning Pour' }, source: 'paste',
  status: 'ready', reasons: [], gapTotalCents: 30000, paypalInvoiceId: null, demo: false, createdAt: iso as unknown as Date, ...over,
});
const lrow = (over: Partial<LedgerRow>): LedgerRow => ({
  eventId: 'e', kind: 'rule', createdAt: iso as unknown as Date, briefId: 'b', deal: 'Northwind Coffee · Morning Pour', versionId: 'v', versionNo: 1,
  scope: 'Social, US, 6 mo', rule: 'R1', result: 'pass', message: 'The client is on your allowed list.', paypalInvoiceId: null,
  invoiceNumber: null, paypalTxnId: null, amountCents: null, label: 'Rule', status: 'pending', expiry: null, renewalDate: null, demo: false, ...over,
});
const money = (liveCents: number, liveCount: number, demoCents = 0, demoCount = 0) => ({ liveCents, liveCount, demoCents, demoCount });
const overview: Overview = {
  totals: { earned: money(42000, 1, 40000, 1), pending: money(0, 0, 40000, 1), refunded: money(0, 0, 30000, 1), revokedKept: money(0, 0) },
  headline: { caught: 2, caughtDemo: 3, invoicedCents: 42000, recoveredCents: 42000 },
  waiting: { approvals: 1, blocked: 0, blockedBriefId: null, checks: 0, failed: 0 },
  alertsShown: 0,
  partlyRefunded: 0,
  unpaid: [deal({ briefId: 'u', status: 'invoiced', gapTotalCents: 40000, demo: true, asset: { id: 'g', title: 'Vineyard Harvest' } })],
  ask: [{ briefId: 'a', versionId: 'v2', versionNo: 2, client: { name: 'Northwind Coffee', email: 'b@x.example' }, asset: { title: 'Morning Pour' }, scope: 's', totalCents: 90000, failing: [], hardBlock: false, sendError: null, createdAt: iso as unknown as Date }],
  alerts: [],
  recent: [lrow({ eventId: 'r1' })],
  receipts: { vg: { grant: 'RECEIPTPUBLICIDRECEIPTPUBLICIDRECEIPTPUBL' } },
};

describe('Overview', () => {
  it('shows PayPal-verified totals with seeded demo money on its own line, what waits, unpaid and next steps', async () => {
    routes = () => ok(overview);
    render(<OverviewPage />);
    const totals = await screen.findByLabelText('Totals');
    expect(within(totals).getByText('$420.00')).toBeTruthy();
    // Batch 12: seeded money is off the cards and in no total. B16: it has its own labelled dashed strip.
    expect(totals.textContent).not.toMatch(/seeded/i);
    const seeded = screen.getByRole('region', { name: 'Seeded demo money' });
    expect(seeded.textContent).toContain('Seeded for the demo, not PayPal money and not in these totals');
    expect(seeded.textContent).toMatch(/\$400\.00 earned \(1\).*\$400\.00 waiting \(1\).*\$300\.00 refunded \(1\)/);
    expect(screen.getByRole('link', { name: '1 quote waits for your typed approval' }).getAttribute('href')).toBe('/ask');
    expect(screen.getByRole('link', { name: 'Northwind Coffee · Vineyard Harvest' })).toBeTruthy();
    expect(screen.getByText('1 quote waits for your typed approval: $900.00')).toBeTruthy();
    expect(screen.getByRole('link', { name: /^Review/ }).getAttribute('href')).toBe('/ask#quote-v2');
    // review B7C-1 finding 4, on the Overview too: the seeded unpaid invoice is labelled Demo, never a live invoice out.
    expect(screen.getByText('Demo: 1 seeded invoice is shown as unpaid: $400.00. PayPal never saw it')).toBeTruthy();
    expect(document.body.textContent).not.toContain('out, waiting for the client to pay');
    // B12 E6: the headline, and a rule row in plain words.
    expect(screen.getByRole('heading', { name: 'Caught beyond the licence' })).toBeTruthy();
    expect(screen.getByText('Requests the agent found outside the current licence.')).toBeTruthy();
    expect(screen.getByText('Passed')).toBeTruthy();
    expect(screen.getByText('The client is on your allowed list.')).toBeTruthy();
    expect(document.body.textContent).not.toContain('R1 passed');
  });

  it('B12 E6: with no PayPal money yet, one line replaces the three $0.00 cards', async () => {
    routes = () => ok({ ...overview, totals: { ...overview.totals, earned: money(0, 0, 40000, 1) }, headline: { ...overview.headline, invoicedCents: 0, recoveredCents: 0 } });
    render(<OverviewPage />);
    expect(await screen.findByText(/No PayPal money yet/)).toBeTruthy();
    expect(screen.queryByLabelText('Totals')).toBeNull();
    expect(screen.getByText(/Seeded for the demo, not PayPal money/)).toBeTruthy();
  });

  it('review B7C-2 findings 1 and 8: alerts are not "waiting", and money kept on a cascaded revoke is noted under Earned', async () => {
    routes = () => ok({ ...overview, alertsShown: 1, totals: { ...overview.totals, revokedKept: money(60000, 1) } });
    render(<OverviewPage />);
    const totals = await screen.findByLabelText('Totals');
    expect(within(totals).getByText('Includes $600.00 (1) on licences revoked because an earlier licence they built on was refunded. That money was not paid back.')).toBeTruthy();
    expect(screen.getByText(/Payment alerts \(last 20\): 1\./)).toBeTruthy();
    expect(screen.queryByText(/payment problem needs you/)).toBeNull();
  });

  it('review B7C-2 finding 2: a hard-blocked quote shows as waiting with a deal link, a failed send counts once', async () => {
    expect(waitingCounts(
      [deal({ briefId: 'f', status: 'failed' }), deal({ briefId: 'h', status: 'needs_approval' })],
      [
        { briefId: 'h', hardBlock: true, sendError: null },
        { briefId: 'f', hardBlock: false, sendError: 'PayPal did not answer' },
      ],
    )).toEqual({ approvals: 0, blocked: 1, blockedBriefId: 'h', checks: 0, failed: 1 });
    routes = () => ok({ ...overview, ask: [], waiting: { approvals: 0, blocked: 1, blockedBriefId: 'h', checks: 0, failed: 0 } });
    render(<OverviewPage />);
    const link = await screen.findByRole('link', { name: '1 quote needs a change in the deal before it can be approved' });
    expect(link.getAttribute('href')).toBe('/deals/h');
    const waiting = screen.getByRole('region', { name: /Waiting for you/ });
    expect(within(waiting).queryByText('Nothing needs you right now.')).toBeNull();
  });
});

describe('explanations', () => {
  it('a term tip and a status tip open on click with fixed text', () => {
    render(<><TermTip term="rules" /><StatusTip status="needs_approval" /></>);
    fireEvent.click(screen.getByRole('button', { name: 'What is rules r1 to r5?' }));
    expect(screen.getByText(/R2: the price is within your per-deal cap\./)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'What “Needs your approval” means' }));
    expect(screen.getByText('Type the exact total in Ask me to send it, or reject it. If PayPal cannot take it (under $1.00, no client email), fix the deal instead.')).toBeTruthy();
    expect(screen.getByText('Yes')).toBeTruthy();
  });

  it('a demo paid status never says PayPal confirmed it', () => {
    render(<StatusTip status="paid" demo />);
    fireEvent.click(screen.getByRole('button', { name: 'What “Paid, file unlocked” means' }));
    expect(screen.getByText('Seeded as paid for the walkthrough. This is not a PayPal payment.')).toBeTruthy();
    expect(screen.queryByText(/PayPal confirmed/)).toBeNull();
  });

  it('review B7C-2 finding 3: a demo "Invoice sent" tip never says PayPal has the invoice', () => {
    render(<StatusTip status="invoiced" demo />);
    fireEvent.click(screen.getByRole('button', { name: /What “Invoice sent” means/ }));
    expect(screen.getByText('Seeded as sent for the walkthrough. PayPal never saw it and no client will pay it.')).toBeTruthy();
    expect(screen.queryByText(/PayPal has the invoice/)).toBeNull();
  });

  it('review B7C-2 finding 10: tips sit on an opaque base, not see-through glass', () => {
    render(<TermTip term="ledger" />);
    fireEvent.click(screen.getByRole('button', { name: 'What is ledger?' }));
    const content = document.querySelector('[data-slot="popover-content"]')!;
    expect(content.className).toContain('bg-popover');
    expect(content.className).not.toContain('dash-glass');
  });

  it('review B7C-2 finding 11: a refunded deal never reads as Paid to a screen reader', () => {
    render(<><DealProgress status="refunded" /><DealProgress status="cancelled" /></>);
    expect(screen.getByRole('img', { name: 'Progress: refunded after payment' })).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Progress: cancelled, nothing will be paid' })).toBeTruthy();
  });

  it('review B7C-2 finding 6: a hard-blocked quote tip never asks for a typed total; sending says to check if it stalls', () => {
    render(<><StatusTip status="needs_approval" hardBlock /><StatusTip status="sending" /></>);
    fireEvent.click(screen.getByRole('button', { name: 'What “Needs your approval” means' }));
    expect(screen.getByText('Open the deal and fix what the rules list; typing the total cannot send it.')).toBeTruthy();
    expect(screen.queryByText(/Type the exact total/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /What “Sending/ }));
    expect(screen.getByText(/If it does not change, open the deal and check before doing anything else\./)).toBeTruthy();
  });

  it('progress and the how-it-works step follow the server status', () => {
    expect([progressFor('awaiting_transcript'), progressFor('needs_approval'), progressFor('invoiced'), progressFor('paid')]).toEqual([1, 2, 4, 6]);
    expect([flowStepFor('ready'), flowStepFor('needs_approval'), flowStepFor('invoiced'), flowStepFor('rejected')]).toEqual([1, 2, 3, null]);
    render(<><DealProgress status="invoiced" /><HowItWorks current={3} /></>);
    expect(screen.getByRole('img', { name: 'Progress: 4 of 6, Invoiced' })).toBeTruthy();
    expect(screen.getByText('Client pays with PayPal').closest('li')!.getAttribute('aria-current')).toBe('step');
  });

  it('a stopped rule in plain words uses the amounts the server wrote into the code', () => {
    expect(ruleInPlainWords('over_deal_cap:90000:50000', 'Northwind')).toBe('This quote is $900.00; your per-deal cap is $500.00 (Settings, Autopilot limits).');
    expect(ruleInPlainWords('needs_approval:billboard', 'Northwind')).toBe('Billboard is not set to “Agent sells on its own” (Settings, What the agent may sell).');
    expect(ruleInPlainWords('rolling_cap_reached:160000:150000', 'Northwind')).toBe('With this quote Northwind would reach $1,600.00 in 30 days; your 30-day cap is $1,500.00.');
  });
});

describe('Deals filters', () => {
  it('summary cards count each view, filter the rows and mark rows that need you', async () => {
    routes = () => ok({ deals: [deal({ briefId: '1', status: 'needs_approval' }), deal({ briefId: '2', status: 'invoiced', client: { id: 'p', name: 'Pinecrest Hotels' } }), deal({ briefId: '3', status: 'paid', client: { id: 'q', name: 'Quayside Press' } })] });
    render(<DealsPage />);
    const needs = await screen.findByRole('button', { name: 'Needs you 1' });
    expect(screen.getByRole('button', { name: 'All 3' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'In progress 1' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Done 1' })).toBeTruthy();
    expect(document.querySelectorAll('tr[data-needs-you]')).toHaveLength(1);
    fireEvent.click(needs);
    expect(screen.queryByText('Pinecrest Hotels')).toBeNull();
    expect(screen.getByText('Northwind Coffee')).toBeTruthy();
  });
});

describe('Ask me plain words', () => {
  it('review B7C-2 finding 4: the nav badge and the mobile Menu count only quotes waiting for typed approval', async () => {
    const { CreatorNav, MobileNav } = await import('@/components/creator/nav');
    const item = (versionId: string, hardBlock: boolean) => ({ ...overview.ask[0]!, versionId, hardBlock });
    routes = (url) => (url === '/api/ask' ? ok({ items: [item('a', false), item('b', true)], alerts: [] }) : ok({}, 404));
    render(<><CreatorNav /><MobileNav /></>);
    expect(await screen.findByText(/waiting in Ask me/)).toBeTruthy();
    await waitFor(() => expect(document.body.textContent).toContain('1 waiting'));
    expect(document.body.textContent).not.toMatch(/2 waiting/);
  });

  it('shows each stopped rule against its limit', async () => {
    routes = () => ok({ items: [{ ...overview.ask[0]!, failing: [{ rule: 'R2', code: 'over_deal_cap:90000:50000', message: '$900.00 exceeds your $500.00 per-deal cap.' }] }], alerts: [] });
    render(<AskPage />);
    expect(await screen.findByText('This quote is $900.00; your per-deal cap is $500.00 (Settings, Autopilot limits).')).toBeTruthy();
  });
});

describe('Ledger additions', () => {
  it('server totals at the top, kind chips, a plain sentence and a receipt link', async () => {
    routes = (url) => {
      if (url === '/api/overview') return ok(overview);
      return ok({ rows: [
        lrow({ eventId: 'r1' }),
        lrow({ eventId: 'g', kind: 'grant', rule: null, label: 'Granted', versionId: 'vg', paypalTxnId: 'CAP0001', amountCents: 42000, status: 'paid' }),
      ] });
    };
    render(<LedgerPage />);
    const totals = await screen.findByLabelText('Totals');
    expect(within(totals).getByText('Earned (PayPal-verified)')).toBeTruthy();
    expect(within(totals).getAllByText('plus $400.00 seeded demo (1)')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Payments 1' })).toBeTruthy();
    expect(screen.getByText('PayPal confirmed the payment; the file was unlocked.')).toBeTruthy();
    expect(screen.getByRole('link', { name: /^Open receipt/ }).getAttribute('href')).toBe(`/r/${overview.receipts.vg!.grant}`);
    fireEvent.click(screen.getByRole('button', { name: 'Rules 1' }));
    expect(screen.getByText('1 of 2 events')).toBeTruthy();
  });

  it('works without the overview response', async () => {
    routes = (url) => { if (url === '/api/overview') throw new TypeError('Failed to fetch'); return ok({ rows: [lrow({})] }); };
    render(<LedgerPage />);
    expect(await screen.findByText('1 of 1 events')).toBeTruthy();
    expect(screen.queryByLabelText('Totals')).toBeNull();
  });

  it('review B7C-2 finding 6 / review finding 3: a grant row opens the grant receipt, a revoke row the revocation receipt, a failed grant none', async () => {
    const receipts = { vg: { grant: 'G'.repeat(43), revocation: 'R'.repeat(43) } };
    routes = (url) => {
      if (url === '/api/overview') return ok({ ...overview, receipts });
      return ok({ rows: [
        lrow({ eventId: 'rv', kind: 'revoked', rule: null, label: 'Revoked', result: 'fail', versionId: 'vg', amountCents: 42000, status: 'refunded', message: 'Payment refunded in PayPal; licence revoked and downloads stopped.' }),
        lrow({ eventId: 'ok', kind: 'grant', rule: null, label: 'Granted', result: 'pass', versionId: 'vg', amountCents: 42000 }),
        lrow({ eventId: 'no', kind: 'grant', rule: null, label: 'Payment not verified', result: 'fail', versionId: 'vg' }),
      ] });
    };
    render(<LedgerPage />);
    await screen.findByLabelText('Totals');
    const revocation = screen.getAllByRole('link', { name: /^Open revocation receipt/ });
    expect(revocation.map((a) => a.getAttribute('href'))).toEqual([`/r/${receipts.vg.revocation}`]);
    const grant = screen.getAllByRole('link', { name: /^Open receipt/ });
    expect(grant.map((a) => a.getAttribute('href'))).toEqual([`/r/${receipts.vg.grant}`]); // not on the failed grant
  });

  it('review B7C-2 finding 5: Earned notes payments partly refunded in PayPal', async () => {
    routes = (url) => (url === '/api/overview' ? ok({ ...overview, partlyRefunded: 2 }) : ok({ rows: [lrow({})] }));
    render(<LedgerPage />);
    const totals = await screen.findByLabelText('Totals');
    expect(within(totals).getByText('includes 2 payments partly refunded in PayPal (the refunded part is not taken off)')).toBeTruthy();
  });
});

describe('Settings calculator', () => {
  const settings = {
    rateCard: { social: 15000, web: 10000, print: 42000, billboard: 90000, OOH: 90000, TV: 150000, US: 0, NA: 10000, WORLD: 30000, '6mo': 15000, '12mo': 30000 },
    perDealCapCents: 50000, rolling30CapCents: 150000, dailyMaxSends: 10, timezone: 'America/New_York',
    autoChannels: ['social', 'web', 'print'], askChannels: ['billboard', 'exclusive'], allowedClientIds: [], clients: [],
  } as SettingsView;

  it('prices with the saved card and says what the rules would do', async () => {
    render(<PriceCalculator settings={settings} />);
    expect(screen.getByText('$300.00')).toBeTruthy();
    expect(screen.getByText(/the agent may send a \$300\.00 invoice on its own/)).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole('checkbox', { name: 'Billboard' })); });
    expect(screen.getByText('$1,200.00')).toBeTruthy();
    expect(screen.getByText('With these rules a $1,200.00 request would need your approval: it is over your $500.00 per-deal cap, and Billboard is not set to “Agent sells on its own”.')).toBeTruthy();
  });
});

await waitFor(() => true);
