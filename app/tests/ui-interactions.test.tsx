// @vitest-environment jsdom
// review re-check 5 (batch-5 review 2, 3, 4): the real client pages, rendered in jsdom with fetch stubbed.
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Suspense } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BriefView } from '../lib/briefs';
import type { AskItem } from '../lib/ledger';

// Next's useRouter returns the same object every render; the pages' effects depend on that.
const router = { replace: vi.fn(), push: vi.fn(), refresh: vi.fn() };
vi.mock('next/navigation', () => ({ useRouter: () => router }));

const { default: DealRoomPage } = await import('@/app/(creator)/deals/[briefId]/page');
const { default: AskPage } = await import('@/app/(creator)/ask/page');

const iso = '2026-10-29T12:00:00.000Z';
const BRIEF = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function dealView(over: Partial<BriefView> & { status: BriefView['status'] }): BriefView {
  return {
    brief: { id: BRIEF, creator_id: 'c', client_id: 'cl', asset_id: 'a', source: 'paste', raw: 'x', claimed_sender: null, state: 'extracted', created_at: iso as unknown as Date, hasImage: false, rejected_at: null },
    reasons: [], notes: [],
    client: { id: 'cl', name: 'Northwind Coffee', email: 'buying@northwind.example', allowed: true },
    asset: { id: 'a', title: 'Morning Pour' },
    transcript: { id: 't', lines: [{ speaker: 'client', text: 'We would like the photo for print too.' }], confirmed_at: iso as unknown as Date, created_at: iso as unknown as Date },
    extraction: null, checks: null, licence: null, cardSource: null, gapPreview: null, version: null, editable: false, webhookLastReceivedAt: null,
    ...over,
  } as BriefView;
}
const version = (sendState: 'sending' | 'sent' | 'failed', invoice: boolean): BriefView['version'] => ({
  id: 'v', versionNo: 2, status: 'pending', totalCents: 42000, scope: { channels: ['social', 'print'], territory: 'US', durationMonths: 6, exclusive: false },
  contentHash: 'h', sendState, sendError: sendState === 'failed' ? 'PayPal refused the invoice (INTERNAL_SERVER_ERROR).' : null, policy: null,
  extractionId: 'x', rejectedAt: null, createdAt: iso as unknown as Date,
  invoice: invoice ? { invoiceNumber: 'UR-0123456789abcdef012345', paypalInvoiceId: 'INV2-TEST-0001', state: 'sent', payerUrl: 'https://www.sandbox.paypal.com/invoice/p/#INV2-TEST-0001', sentAt: iso as unknown as Date, payPath: '/pay/tok', payUrl: 'https://useright.example/pay/tok', lastCheckedAt: null, demo: false } : null,
});

type Route = (url: string, init?: RequestInit) => Response | Promise<Response>;
let routes: Route;
const calls: string[] = [];
const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  calls.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    if (url === '/api/options') return ok({ clients: [], assets: [], optionIds: [] });
    return routes(url, init);
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const renderDeal = () => act(async () => { render(<Suspense fallback={<p>suspended</p>}><DealRoomPage params={Promise.resolve({ briefId: BRIEF })} /></Suspense>); });
const briefGets = () => calls.filter((c) => c === `GET /api/briefs/${BRIEF}`).length;
const sleep = (ms: number) => act(() => new Promise((r) => setTimeout(r, ms)));

describe('deal room (review 2, 3; re-check 4)', () => {
  it('review 2: a page opened while sending refreshes itself, then stops polling at the terminal state', async () => {
    let n = 0;
    routes = (url) => {
      if (url === `/api/briefs/${BRIEF}`) return ok(++n < 2 ? dealView({ status: 'sending', version: version('sending', false) }) : dealView({ status: 'invoiced', version: version('sent', true) }));
      throw new Error(`unexpected ${url}`);
    };
    await renderDeal();
    expect(await screen.findByText(/Sending the invoice to PayPal now/)).toBeTruthy();
    expect(await screen.findByText(/The scope and recipient are locked/, undefined, { timeout: 4000 })).toBeTruthy();
    const after = briefGets();
    await sleep(2500);
    expect(briefGets()).toBe(after);
  });

  it('review 3: a rejected Retry request shows an error, re-enables the button and re-reads the deal', async () => {
    routes = (url) => {
      if (url === `/api/briefs/${BRIEF}`) return ok(dealView({ status: 'failed', reasons: ['send_failed'], version: version('failed', false) }));
      if (url.endsWith('/decide')) throw new TypeError('Failed to fetch');
      throw new Error(`unexpected ${url}`);
    };
    await renderDeal();
    const retry = await screen.findByRole('button', { name: 'Retry' });
    const before = briefGets();
    fireEvent.click(retry);
    expect(await screen.findByText(/Could not reach the server/)).toBeTruthy();
    await waitFor(() => expect((screen.getByRole('button', { name: 'Retry' }) as HTMLButtonElement).disabled).toBe(false));
    expect(briefGets()).toBeGreaterThan(before);
  });

  it('re-check 4: a rejected confirmation-link request shows an error and leaves the button usable', async () => {
    routes = (url) => {
      if (url === `/api/briefs/${BRIEF}`) {
        return ok(dealView({
          status: 'awaiting_verification', reasons: ['awaiting_verification'],
          brief: { ...dealView({ status: 'awaiting_verification' }).brief, state: 'awaiting_verification', client_id: null },
          client: null, transcript: null,
        }));
      }
      if (url.endsWith('/verify-link')) throw new TypeError('Failed to fetch');
      throw new Error(`unexpected ${url}`);
    };
    await renderDeal();
    const get = await screen.findByRole('button', { name: 'Get the confirmation link' });
    fireEvent.click(get);
    expect(await screen.findByText(/Could not reach the server\. Check your connection, then get the link again\./)).toBeTruthy();
    await waitFor(() => expect((screen.getByRole('button', { name: 'Get the confirmation link' }) as HTMLButtonElement).disabled).toBe(false));
  });
});

const askItem: AskItem = {
  briefId: BRIEF, versionId: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff', versionNo: 1,
  client: { name: 'Northwind Coffee', email: 'buying@northwind.example' }, asset: { title: 'Morning Pour' },
  scope: 'Billboard, US, 6 mo', totalCents: 90000,
  failing: [{ rule: 'R2', code: 'over_deal_cap:90000:50000', message: '$900.00 exceeds your $500.00 per-deal cap.' }],
  hardBlock: false, sendError: null, createdAt: iso as unknown as Date,
};

describe('Ask me (review 3, 4)', () => {
  it('review 4: the approval proof (invoice id, Open deal, payer link) stays after reloads until Dismiss', async () => {
    const other: AskItem = { ...askItem, versionId: 'cccccccc-dddd-4eee-8fff-000000000000', asset: { title: 'Harbor Light' } };
    let queue: AskItem[] = [askItem, other];
    routes = (url, init) => {
      if ((init?.method ?? 'GET') === 'GET') return ok({ items: queue, alerts: [] });
      const body = JSON.parse(String(init!.body)) as { versionId: string; action: string };
      if (body.action === 'approve') {
        queue = [other];
        return ok({ ok: true, briefId: BRIEF, invoiceNumber: 'UR-0123456789abcdef012345', paypalInvoiceId: 'INV2-TEST-0009', payerUrl: 'https://www.sandbox.paypal.com/invoice/p/#INV2-TEST-0009' });
      }
      return ok({ error: 'this quote changed since you opened it; refresh to see the current one', code: 'stale' }, 409);
    };
    render(<AskPage />);
    fireEvent.change((await screen.findAllByLabelText('Type the total to approve ($)'))[0]!, { target: { value: '900.00' } });
    fireEvent.click(screen.getAllByRole('button', { name: /^Approve and send/ })[0]!);
    expect(await screen.findByText(/Approved by you, invoice sent\. PayPal invoice INV2-TEST-0009/)).toBeTruthy();
    // A stale Reject on the other card reloads the queue (the server no longer lists the approved quote).
    const gets = calls.filter((c) => c === 'GET /api/ask').length;
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    await waitFor(() => expect(calls.filter((c) => c === 'GET /api/ask').length).toBeGreaterThan(gets));
    await sleep(1700); // the old code also dropped the card on a 1.5 s timer
    expect(screen.getByText(/INV2-TEST-0009/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open deal' }).getAttribute('href')).toBe(`/deals/${BRIEF}`);
    expect(screen.getByRole('link', { name: 'Payer link' }).getAttribute('target')).toBe('_blank');
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(screen.queryByText(/INV2-TEST-0009/)).toBeNull());
    expect(screen.getByText(/Harbor Light/)).toBeTruthy();
  });

  it('review 3: a rejected approve request shows an error, re-enables the controls and re-reads the queue', async () => {
    routes = (url, init) => {
      if ((init?.method ?? 'GET') === 'GET') return ok({ items: [askItem], alerts: [] });
      throw new TypeError('Failed to fetch');
    };
    render(<AskPage />);
    fireEvent.change(await screen.findByLabelText('Type the total to approve ($)'), { target: { value: '900' } });
    const gets = calls.filter((c) => c === 'GET /api/ask').length;
    fireEvent.click(screen.getByRole('button', { name: /^Approve and send/ }));
    expect(await screen.findByText(/Could not reach the server/)).toBeTruthy();
    await waitFor(() => {
      expect((screen.getByRole('button', { name: /^Approve and send/ }) as HTMLButtonElement).disabled).toBe(false);
      expect((screen.getByRole('button', { name: 'Reject' }) as HTMLButtonElement).disabled).toBe(false);
    });
    expect(calls.filter((c) => c === 'GET /api/ask').length).toBeGreaterThan(gets);
  });
});
