// @vitest-environment jsdom
// Batch 7: client experience (/c/[slug]) render and request tests. Pay and receipt behaviour stay covered by
// b6-ui.test.tsx; this file checks the new page: sections, photo detail, real rate card prices, and that the
// request drawer posts the right intake source without ever inventing an asset id.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ImgHTMLAttributes } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import { ClientExperience } from '@/components/client/client-experience';
import { PayClient } from '@/components/client/pay-client';
import { ReceiptActions } from '@/components/client/receipt-actions';
import type { PortfolioPhoto, PublicCreator } from '@/components/client/types';
import type { PayView } from '@/lib/pay';
import { DEFAULT_CARD } from '@/lib/pricing';

vi.mock('next/image', () => ({
  // eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text
  default: ({ src, alt, fill: _f, priority: _p, placeholder: _ph, blurDataURL: _b, quality: _q, ...rest }: ImgHTMLAttributes<HTMLImageElement> & Record<string, unknown>) => <img src={String(src)} alt={alt} {...rest} />,
}));

const cobe = vi.hoisted(() => ({ update: vi.fn(), destroy: vi.fn(), create: vi.fn() }));
vi.mock('cobe', () => ({ default: (...a: unknown[]) => { cobe.create(...a); return { update: cobe.update, destroy: cobe.destroy }; } }));

const ASSET = '11111111-2222-4333-8444-555555555555';
const photos: PortfolioPhoto[] = Array.from({ length: 6 }, (_, i) => {
  const num = String(i + 1).padStart(2, '0');
  const portrait = i % 3 === 2;
  return {
    assetId: i === 0 ? ASSET : null,
    num, title: `Photo ${num}`, alt: `Alt text ${num}`,
    orientation: portrait ? 'portrait' : 'landscape',
    width: portrait ? 800 : 1200, height: portrait ? 1200 : 800,
    src: `/portfolio/imani/${num}.jpg`,
  };
});
const creator: PublicCreator = { slug: 'imani', name: 'Imani Okafor', rateCard: { ...DEFAULT_CARD, social: 20000 } };

beforeAll(() => {
  class IO { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } }
  vi.stubGlobal('IntersectionObserver', IO);
  vi.stubGlobal('ResizeObserver', IO);
  window.matchMedia ??= ((q: string) => ({ matches: false, media: q, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false })) as typeof window.matchMedia;
  window.scrollTo = () => {};
});
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => { fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { cleanup(); fetchMock.mockReset(); });

const openDrawer = () => fireEvent.click(screen.getAllByRole('button', { name: /Request a licence/ })[0]!);

describe('client experience page', () => {
  it('renders every section, all photos in the grid, and no private creator field', () => {
    const { container } = render(<ClientExperience creator={creator} photos={photos} />);
    for (const id of ['work', 'how', 'pricing', 'about']) expect(container.querySelector(`#${id}`)).toBeTruthy();
    for (const p of photos) expect(screen.getByRole('button', { name: `Open ${p.title}` })).toBeTruthy();
    expect(screen.getByText('Files unlock only after PayPal confirms payment.')).toBeTruthy();
    expect(screen.queryByText('Unlocks only after PayPal confirms')).toBeNull();
    expect(container.innerHTML).not.toMatch(/@useright|email/i);
  });

  it('shows rate card prices from the creator card, not hard-coded ones', () => {
    render(<ClientExperience creator={creator} photos={photos} />);
    const pricing = document.getElementById('pricing')!;
    expect(within(pricing).getByText('$200.00')).toBeTruthy(); // social from the card above
  });

  it('opens a photo detail with prices from price() and closes on Escape', async () => {
    render(<ClientExperience creator={creator} photos={photos} />);
    const tile = screen.getByRole('button', { name: 'Open Photo 02' }) as HTMLElement;
    fireEvent.click(tile);
    const dialog = await screen.findByRole('dialog', { name: 'Photo 02' });
    // social 200 + US 0 + 6 months 150
    expect(within(dialog).getByText('$350.00')).toBeTruthy();
    expect(tile.style.visibility).toBe('hidden'); // the tile has morphed into the dialog
    fireEvent.keyDown(window, { key: 'Escape' });
    // jsdom never finishes the exit morph, so check the state change: the tile is back in the grid.
    await waitFor(() => expect(tile.style.visibility).toBe('visible'));
  });

  it('validates the request form before sending anything', async () => {
    render(<ClientExperience creator={creator} photos={photos} />);
    openDrawer();
    fireEvent.click(await screen.findByRole('button', { name: /Send request/ }));
    expect(await screen.findByText(/Enter a valid contact email/)).toBeTruthy();
    expect(screen.getByText(/Tell us how you plan to use the photo/)).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('posts source portfolio with the real asset id when the photo has one', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ briefId: 'b', confirmation: { token: 'page-token' } }), { status: 201 }));
    render(<ClientExperience creator={creator} photos={photos} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open Photo 01' }));
    fireEvent.click(await screen.findByRole('button', { name: /Request this photo/ }));
    fireEvent.change(await screen.findByPlaceholderText('you@studio.example'), { target: { value: 'buyer@brand.example' } });
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Request a licence' })).getByRole('button', { name: 'Social' }));
    fireEvent.click(screen.getByRole('button', { name: /Send request/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm request' }));
    expect(await screen.findByText('Request sent')).toBeTruthy();
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/intake');
    expect(body).toMatchObject({ source: 'portfolio', assetId: ASSET, email: 'buyer@brand.example', confirmOnPage: true });
    expect(body.text).toContain('Photo 01');
  });

  it('posts source form with the creator slug, and no asset id, when the photo has no asset', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 201 }));
    render(<ClientExperience creator={creator} photos={photos} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open Photo 02' }));
    fireEvent.click(await screen.findByRole('button', { name: /Request this photo/ }));
    fireEvent.change(await screen.findByPlaceholderText('you@studio.example'), { target: { value: 'buyer@brand.example' } });
    fireEvent.change(screen.getByPlaceholderText(/Where it runs/), { target: { value: 'Instagram for a month' } });
    fireEvent.click(screen.getByRole('button', { name: /Send request/ }));
    await screen.findByText('Request sent');
    expect(screen.queryByRole('button', { name: 'Confirm request' })).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(body).toMatchObject({ source: 'form', creatorSlug: 'imani' });
    expect(body.assetId).toBeUndefined();
    expect(body.confirmOnPage).toBeUndefined();
  });

  it('shows a calm notice on 429 and keeps the form', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 429 }));
    render(<ClientExperience creator={creator} photos={photos} />);
    openDrawer();
    fireEvent.change(await screen.findByPlaceholderText('you@studio.example'), { target: { value: 'buyer@brand.example' } });
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Request a licence' })).getByRole('button', { name: 'Print' }));
    fireEvent.click(screen.getByRole('button', { name: /Send request/ }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringMatching(/Wait a few minutes/));
    expect(screen.getByRole('button', { name: /Send request/ })).toBeTruthy();
  });
});

describe('review fixes (review b7)', () => {
  const setReduce = (on: boolean) => { window.matchMedia = ((q: string) => ({ matches: on && q.includes('reduce'), media: q, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false })) as typeof window.matchMedia; };
  afterEach(() => setReduce(false));

  it('server HTML does not depend on the motion setting, and the hero height is CSS-owned', () => {
    const html = renderToString(<ClientExperience creator={creator} photos={photos} />);
    expect(html).toContain('g-hero');
    expect(html).not.toMatch(/260vh|100vh/); // no inline height to mismatch on hydration
    setReduce(true);
    expect(renderToString(<ClientExperience creator={creator} photos={photos} />)).toBe(html);
  });

  it('reduced motion shows final numbers and keeps every photo reachable', async () => {
    setReduce(true);
    render(<ClientExperience creator={creator} photos={photos} />);
    expect((await screen.findByText('kinds of use')).previousElementSibling?.textContent).toBe('6'); // stat shown final, no count-up
    expect(screen.getAllByRole('button', { name: /^Open Photo/ })).toHaveLength(photos.length);
  });

  it('reduced motion: grid tiles enter with no translate (review 4)', () => {
    setReduce(true);
    render(<ClientExperience creator={creator} photos={photos} />);
    const li = screen.getByRole('button', { name: 'Open Photo 01' }).closest('li')!;
    expect(li.style.transform ?? '').not.toMatch(/translate/);
  });

  it('clears the body scroll lock if the page unmounts with a dialog open (review 11)', async () => {
    const { unmount } = render(<ClientExperience creator={creator} photos={photos} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open Photo 02' }));
    await screen.findByRole('dialog', { name: 'Photo 02' });
    expect(document.body.style.overflow).toBe('hidden');
    unmount();
    expect(document.body.style.overflow).toBe('');
  });

  it('Tab wraps inside the open dialog (review 1)', async () => {
    render(<ClientExperience creator={creator} photos={photos} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open Photo 02' }));
    const dialog = await screen.findByRole('dialog', { name: 'Photo 02' });
    const items = dialog.querySelectorAll<HTMLElement>('button, a[href]');
    items[items.length - 1]!.focus();
    fireEvent.keyDown(document.activeElement!, { key: 'Tab' });
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(document.activeElement!, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(items[items.length - 1]);
  });

  it('returns focus to the opening tile after stepping through the detail', async () => {
    render(<ClientExperience creator={creator} photos={photos} />);
    const tile = screen.getByRole('button', { name: 'Open Photo 02' });
    tile.focus();
    fireEvent.click(tile);
    await screen.findByRole('dialog', { name: 'Photo 02' });
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    await screen.findByRole('dialog', { name: 'Photo 03' });
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(document.activeElement).toBe(tile));
  });

  it('pause toggle stops motion and can resume', () => {
    const { container } = render(<ClientExperience creator={creator} photos={photos} />);
    fireEvent.click(screen.getByRole('button', { name: 'Pause motion' }));
    expect(container.firstElementChild!.classList.contains('g-paused')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Play motion' }));
    expect(container.firstElementChild!.classList.contains('g-paused')).toBe(false);
  });

  it('an old request reply does not mark a newly opened drawer as sent (review 3)', async () => {
    let release!: (r: Response) => void;
    fetchMock.mockReturnValueOnce(new Promise<Response>((r) => { release = r; }));
    render(<ClientExperience creator={creator} photos={photos} />);
    openDrawer();
    fireEvent.change(await screen.findByPlaceholderText('you@studio.example'), { target: { value: 'buyer@brand.example' } });
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Request a licence' })).getByRole('button', { name: 'Print' }));
    fireEvent.click(screen.getByRole('button', { name: /Send request/ }));
    fireEvent.keyDown(window, { key: 'Escape' });
    openDrawer();
    release(new Response('{}', { status: 201 }));
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByText('Request sent')).toBeNull();
    expect(screen.getByRole('button', { name: /Send request/ })).toBeTruthy();
  });

  it('Request this licence carries the estimator choices into the request (review 8)', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 201 }));
    render(<ClientExperience creator={creator} photos={photos} />);
    const pricing = document.getElementById('pricing')!;
    fireEvent.click(within(pricing).getByRole('button', { name: /Request this licence/ }));
    fireEvent.change(await screen.findByPlaceholderText('you@studio.example'), { target: { value: 'buyer@brand.example' } });
    fireEvent.click(screen.getByRole('button', { name: /Send request/ }));
    await screen.findByText('Request sent');
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body).text).toMatch(/Use: Social; United States; 6 months\./);
  });

  it('pay chip never says Paid before PayPal verifies', async () => {
    const view: PayView = {
      creatorName: 'Imani', assetTitle: 'Morning Pour', scope: 'Social, US, 6 mo', versionNo: 1, totalCents: 30000, currency: 'USD',
      status: 'paid', rail: 'invoice', payerUrl: null, verified: null, refusal: null, fileLabel: 'Web file', receiptPath: null,
      term: { startAt: null, endAt: null }, previewPath: '/api/pay/tok/preview',
    };
    fetchMock.mockImplementation(async () => new Response(JSON.stringify(view), { status: 200 }));
    render(<PayClient token="tok" />);
    expect(await screen.findByText('Checking with PayPal')).toBeTruthy();
    expect(screen.queryByText('Paid')).toBeNull();
  });
});

describe('globe earth (review cinematic)', () => {
  it('builds the earth once at CSS size (cobe applies the pixel ratio), resizes in place, destroys on unmount', () => {
    cobe.create.mockClear(); cobe.destroy.mockClear(); cobe.update.mockClear();
    const { unmount } = render(<ClientExperience creator={creator} photos={photos} />);
    expect(cobe.create).toHaveBeenCalledTimes(1);
    const [canvas, opts] = cobe.create.mock.calls[0] as [HTMLCanvasElement, { width: number; devicePixelRatio: number }];
    expect(canvas.parentElement!.style.width).toBe(`${opts.width}px`); // not width * dpr: cobe multiplies itself
    fireEvent(window, new Event('resize'));
    fireEvent(window, new Event('resize'));
    expect(cobe.create).toHaveBeenCalledTimes(1);
    expect(document.querySelectorAll('canvas')).toHaveLength(1);
    unmount();
    expect(cobe.destroy).toHaveBeenCalled();
  });
});

describe('receipt actions', () => {
  it('copies only the receipt page address', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<ReceiptActions />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy receipt link' }));
    await screen.findByText('Receipt link copied.');
    expect(writeText).toHaveBeenCalledWith(window.location.href);
  });
});
