// @vitest-environment jsdom
// Batch-6 review F14, F17, F20, F22: the real client components in jsdom with fetch stubbed.
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Suspense } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PayClient } from '@/components/client/pay-client';
import type { BriefView } from '../lib/briefs';
import type { LedgerRow } from '../lib/ledger';
import type { PayView } from '../lib/pay';

const router = { replace: vi.fn(), push: vi.fn(), refresh: vi.fn() };
vi.mock('next/navigation', () => ({ useRouter: () => router }));

const { default: DealRoomPage } = await import('@/app/(creator)/deals/[briefId]/page');
const { default: LedgerPage } = await import('@/app/(creator)/ledger/page');

const iso = '2026-10-29T12:00:00.000Z';
const BRIEF = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

type Route = (url: string, init?: RequestInit) => Response | Promise<Response>;
let routes: Route;
const calls: string[] = [];
const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const sleep = (ms: number) => act(() => new Promise((r) => setTimeout(r, ms)));
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

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

// ---------------------------------------------------------------- pay page (F14, F20)

const payView = (status: PayView['status'], over: Partial<PayView> = {}): PayView => ({
  creatorName: 'Imani', assetTitle: 'Morning Pour', scope: 'Social, Print, US, 6 mo', versionNo: 2, totalCents: 42000, currency: 'USD',
  status, rail: 'invoice', payerUrl: status === 'unpaid' ? 'https://www.sandbox.paypal.com/invoice/p/#INV2-1' : null,
  verified: status === 'paid' ? { paypalTransactionId: 'CAP00000000000042', amountCents: 42000, paidAt: iso } : null,
  refusal: null, fileLabel: 'Print-resolution file', receiptPath: status === 'paid' ? '/r/receipt' : null,
  term: { startAt: null, endAt: null }, previewPath: '/api/pay/tok/preview', ...over,
});
const isGet = (url: string, init?: RequestInit, token = 'tok') => url === `/api/pay/${token}` && (init?.method ?? 'GET') === 'GET';
const isCheck = (url: string, token = 'tok') => url === `/api/pay/${token}/check`;

describe('pay page (F14, F20)', () => {
  it('F14: a slow unpaid poll that resolves after a verified check does not overwrite it', async () => {
    let gets = 0;
    const slow = deferred<Response>();
    let checks = 0;
    routes = (url, init) => {
      if (isGet(url, init)) return ++gets === 2 ? slow.promise : ok(payView('unpaid'));
      if (isCheck(url)) return ok({ checked: true, view: ++checks === 1 ? payView('unpaid') : payView('paid') });
      throw new Error(`unexpected ${url}`);
    };
    render(<PayClient token="tok" />);
    expect(await screen.findByRole('button', { name: /check now/ })).toBeTruthy();
    await sleep(3200); // the 3 s poll fires: GET #2 is now in flight
    await waitFor(() => expect(gets).toBe(2));
    fireEvent.click(screen.getByRole('button', { name: /check now/ }));
    expect(await screen.findByText(/Verified with PayPal\./)).toBeTruthy();
    await act(async () => { slow.resolve(ok(payView('unpaid'))); await slow.promise; });
    await sleep(50);
    expect(screen.getByText(/Verified with PayPal\./)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /check now/ })).toBeNull();
  }, 15_000);

  it('F14: a genuine later refund still replaces the paid view', async () => {
    let checks = 0;
    routes = (url, init) => {
      if (isGet(url, init)) return ok(payView('paid'));
      if (isCheck(url)) return ok({ checked: true, view: ++checks === 1 ? payView('paid') : payView('refunded') });
      throw new Error(`unexpected ${url}`);
    };
    render(<PayClient token="tok" />);
    expect(await screen.findByText(/Verified with PayPal\./)).toBeTruthy();
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    expect(await screen.findByText(/This payment was refunded/)).toBeTruthy();
  });

  it('F14: a new token starts from fresh state and reads the new link', async () => {
    routes = (url, init) => {
      if (isGet(url, init, 'one')) return ok(payView('paid', { assetTitle: 'First photo' }));
      if (isGet(url, init, 'two')) return ok(payView('unpaid', { assetTitle: 'Second photo' }));
      if (isCheck(url, 'one')) return ok({ checked: true, view: payView('paid', { assetTitle: 'First photo' }) });
      if (isCheck(url, 'two')) return ok({ checked: true, view: payView('unpaid', { assetTitle: 'Second photo' }) });
      throw new Error(`unexpected ${url}`);
    };
    const { rerender } = render(<PayClient token="one" />);
    expect(await screen.findByRole('heading', { name: 'First photo' })).toBeTruthy();
    rerender(<PayClient token="two" />);
    expect(await screen.findByRole('heading', { name: 'Second photo' })).toBeTruthy();
    expect(screen.queryByText(/Verified with PayPal\./)).toBeNull();
    expect(calls).toContain('GET /api/pay/two');
  });

  it.each([
    [429, 'too many requests from this address; try again later'],
    [403, 'cross-origin request refused'],
  ])('F20: a %i from check shows its error with a retry, never "updates by itself"', async (status, message) => {
    routes = (url, init) => {
      if (isGet(url, init)) return ok(payView('unpaid'));
      if (isCheck(url)) return ok({ error: message }, status);
      throw new Error(`unexpected ${url}`);
    };
    render(<PayClient token="tok" />);
    expect(await screen.findByText(message)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(screen.queryByText(/updates by itself/)).toBeNull();
  });

  it('fix round 2 (review #14): a check error stays shown after the next successful poll, until a check succeeds', async () => {
    let checks = 0;
    routes = (url, init) => {
      if (isGet(url, init)) return ok(payView('unpaid'));
      if (isCheck(url)) return ++checks <= 1 ? ok({ error: 'cross-origin request refused' }, 403) : ok({ checked: true, view: payView('unpaid') });
      throw new Error(`unexpected ${url}`);
    };
    render(<PayClient token="tok" />);
    expect(await screen.findByText('cross-origin request refused')).toBeTruthy();
    await sleep(3300); // one 3 s poll succeeds meanwhile
    expect(calls.filter((c) => c === 'GET /api/pay/tok').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('cross-origin request refused')).toBeTruthy();
    expect(screen.queryByText(/updates by itself/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.queryByText('cross-origin request refused')).toBeNull());
  }, 15_000);

  it('F14 + F20: a failed poll shows an error beside the existing view; Try again recovers', async () => {
    let gets = 0;
    routes = (url, init) => {
      if (isGet(url, init)) return ++gets === 2 ? ok({}, 500) : ok(payView('unpaid'));
      if (isCheck(url)) return ok({ checked: true, view: payView('unpaid') });
      throw new Error(`unexpected ${url}`);
    };
    render(<PayClient token="tok" />);
    expect(await screen.findByRole('heading', { name: 'Morning Pour' })).toBeTruthy();
    await sleep(3200);
    expect(await screen.findByText(/Something went wrong on our side/)).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Morning Pour' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.queryByText(/Something went wrong on our side/)).toBeNull());
    expect(screen.getByText(/updates by itself/)).toBeTruthy();
  }, 15_000);
});

// ---------------------------------------------------------------- deal room (F14 Re-check outcomes, F17 link)

function dealView(status: BriefView['status']): BriefView {
  return {
    brief: { id: BRIEF, creator_id: 'c', client_id: 'cl', asset_id: 'a', source: 'paste', raw: 'x', claimed_sender: null, state: 'extracted', created_at: iso as unknown as Date, hasImage: false, rejected_at: null },
    reasons: [], notes: [], status,
    client: { id: 'cl', name: 'Northwind Coffee', email: 'buying@northwind.example', allowed: true },
    asset: { id: 'a', title: 'Morning Pour' },
    transcript: { id: 't', lines: [{ speaker: 'client', text: 'Print too, please.' }], confirmed_at: iso as unknown as Date, created_at: iso as unknown as Date },
    extraction: null, checks: null, licence: null, cardSource: null, gapPreview: null, editable: false, webhookLastReceivedAt: null,
    version: {
      id: 'v', versionNo: 2, status: status === 'paid' ? 'active' : 'pending', totalCents: 42000, scope: { channels: ['social', 'print'], territory: 'US', durationMonths: 6, exclusive: false },
      contentHash: 'h', sendState: 'sent', sendError: null, policy: null, extractionId: 'x', rejectedAt: null, createdAt: iso as unknown as Date,
      invoice: { invoiceNumber: 'UR-0123456789abcdef012345', paypalInvoiceId: 'INV2-TEST-0001', state: status === 'paid' ? 'paid' : 'sent', payerUrl: 'https://www.sandbox.paypal.com/invoice/p/#INV2-TEST-0001', sentAt: iso as unknown as Date, payPath: '/pay/oldtok', payUrl: 'https://useright.example/pay/oldtok', lastCheckedAt: null, demo: false },
    },
  } as BriefView;
}
const renderDeal = () => act(async () => { render(<Suspense fallback={<p>suspended</p>}><DealRoomPage params={Promise.resolve({ briefId: BRIEF })} /></Suspense>); });
const decides = () => calls.filter((c) => c === `POST /api/briefs/${BRIEF}/decide`).length;

describe('deal room (F14, F17)', () => {
  it.each([
    ['unavailable', 'PayPal could not be reached, so nothing was changed. Try again shortly.'],
    ['unchanged', 'Checked with PayPal: the payment is still in place. Nothing changed.'],
    ['granted', 'PayPal confirmed the payment. The file is unlocked and a rights receipt was issued.'],
    ['revoked', 'PayPal shows the payment was refunded or reversed. The licence is revoked and downloads are stopped.'],
  ])('F14: Re-check PayPal shows the %s outcome', async (outcome, message) => {
    routes = (url) => {
      if (url === `/api/briefs/${BRIEF}`) return ok(dealView('paid'));
      if (url.endsWith('/decide')) return ok({ ok: true, recheck: { checked: true, outcome, message }, view: dealView('paid') });
      throw new Error(`unexpected ${url}`);
    };
    await renderDeal();
    fireEvent.click(await screen.findByRole('button', { name: 'Re-check PayPal' }));
    expect(await screen.findByText(message)).toBeTruthy();
    expect(screen.queryByText('Checked with PayPal.')).toBeNull();
    const shown = screen.getByText(message);
    expect(shown.getAttribute('role')).toBe(outcome === 'unavailable' ? 'alert' : 'status');
  });

  it('F17: Keep current link changes nothing; Replace link runs once and shows the replacement', async () => {
    let rotated = false;
    const pending = deferred<Response>();
    routes = (url, init) => {
      if (url === `/api/briefs/${BRIEF}`) return ok(rotated ? { ...dealView('invoiced'), version: { ...dealView('invoiced').version!, invoice: { ...dealView('invoiced').version!.invoice!, payPath: '/pay/newtok', payUrl: 'https://useright.example/pay/newtok' } } } : dealView('invoiced'));
      if (url.endsWith('/decide')) {
        expect(JSON.parse(String(init!.body))).toEqual({ action: 'rotate_link' });
        rotated = true;
        return pending.promise;
      }
      throw new Error(`unexpected ${url}`);
    };
    await renderDeal();
    fireEvent.click(await screen.findByRole('button', { name: 'Replace link' }));
    expect(screen.getByText(/stops working at once, and any download links issued from it stop too/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Keep current link' }));
    expect(decides()).toBe(0);
    expect(screen.getByText('https://useright.example/pay/oldtok')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Replace link' }));
    const confirm = screen.getAllByRole('button', { name: 'Replace link' }).at(-1)!;
    fireEvent.click(confirm);
    fireEvent.click(confirm); // a second click while pending does nothing
    expect(decides()).toBe(1);
    await waitFor(() => expect((screen.getByRole('button', { name: 'Re-check PayPal' }) as HTMLButtonElement).disabled).toBe(true));
    const v = dealView('invoiced');
    await act(async () => {
      pending.resolve(ok({ ok: true, payPath: '/pay/newtok', view: { ...v, version: { ...v.version!, invoice: { ...v.version!.invoice!, payPath: '/pay/newtok', payUrl: 'https://useright.example/pay/newtok' } } } }));
    });
    expect(await screen.findByText('https://useright.example/pay/newtok')).toBeTruthy();
    expect(decides()).toBe(1);
  });

  it('F17: Copy uses the public origin link and says Copied only after the clipboard accepts; a block is shown', async () => {
    routes = (url) => {
      if (url === `/api/briefs/${BRIEF}`) return ok(dealView('invoiced'));
      throw new Error(`unexpected ${url}`);
    };
    const writeText = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new DOMException('denied', 'NotAllowedError'));
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    await renderDeal();
    fireEvent.click(await screen.findByRole('button', { name: 'Copy client link' }));
    expect(await screen.findByText('Copied.')).toBeTruthy();
    expect(writeText).toHaveBeenCalledWith('https://useright.example/pay/oldtok');
    fireEvent.click(screen.getByRole('button', { name: 'Copy client link' }));
    expect(await screen.findByText(/Could not copy: the browser blocked the clipboard/)).toBeTruthy();
    expect(screen.queryByText('Copied.')).toBeNull();
  });
});

// ---------------------------------------------------------------- ledger (F22)

describe('ledger screen (F22)', () => {
  it('shows labels, PayPal transaction id and amount on grant and revoke rows', async () => {
    const row = (kind: string, label: string, result: 'pass' | 'fail'): LedgerRow => ({
      eventId: kind, kind, createdAt: iso as unknown as Date, briefId: BRIEF, deal: 'Northwind Coffee · Morning Pour', versionId: 'v', versionNo: 2,
      scope: 'Social, Print, US, 6 mo', rule: null, result, message: null, paypalInvoiceId: 'INV2-TEST-0001', invoiceNumber: 'UR-0123456789abcdef012345',
      paypalTxnId: 'CAP00000000000042', amountCents: 42000, label, status: 'paid', expiry: null, renewalDate: null, demo: false,
    });
    routes = (url) => {
      if (url === '/api/ledger') return ok({ rows: [row('grant', 'Granted', 'pass'), row('revoked', 'Revoked', 'fail')] });
      throw new Error(`unexpected ${url}`);
    };
    render(<LedgerPage />);
    expect(await screen.findByText('Granted')).toBeTruthy();
    expect(screen.getByText('Revoked')).toBeTruthy();
    expect(screen.getAllByText('CAP00000000000042')).toHaveLength(2);
    expect(screen.getAllByText('$420.00')).toHaveLength(2);
    expect(screen.getByText('PayPal')).toBeTruthy();
  });
});
