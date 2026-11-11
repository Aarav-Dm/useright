// @vitest-environment jsdom
// review B7C phase 1 findings 6 and 7, on the real pages: a failed decision keeps a next step in Ask me, and the Deals
// all-clear is qualified when the queue reached the load limit.
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEALS_LOADED_MAX } from '@/components/creator/guide';
import type { DealRow } from '../lib/deals';
import type { AskItem } from '../lib/ledger';

const router = { replace: vi.fn(), push: vi.fn(), refresh: vi.fn() };
vi.mock('next/navigation', () => ({ useRouter: () => router, usePathname: () => '/ask', useSearchParams: () => new URLSearchParams() }));

const { default: AskPage } = await import('@/app/(creator)/ask/page');
const { default: DealsPage } = await import('@/app/(creator)/deals/page');

const iso = '2026-10-29T12:00:00.000Z';
const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
type Route = (url: string, init?: RequestInit) => Response | Promise<Response>;
let routes: Route;
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => routes(url, init)));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const item: AskItem = {
  briefId: 'b1', versionId: 'v1', versionNo: 2, client: { name: 'Northwind Coffee', email: 'buying@northwind.example' }, asset: { title: 'Morning Pour' },
  scope: 'Social, billboard, US, 6 mo', totalCents: 90000, failing: [], hardBlock: false, sendError: null, createdAt: iso as unknown as Date,
};

describe('Ask me banner after a failed decision (finding 6)', () => {
  it('keeps the quote in the banner with a safe next step when the decision errors', async () => {
    routes = (url, init) => {
      if (url === '/api/ask' && (init?.method ?? 'GET') === 'GET') return ok({ items: [item], alerts: [] });
      if (url === '/api/ask') return ok({ error: 'Something broke.' }, 500);
      throw new Error(url);
    };
    render(<AskPage />);
    expect(await screen.findByText(/1 quote waits for your typed approval/)).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Reject/ })); });
    await waitFor(() => expect(screen.getByText(/1 decision did not go through or could not be confirmed\. Check before trying again/)).toBeTruthy());
    expect(screen.getByRole('link', { name: 'Check the deal' }).getAttribute('href')).toBe('/deals/b1');
  });

  it('drops the quote from the banner once the decision is done', async () => {
    let listed = true;
    routes = (url, init) => {
      if (url === '/api/ask' && (init?.method ?? 'GET') === 'GET') return ok({ items: listed ? [item] : [], alerts: [] });
      if (url === '/api/ask') { listed = false; return ok({ ok: true }); }
      throw new Error(url);
    };
    render(<AskPage />);
    await screen.findByText(/1 quote waits for your typed approval/);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Reject/ })); });
    await waitFor(() => expect(screen.queryByText(/1 quote waits for your typed approval/)).toBeNull());
    expect(screen.queryByText(/did not go through/)).toBeNull();
  });
});

describe('Deals all-clear at the load limit (finding 7)', () => {
  const deal = (i: number): DealRow => ({
    briefId: `b${i}`, client: { id: 'c', name: 'Northwind Coffee' }, asset: { id: 'a', title: 'Morning Pour' }, source: 'paste',
    status: 'paid', reasons: [], gapTotalCents: 30000, paypalInvoiceId: null, demo: false, createdAt: iso as unknown as Date,
  });

  it('says the all-clear covers only the newest deals when the limit is reached', async () => {
    routes = (url) => (url === '/api/deals' ? ok({ deals: Array.from({ length: DEALS_LOADED_MAX }, (_, i) => deal(i)) }) : ok({}, 404));
    render(<DealsPage />);
    expect(await screen.findByText(`Nothing needs you in your newest ${DEALS_LOADED_MAX} deals. These counts cover your newest ${DEALS_LOADED_MAX} deals only; older deals are not loaded here.`)).toBeTruthy();
    expect(screen.queryByText('Nothing needs you right now.')).toBeNull();
  });

  it('keeps the plain all-clear below the limit', async () => {
    routes = (url) => (url === '/api/deals' ? ok({ deals: [deal(1)] }) : ok({}, 404));
    render(<DealsPage />);
    expect(await screen.findByText('Nothing needs you right now.')).toBeTruthy();
  });
});
