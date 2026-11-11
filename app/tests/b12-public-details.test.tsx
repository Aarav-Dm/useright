// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import Credits from '@/app/credits/page';
import Receipt from '@/app/r/[id]/page';
import { RequestDrawer } from '@/components/client/request-drawer';
import { PayClient } from '@/components/client/pay-client';
import { payView } from '@/lib/pay';
import type { Db } from '@/db/client';
import type { PayView } from '@/lib/pay';
import manifest from '@/public/portfolio/imani/photos.json';

const receiptMock = vi.hoisted(() => ({ view: vi.fn() }));
vi.mock('@/lib/server', () => ({ deps: async () => ({ db: {} }) }));
vi.mock('@/lib/receipts', () => ({ receiptView: receiptMock.view, latestReceiptId: vi.fn() }));
vi.mock('@/components/client/receipt-actions', () => ({ ReceiptActions: () => null }));
vi.mock('@/components/client/motion-pref', () => ({ useReduce: () => true }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it('credits list all 24 source records, distinguish CC0 and disclose unverified attribution', () => {
  const html = renderToStaticMarkup(<Credits />);
  for (const p of manifest.photos) {
    expect(html).toContain(p.title);
    expect(html).toContain(p.sourceUrl.replaceAll('&', '&amp;'));
    expect(html).toContain(p.licenceUrl);
  }
  expect(html).toContain('Recorded licence: CC0 1.0');
  expect(html).toContain('not to Imani');
  expect(html).toContain('not independently rechecked');
  expect(html).not.toContain('PHC-');
});

it('a public request waits for on-page confirmation and does not claim email verification', async () => {
  const fetcher = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ confirmation: { token: 'page-token' } }), { status: 201 }));
  vi.stubGlobal('fetch', fetcher);
  const photo = { num: '01', assetId: '11111111-2222-4333-8444-555555555555', title: 'Harbor Light', alt: 'Harbor', src: '/photo.jpg', width: 1200, height: 800, orientation: 'landscape' as const };
  render(<RequestDrawer open photo={photo} photos={[photo]} creatorSlug="imani" creatorName="Avery Chen" onClose={() => {}} />);
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'client@example.com' } });
  fireEvent.click(screen.getByRole('button', { name: 'Social' }));
  fireEvent.click(screen.getByRole('button', { name: 'Send request' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Confirm request' }));
  expect(await screen.findByText('Avery Chen has your request. They will review it before sending any invoice; nothing else is needed from you. Your email has not been verified.')).toBeTruthy();
  expect(screen.getByText('Request sent')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Back to the work' })).toBeTruthy();
  expect(screen.queryByText(/email your quote/)).toBeNull();
  expect(JSON.parse(fetcher.mock.calls[0]![1]!.body as string)).toMatchObject({ source: 'portfolio', email: 'client@example.com', confirmOnPage: true });
  expect(fetcher.mock.calls[1]![0]).toBe('/api/verify/page-token/page');
});

it('pay displays the frozen parent and quote gap before total, without changing the payable amount', async () => {
  vi.stubEnv('DEMO_MODE', '0');
  const scope = { channels: ['social', 'print'], territory: 'US', durationMonths: 6, exclusive: false };
  const query = vi.fn(async (sql: string) => {
    if (sql.includes('i.pay_token_hash')) return [{ version_id: 'v2', creator_id: 'creator', v_status: 'pending', invoice_state: 'sent', scope, total_cents: 42000, version_no: 2, creator_name: 'Imani', title: 'Morning Pour', rail: 'invoice', payer_url: 'https://example.com/pay', renewal_opt_in: false }];
    if (sql.includes('p.scope as parent_scope')) return [{ scope, rate_card: { social: 15000, print: 42000, US: 0, '6mo': 15000 }, renewal_of: null, parent_scope: { ...scope, channels: ['social'] }, parent_paid: 30000 }];
    return [];
  });
  const view = await payView({ query } as unknown as Db, 'a'.repeat(43));
  expect(view?.gap).toMatchObject({ addedScope: 'Print', combinedCents: 72000, paidCents: 30000 });
  expect(view?.totalCents).toBe(42000);
  expect(query.mock.calls.some(([sql]) => sql.includes('rate_card_options'))).toBe(false);
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(url.endsWith('/check') ? { view } : view), { status: 200 })));
  render(<PayClient token="tok" />);
  expect(await screen.findByText('You already hold Social, US, 6 mo, paid $300.00.')).toBeTruthy();
  expect(screen.getByText('This adds Print for the rest of the term.')).toBeTruthy();
  expect(screen.getByText('$720.00 full scope − $300.00 paid = $420.00 due now')).toBeTruthy();
  expect(screen.queryByText('Total')).toBeNull();
  await waitFor(() => expect(screen.getByLabelText('Licence price breakdown').compareDocumentPosition(screen.getByText('Due now')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy());
});

it.each([false, true])('first licence / renewal retain Total and use the approved copy (renewal=%s)', async (renewal) => {
  const view: PayView = {
    creatorName: 'Imani', assetTitle: 'Morning Pour', scope: 'Social, US, 6 mo', versionNo: renewal ? 2 : 1,
    totalCents: 30000, currency: 'USD', status: 'unpaid', rail: 'invoice', payerUrl: null,
    verified: null, refusal: null, fileLabel: 'Web file', receiptPath: null, term: { startAt: null, endAt: null }, previewPath: '/preview',
    gap: { currentScope: null, addedScope: 'Social, US, 6 mo', combinedCents: 30000, paidCents: 0, renewal },
  };
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(url.endsWith('/check') ? { view } : view))));
  render(<PayClient token="tok" />);
  expect(await screen.findByText(renewal ? 'Renewal of Social, US, 6 mo. Earlier payments covered the previous term.' : 'This is the first licence for this photo.')).toBeTruthy();
  expect(screen.getByText(renewal ? '$300.00 for the next term' : "$300.00 on Imani's rate card")).toBeTruthy();
  if (!renewal) expect(screen.getByText('Adding Social, US, 6 mo.')).toBeTruthy();
  expect(screen.getByText('Total')).toBeTruthy();
  expect(screen.queryByText('Due now')).toBeNull();
});

it('receipt Issued and Term use the same creator zone across the UTC midnight boundary', async () => {
  const instant = '2026-11-11T00:30:00Z';
  receiptMock.view.mockResolvedValue({ timeZone: 'America/New_York', liveStatus: 'active', renewalOptIn: false, body: {
    kind: 'grant', licensor: { name: 'Imani' }, licensee: { name: 'Client' }, asset: { title: 'Morning Pour', fileLabel: 'Web file', sha256: 'hash' }, scope: { words: 'Social' }, startAt: instant, endAt: '2027-05-11T00:30:00Z', issuedAt: instant, priceCents: 30000, currency: 'USD', paypalTransactionId: 'CAPTURE', versionNo: 1,
  } });
  const html = renderToStaticMarkup(await Receipt({ params: Promise.resolve({ id: 'receipt' }) }));
  expect(html).toContain('<dd>Nov 10, 2026 to May 10, 2027</dd>');
  expect(html).toContain('<dd>Nov 10, 2026</dd>');
  expect(html).not.toContain('Nov 11, 2026');
});
