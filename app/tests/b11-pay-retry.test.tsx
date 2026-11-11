// @vitest-environment jsdom
// B11 item 6: a press inside the check window retries by itself exactly once, and stops on unmount or success.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PayClient } from '@/components/client/pay-client';
import type { PayView } from '../lib/pay';

const iso = '2026-11-05T12:00:00.000Z';
const unpaidView = { creatorName: 'Imani', assetTitle: 'Morning Pour', scope: 'Social, Print, US, 6 mo', versionNo: 2, totalCents: 42000, currency: 'USD',
  status: 'unpaid', rail: 'invoice', payerUrl: 'https://www.sandbox.paypal.com/invoice/p/#INV2-1', verified: null,
  refusal: null, fileLabel: 'Print-resolution file', receiptPath: null, term: { startAt: null, endAt: null }, previewPath: '/api/pay/tok/preview' } as unknown as PayView;
const paidView = { ...unpaidView, status: 'paid', payerUrl: null, receiptPath: '/r/receipt', verified: { paypalTransactionId: 'CAP1', amountCents: 42000, paidAt: iso } } as unknown as PayView;
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

let checks: number;
let answer: () => unknown;

beforeEach(() => {
  vi.useFakeTimers();
  checks = 0;
  answer = () => ({ view: unpaidView, throttled: true });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('/check')) { checks++; return ok(answer()); }
    return ok(unpaidView);
  }));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const tick = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
async function pressPaid() {
  await tick(10); // load: read, then the page's own check
  expect(checks).toBe(1);
  fireEvent.click(screen.getByRole('button', { name: /I.ve paid/ }));
  await tick(10);
  expect(checks).toBe(2);
}

describe('throttled "I\'ve paid, check now"', () => {
  it('the note goes when a check comes back paid (click review 3)', async () => {
    render(<PayClient token="tok" />);
    await pressPaid();
    expect(screen.getByText(/try again in a few seconds/)).toBeTruthy();
    answer = () => ({ view: paidView, throttled: false });
    await tick(11_100);
    expect(checks).toBe(3);
    expect(screen.queryByText(/try again in a few seconds/)).toBeNull();
  });

  it('re-checks once after the window, and only once', async () => {
    render(<PayClient token="tok" />);
    await pressPaid();
    await tick(10_000);
    expect(checks).toBe(2);
    await tick(1_100);
    expect(checks).toBe(3);
    await tick(60_000);
    expect(checks).toBe(3);
  });

  it('a second press inside the wait does not stack a second timer', async () => {
    render(<PayClient token="tok" />);
    await pressPaid();
    fireEvent.click(screen.getByRole('button', { name: /I.ve paid/ }));
    await tick(10);
    expect(checks).toBe(3);
    await tick(30_000);
    expect(checks).toBe(4);
  });

  it('the retry unlocks the page without another press', async () => {
    render(<PayClient token="tok" />);
    await pressPaid();
    answer = () => ({ view: paidView });
    await tick(11_100);
    expect(checks).toBe(3);
    expect(screen.getByText(/Verified with PayPal/)).toBeTruthy();
  });

  it('cancels on unmount', async () => {
    const { unmount } = render(<PayClient token="tok" />);
    await pressPaid();
    unmount();
    await tick(30_000);
    expect(checks).toBe(2);
  });

  it('cancels when another check already succeeded', async () => {
    render(<PayClient token="tok" />);
    await pressPaid();
    answer = () => ({ view: paidView });
    await act(async () => { window.dispatchEvent(new Event('focus')); await vi.advanceTimersByTimeAsync(10); });
    expect(checks).toBe(3);
    await tick(30_000);
    expect(checks).toBe(3);
  });

  it('a press that was not throttled schedules nothing', async () => {
    answer = () => ({ view: unpaidView });
    render(<PayClient token="tok" />);
    await pressPaid();
    await tick(30_000);
    expect(checks).toBe(2);
  });
});
