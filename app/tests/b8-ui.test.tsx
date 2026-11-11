// @vitest-environment jsdom
// Batch 8 screens: the pay page's renewal checkbox (§2).
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RENEWAL_LABEL, RenewalOptIn } from '@/components/pay/renewal-opt-in';
import type { PayView } from '../lib/pay';

const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
type Route = (url: string, init?: RequestInit) => Response | Promise<Response>;
let routes: Route;
const posts: { url: string; body: unknown }[] = [];
beforeEach(() => {
  posts.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') posts.push({ url, body: init.body ? JSON.parse(String(init.body)) : null });
    return routes(url, init);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const view = (over: Partial<PayView> = {}): PayView => ({
  creatorName: 'Imani', assetTitle: 'Harbor Light', scope: 'Web, US, 6 months', versionNo: 1, totalCents: 10000, currency: 'USD', status: 'paid',
  rail: 'invoice', payerUrl: null, verified: null, refusal: null, fileLabel: 'Web file', receiptPath: null,
  term: { startAt: '2026-10-29T04:00:00.000Z', endAt: '2027-04-29T04:00:00.000Z' }, previewPath: '/p', renewal: { optIn: false, canChange: true }, ...over,
});

describe('renewal checkbox', () => {
  it('is unticked by default and saves the choice through the pay page route', async () => {
    const saved = view({ renewal: { optIn: true, canChange: true } });
    routes = () => ok({ view: saved });
    const onView = vi.fn();
    render(<RenewalOptIn token="tok" view={view()} onView={onView} />);
    const box = screen.getByRole('checkbox', { name: RENEWAL_LABEL }) as HTMLInputElement;
    expect(box.checked).toBe(false);
    await act(async () => { fireEvent.click(box); });
    expect(posts).toEqual([{ url: '/api/pay/tok/renewal', body: { optIn: true } }]);
    expect(onView).toHaveBeenCalledWith(saved);
    expect(screen.getByText('Saved. You will get a renewal invoice before the licence ends.')).toBeTruthy();
  });

  it('puts the box back and says why when the save is refused', async () => {
    routes = () => ok({ error: 'This choice can no longer change: the renewal invoice was already sent, or the licence is over.' }, 409);
    render(<RenewalOptIn token="tok" view={view()} onView={() => {}} />);
    const box = screen.getByRole('checkbox', { name: RENEWAL_LABEL }) as HTMLInputElement;
    await act(async () => { fireEvent.click(box); });
    expect(box.checked).toBe(false);
    expect(screen.getByText(/can no longer change/)).toBeTruthy();
  });

  it('is fixed once the renewal is out, and hidden when it can no longer be requested', () => {
    const { rerender } = render(<RenewalOptIn token="tok" view={view({ renewal: { optIn: true, canChange: false } })} onView={() => {}} />);
    const box = screen.getByRole('checkbox', { name: RENEWAL_LABEL }) as HTMLInputElement;
    expect([box.checked, box.disabled]).toEqual([true, true]);
    expect(screen.getByText(/already on its way/)).toBeTruthy();
    rerender(<RenewalOptIn token="tok" view={view({ renewal: { optIn: false, canChange: false } })} onView={() => {}} />);
    expect(screen.queryByRole('checkbox')).toBeNull();
  });
});

// ---------------------------------------------------------------- §4 screens

const router = { replace: vi.fn(), push: vi.fn(), refresh: vi.fn() };
vi.mock('next/navigation', () => ({ useRouter: () => router, usePathname: () => '/demo', useSearchParams: () => new URLSearchParams() }));
const { default: DemoPage } = await import('@/app/(creator)/demo/page');
const { LicenceCard } = await import('@/components/creator/licence');
const { StatusBadge } = await import('@/components/creator/page-bits');
const { bellText, isBellEvent } = await import('@/components/creator/activity-bell');
const { ruleInPlainWords, STATUS_MEANING, progressFor } = await import('@/components/creator/explain');
const { dealState } = await import('../lib/briefs');

describe('demo panel', () => {
  it('says the panel is off in live mode and offers no buttons', async () => {
    routes = () => ok({ error: 'off' }, 404);
    render(<DemoPage />);
    expect(await screen.findByText(/The demo panel is off/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Advance/ })).toBeNull();
  });

  it('one button advances to the next renewal and runs the tick, all labelled Demo; no tick button while all is well', async () => {
    let offset = 0;
    routes = (url, init) => {
      if (url === '/api/demo' && !init?.method) return ok({ demoMode: true, now: '2026-11-03T12:00:00.000Z', offsetDays: offset });
      if (url === '/api/demo/clock') { offset += 170; return ok({ now: '2027-04-22T12:00:00.000Z', offsetDays: offset, moved: true, days: 170, tick: { now: 'x', renewals: { created: 1, sent: 1, held: 0 }, expired: 3, seededExpired: 2, deals: ['brief-r'] } }); }
      return ok({}, 404);
    };
    render(<DemoPage />);
    const advance = await screen.findByRole('button', { name: 'Advance to the next renewal' });
    expect(screen.queryByRole('button', { name: /\+30/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Run tick/ })).toBeNull();
    expect(screen.getAllByText('Demo').length).toBeGreaterThanOrEqual(2); // the page title and the Demo chip by the buttons
    await act(async () => { fireEvent.click(advance); });
    expect(posts.map((p) => p.url)).toEqual(['/api/demo/clock']);
    // Review fix 9 (review 6, 9): seeded expiries are labelled Demo, and the renewal deal is one click away.
    expect(await screen.findByText('Clock moved forward 170 days to Apr 22, 2027. Tick: 1 renewal opened, 1 renewal invoice sent, 3 licences expired (2 of them seeded Demo).')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open the renewal deal' }).getAttribute('href')).toBe('/deals/brief-r');
    expect(await screen.findByText('170 days ahead of real time')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Run tick/ })).toBeNull();
  });

  it('a tick that fails after the clock moved offers Run tick again, which posts only the tick', async () => {
    routes = (url, init) => {
      if (url === '/api/demo' && !init?.method) return ok({ demoMode: true, now: '2026-11-03T12:00:00.000Z', offsetDays: 0 });
      if (url === '/api/demo/clock') return ok({ now: '2027-04-22T12:00:00.000Z', offsetDays: 170, moved: true, days: 170, tick: null, tickError: 'The clock moved, but the tick did not finish. Use Run tick again; it does not move the clock.' });
      if (url === '/api/demo/tick') return ok({ tick: { now: 'x', renewals: { created: 1, sent: 0, held: 1 }, expired: 0 } });
      return ok({}, 404);
    };
    render(<DemoPage />);
    const advance = await screen.findByRole('button', { name: 'Advance to the next renewal' });
    await act(async () => { fireEvent.click(advance); });
    expect(await screen.findByText(/The clock moved, but the tick did not finish/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Advance to the next renewal' })).toBeNull(); // review re-review N2
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Run tick again' })); });
    expect(posts.map((p) => p.url)).toEqual(['/api/demo/clock', '/api/demo/tick']);
    expect(await screen.findByText('Tick: 1 renewal opened, 1 renewal waits in Ask me.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Run tick/ })).toBeNull();
  });
});

describe('demo panel: Start a fresh deal (B9 9.2)', () => {
  it('posts the route, says what happened, and links the new deal', async () => {
    routes = (url, init) => {
      if (url === '/api/demo' && !init?.method) return ok({ demoMode: true, now: '2026-11-03T12:00:00.000Z', offsetDays: 0 });
      if (url === '/api/demo/fresh-deal') return ok({ briefId: 'b-new', sample: 'Print add-on', autopilot: 'sent' });
      return ok({}, 404);
    };
    render(<DemoPage />);
    const fresh = await screen.findByRole('button', { name: 'Start a fresh deal' });
    await act(async () => { fireEvent.click(fresh); });
    expect(posts.map((p) => p.url)).toEqual(['/api/demo/fresh-deal']);
    expect(await screen.findByText('Clock back at real time. Added a new request: Print add-on.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open the new deal' }).getAttribute('href')).toBe('/deals/b-new');
  });

  it('says so when it reuses an unsettled deal (review 4)', async () => {
    routes = (url, init) => {
      if (url === '/api/demo' && !init?.method) return ok({ demoMode: true, now: '2026-11-03T12:00:00.000Z', offsetDays: 0 });
      if (url === '/api/demo/fresh-deal') return ok({ briefId: 'b-old', sample: 'Print add-on', reused: true, autopilot: null });
      return ok({}, 404);
    };
    render(<DemoPage />);
    const fresh = await screen.findByRole('button', { name: 'Start a fresh deal' });
    await act(async () => { fireEvent.click(fresh); });
    expect(await screen.findByText('Clock back at real time. Print add-on is still open, so no new request or invoice was added.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open the deal' }).getAttribute('href')).toBe('/deals/b-old');
  });
});

describe('demo panel after a reload (review re-review N2)', () => {
  it('a pending tick offers only Run tick again; once it succeeds, Advance returns', async () => {
    let pending = true;
    routes = (url, init) => {
      if (url === '/api/demo' && !init?.method) return ok({ demoMode: true, now: '2026-11-03T12:00:00.000Z', offsetDays: 170, tickPending: pending });
      if (url === '/api/demo/tick') { pending = false; return ok({ tick: { now: 'x', renewals: { created: 0, sent: 1, held: 0 }, expired: 0 } }); }
      return ok({}, 404);
    };
    render(<DemoPage />);
    const again = await screen.findByRole('button', { name: 'Run tick again' });
    expect(screen.queryByRole('button', { name: 'Advance to the next renewal' })).toBeNull();
    await act(async () => { fireEvent.click(again); });
    expect(await screen.findByRole('button', { name: 'Advance to the next renewal' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Run tick again' })).toBeNull();
  });
});

describe('renewal and expiry states', () => {
  const licence = { versionId: 'v', versionNo: 1, scope: { channels: ['web'], territory: 'US', durationMonths: 6, exclusive: false } as never, status: 'active', startAt: new Date('2026-10-29T04:00:00Z'), endAt: new Date('2027-04-29T04:00:00Z'), totalCents: 10000, paidCents: 10000 };
  it('the licence says when it renews, that the renewal was sent, or that none was requested', () => {
    const { rerender } = render(<LicenceCard licence={{ ...licence, renewalOptIn: true, renewalSent: false }} />);
    // Review fix 9 (review 7): it only sends an invoice, a week before the end.
    expect(screen.getByText('Renewal invoice from Apr 22, 2027; ends Apr 29, 2027 unless paid')).toBeTruthy();
    expect(screen.queryByText(/Renews on/)).toBeNull();
    expect(screen.getByRole('button', { name: 'What is renewal?' })).toBeTruthy();
    rerender(<LicenceCard licence={{ ...licence, renewalOptIn: true, renewalSent: true }} />);
    expect(screen.getByText('Renewal sent')).toBeTruthy();
    rerender(<LicenceCard licence={{ ...licence, renewalOptIn: false, renewalSent: false }} />);
    expect(screen.getByText('Not requested; ends Apr 29, 2027 unless you renew it')).toBeTruthy();
  });

  it('an expired deal reads Expired everywhere, never Paid', () => {
    expect(dealState('extracted', null, null, { version: { status: 'expired', sendState: 'sent', policy: null, extractionId: null, rejectedAt: null, invoiceState: 'paid' }, briefRejectedAt: null, latestExtractionId: null }))
      .toEqual({ status: 'expired', reasons: ['expired'] });
    render(<StatusBadge status="expired" />);
    expect(screen.getByText('Expired, downloads stopped')).toBeTruthy();
    expect(STATUS_MEANING.expired!.means).toBe('The licence term ended without a paid renewal.');
    expect(progressFor('expired')).toBe(5);
  });

  it('the bell lists renewals sent or held and licences that ended; RENEW reads in plain words', () => {
    for (const kind of ['renewal.sent', 'renewal.draft', 'expired']) expect(isBellEvent({ kind, result: null })).toBe(true);
    expect(bellText({ kind: 'renewal.sent', demo: false, message: null, rule: null })).toBe('Renewal invoice sent');
    expect(bellText({ kind: 'renewal.draft', demo: false, message: null, rule: null })).toBe('Renewal held for your OK');
    expect(bellText({ kind: 'expired', demo: false, message: null, rule: null })).toBe('Licence ended, downloads stopped');
    expect(bellText({ kind: 'expired', demo: true, message: null, rule: null })).toBe('Seeded licence ended');
    expect(ruleInPlainWords('renewal_needs_ok', 'Northwind Coffee')).toBe('Northwind Coffee did not tick “Send me a renewal invoice” on the pay page, so the agent asks you before sending this renewal.');
  });
});
