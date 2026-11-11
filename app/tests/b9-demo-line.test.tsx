// @vitest-environment jsdom
// review b9 5: in demo mode, /login and the pay page each say where the test logins are. Nothing appears in live mode.
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PayView } from '@/lib/pay';

vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn() }), useSearchParams: () => new URLSearchParams() }));

const { default: LoginPage } = await import('@/app/login/page');
const { default: PayPage } = await import('@/app/pay/[token]/page');

const LINE = /test logins are in the testing instructions on Devpost/;
const LOGIN_LINE = /Reviewing this entry\? The demo login is in the testing instructions on Devpost/;
const saved = process.env.DEMO_MODE;
const view: PayView = {
  creatorName: 'Imani', assetTitle: 'Morning Pour', scope: 'Social, US, 6 mo', versionNo: 1, totalCents: 30000, currency: 'USD',
  status: 'paid', rail: 'invoice', payerUrl: null, verified: null, refusal: null, fileLabel: 'Web file', receiptPath: null,
  term: { startAt: null, endAt: null }, previewPath: '/api/pay/tok/preview',
};

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_DEVPOST_URL', '');
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(view), { status: 200 })));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  if (saved === undefined) delete process.env.DEMO_MODE; else process.env.DEMO_MODE = saved;
});

describe('demo-mode line', () => {
  it('shows on /login only in demo mode', () => {
    process.env.DEMO_MODE = '1';
    const { unmount } = render(<LoginPage />);
    expect(screen.getByText(LOGIN_LINE)).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'testing instructions on Devpost' })).toBeNull();
    unmount();
    process.env.DEMO_MODE = '';
    render(<LoginPage />);
    expect(screen.queryByText(LOGIN_LINE)).toBeNull();
    expect(screen.getByLabelText('Creator token')).toBeTruthy();
  });

  it('links the demo instructions only when a public project URL is configured', () => {
    vi.stubEnv('NEXT_PUBLIC_DEVPOST_URL', 'https://devpost.com/software/test-entry');
    process.env.DEMO_MODE = '1';
    render(<LoginPage />);
    expect(screen.getByRole('link', { name: 'testing instructions on Devpost' }).getAttribute('href')).toBe('https://devpost.com/software/test-entry');
    expect(screen.getByLabelText('Creator token')).toBeTruthy();
  });

  it('shows on the pay page only in demo mode', async () => {
    process.env.DEMO_MODE = '1';
    const params = Promise.resolve({ token: 'tok' });
    const { unmount } = render(await PayPage({ params }));
    expect(await screen.findByText(LINE)).toBeTruthy();
    unmount();
    process.env.DEMO_MODE = '';
    render(await PayPage({ params }));
    await screen.findByText('Morning Pour');
    expect(screen.queryByText(LINE)).toBeNull();
  });
});
