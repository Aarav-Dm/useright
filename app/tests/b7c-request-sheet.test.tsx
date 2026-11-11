// @vitest-environment jsdom
// Batch 7C phase 1: the "Add client request" sheet, next-step banners, help panels and the share link.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dealsNextSteps, askNextSteps, HelpPanel } from '@/components/creator/guide';
import { SAMPLES } from '@/components/creator/request-samples';
import { AUTOSEND_WARNING, MAX_SCREENSHOT_BYTES, RequestSheet, TOO_BIG } from '@/components/creator/request-sheet';
import { SharePage } from '@/components/creator/share-page';
import type { BriefView } from '../lib/briefs';
import type { DealRow } from '../lib/deals';
import type { AskItem } from '../lib/ledger';
import * as T from './fixtures/texts';

const iso = '2026-10-29T12:00:00.000Z';
const BRIEF = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const NORTHWIND = '11111111-1111-4111-8111-111111111111';
const MORNING = '22222222-2222-4222-8222-222222222222';
const HARBOR = '33333333-3333-4333-8333-333333333333';
const options = {
  creatorSlug: 'imani',
  clients: [{ id: NORTHWIND, name: 'Northwind Coffee', email: 'buying@northwind.example', allowed: true }],
  assets: [{ id: HARBOR, title: 'Harbor Light', is_public: true }, { id: MORNING, title: 'Morning Pour', is_public: true }],
  optionIds: [],
};

type Route = (url: string, init?: RequestInit) => Response | Promise<Response>;
let routes: Route;
const posts: { url: string; body: Record<string, unknown> }[] = [];
const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

let currentOptions: typeof options = options;
beforeEach(() => {
  currentOptions = options;
  posts.length = 0;
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/options') return ok(currentOptions);
    if ((init?.method ?? 'GET') === 'POST') posts.push({ url, body: JSON.parse(String(init!.body)) });
    return routes(url, init);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const briefView = (over: Partial<BriefView>): BriefView => ({
  brief: { id: BRIEF, creator_id: 'c', client_id: NORTHWIND, asset_id: MORNING, source: 'paste', raw: 'x', claimed_sender: null, state: 'extracted', created_at: iso as unknown as Date, hasImage: false, rejected_at: null },
  status: 'needs_approval', reasons: [], notes: [],
  client: { id: NORTHWIND, name: 'Northwind Coffee', email: 'buying@northwind.example', allowed: true },
  asset: { id: MORNING, title: 'Morning Pour' },
  transcript: null, extraction: null, licence: null, cardSource: null, gapPreview: null, editable: false, webhookLastReceivedAt: null,
  checks: { status: 'ready', reasons: [], requested: null, dropped: [], kept: [
    { optionId: 'billboard', quote: T.BILLBOARD, lineIndex: 0, sentence: 'x' }, { optionId: '6mo', quote: T.BILLBOARD, lineIndex: 0, sentence: 'x' },
  ] },
  version: {
    id: 'v', versionNo: 2, status: 'pending', totalCents: 90000, scope: { channels: ['social', 'billboard'], territory: 'US', durationMonths: 6, exclusive: false },
    contentHash: 'h', sendState: 'idle', sendError: null, extractionId: 'x', rejectedAt: null, createdAt: iso as unknown as Date, invoice: null,
    policy: { pass: false, hardBlock: false, evaluatedAt: iso, mode: 'autopilot', results: [
      { rule: 'R1', pass: true, code: 'client_allowed', message: 'The client is on your allowed list.' },
      { rule: 'R2', pass: false, code: 'over_deal_cap:90000:50000', message: '$900.00 exceeds your $500.00 per-deal cap.' },
      { rule: 'R4', pass: false, code: 'needs_approval:billboard', message: 'Billboard needs your approval.' },
    ] },
  },
  ...over,
} as BriefView);

async function openSheet() {
  render(<RequestSheet />);
  fireEvent.click(screen.getByRole('button', { name: 'Add client request' }));
  return screen.findByRole('dialog');
}

describe('Add client request sheet', () => {
  it('samples stay equal to the fixture texts, so the demo reads them the same way', () => {
    const by = Object.fromEntries(SAMPLES.map((s) => [s.key, s]));
    expect(by.billboard!.text).toBe(T.BILLBOARD);
    expect(by.social!.text).toBe(T.PASTE);
    expect(by.paid!.text).toBe(T.PAID_SOCIAL);
    expect(by.print!.text).toBe(T.DEMO_DM.lines.map((l) => `${l.speaker}: ${l.text}`).join('\n'));
  });

  it('shows the auto-send warning before submit, posts the existing intake contract, then shows the server result', async () => {
    routes = (url) => {
      if (url === '/api/intake') return ok({ ok: true, briefId: BRIEF, state: 'extracted', autopilot: 'needs_approval' }, 201);
      if (url === `/api/briefs/${BRIEF}`) return ok(briefView({}));
      throw new Error(url);
    };
    const dialog = await openSheet();
    expect(within(dialog).getByText(AUTOSEND_WARNING)).toBeTruthy();
    const submit = within(dialog).getByRole('button', { name: 'Add request' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    await waitFor(() => expect((within(dialog).getByRole('button', { name: 'Load sample: Billboard ask' }) as HTMLButtonElement).disabled).toBe(false));
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'Load sample: Billboard ask' })); });
    expect((within(dialog).getByLabelText('Client’s message') as HTMLTextAreaElement).value).toBe(T.BILLBOARD);
    expect(submit.disabled).toBe(false);
    await act(async () => { fireEvent.click(submit); });
    expect(posts).toEqual([{ url: '/api/intake', body: { source: 'paste', clientId: NORTHWIND, assetId: MORNING, text: T.BILLBOARD, fixture: 'billboard' } }]);
    const card = await within(dialog).findByRole('region', { name: 'Request added' });
    expect(within(card).getByText('$900.00')).toBeTruthy();
    expect(within(card).getByText('Billboard, 6 months')).toBeTruthy();
    expect(within(card).getByText(/Stopped by R2, R4/)).toBeTruthy();
    expect(within(card).getByText('The rules stopped it, so nothing was sent. It waits for your typed approval.')).toBeTruthy();
    expect(within(card).getByRole('link', { name: 'Open Ask me to approve or reject it' }).getAttribute('href')).toBe('/ask');
  });

  it('an edited sample drops its fixture name; a refused submit keeps the draft and says to check Deals', async () => {
    routes = () => ok({ error: 'invalid intake: text Too big' }, 400);
    const dialog = await openSheet();
    await waitFor(() => expect((within(dialog).getByRole('button', { name: 'Load sample: New photo, social' }) as HTMLButtonElement).disabled).toBe(false));
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'Load sample: New photo, social' })); });
    const box = within(dialog).getByLabelText('Client’s message') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: `${T.PASTE} Thanks!` } });
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'Add request' })); });
    expect(posts[0]!.body).toEqual({ source: 'paste', clientId: NORTHWIND, assetId: HARBOR, text: `${T.PASTE} Thanks!` });
    expect(await within(dialog).findByText(/invalid intake: text Too big Your message is still here\. Check Deals before trying again\./)).toBeTruthy();
    expect(box.value).toBe(`${T.PASTE} Thanks!`);
    expect((within(dialog).getByRole('button', { name: 'Add request' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('a network failure keeps the draft and does not claim anything was sent', async () => {
    routes = () => { throw new TypeError('Failed to fetch'); };
    const dialog = await openSheet();
    await waitFor(() => expect((within(dialog).getByRole('button', { name: 'Load sample: Print add-on' }) as HTMLButtonElement).disabled).toBe(false));
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'Load sample: Print add-on' })); });
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'Add request' })); });
    expect(await within(dialog).findByText(/the result is unknown\. Your message is still here\. Check Deals before trying again\./)).toBeTruthy();
    expect((within(dialog).getByLabelText('Client’s message') as HTMLTextAreaElement).value).toContain("We'd also like to use it on our printed menus");
  });

  it('a screenshot result points to confirming the transcript', async () => {
    routes = (url) => {
      // jsdom's FileReader reads only jsdom Blobs, so the sample fetch returns one directly.
      if (url === '/samples/demo-dm.png') return { blob: async () => new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' }) } as unknown as Response;
      if (url === '/api/intake') return ok({ ok: true, briefId: BRIEF, state: 'awaiting_transcript', autopilot: null }, 201);
      if (url === `/api/briefs/${BRIEF}`) return ok(briefView({ status: 'awaiting_transcript', version: null, checks: null }));
      throw new Error(url);
    };
    const dialog = await openSheet();
    await waitFor(() => expect((within(dialog).getByRole('button', { name: 'Load sample: DM screenshot' }) as HTMLButtonElement).disabled).toBe(false));
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'Load sample: DM screenshot' })); });
    await waitFor(() => expect(within(dialog).getByAltText('Screenshot to read')).toBeTruthy());
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'Add request' })); });
    const body = posts[0]!.body as { source: string; image: { mime: string; base64: string }; fixture: string };
    expect(body).toMatchObject({ source: 'screenshot', clientId: NORTHWIND, assetId: MORNING, fixture: 'demo-dm', image: { mime: 'image/png' } });
    expect(body.image.base64.length).toBeGreaterThan(0);
    const card = await within(dialog).findByRole('region', { name: 'Request added' });
    expect(within(card).getByText('No price yet')).toBeTruthy();
    expect(within(card).getByRole('link', { name: 'Confirm the transcript' }).getAttribute('href')).toBe(`/deals/${BRIEF}`);
  });
});

// review B7C phase 1 findings 2, 6 and 7: the sent sentence, "Not sure", the read-back status over a null autopilot, 5 MB.
describe('Add client request sheet: review phase 1 fixes', () => {
  const activeVersion = (status: string) => ({
    ...briefView({}).version!, status: 'pending', totalCents: 42000, sendState: status === 'sending' ? 'sending' : 'idle',
    policy: { pass: true, hardBlock: false, evaluatedAt: iso, mode: 'autopilot', results: [{ rule: 'R1', pass: true, code: 'client_allowed', message: 'ok' }] },
  });
  async function submitPrint(intake: Record<string, unknown>, view: BriefView) {
    routes = (url) => {
      if (url === '/api/intake') return ok({ ok: true, briefId: BRIEF, state: 'extracted', ...intake }, 201);
      if (url === `/api/briefs/${BRIEF}`) return ok(view);
      throw new Error(url);
    };
    const dialog = await openSheet();
    await waitFor(() => expect((within(dialog).getByRole('button', { name: 'Load sample: Print add-on' }) as HTMLButtonElement).disabled).toBe(false));
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'Load sample: Print add-on' })); });
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'Add request' })); });
    return within(dialog).findByRole('region', { name: 'Request added' });
  }

  it('autopilot sent: names the client email and says PayPal has the invoice', async () => {
    const card = await submitPrint({ autopilot: 'sent' }, briefView({ status: 'invoiced', version: activeVersion('invoiced') as BriefView['version'] }));
    expect(within(card).getByText('The invoice was sent to buying@northwind.example through PayPal.')).toBeTruthy();
  });

  it('autopilot null (it threw) never says "Nothing was sent." once the deal has a quote', async () => {
    let card = await submitPrint({ autopilot: null }, briefView({ status: 'invoiced', version: activeVersion('invoiced') as BriefView['version'] }));
    expect(card.textContent).not.toContain('Nothing was sent');
    expect(within(card).getByText('The invoice was sent to buying@northwind.example through PayPal.')).toBeTruthy();
    cleanup();
    card = await submitPrint({ autopilot: null }, briefView({ status: 'sending', version: activeVersion('sending') as BriefView['version'] }));
    expect(card.textContent).not.toContain('Nothing was sent');
    expect(within(card).getByText(/The invoice is being sent to buying@northwind\.example through PayPal\./)).toBeTruthy();
    cleanup();
    card = await submitPrint({ autopilot: null }, briefView({ status: 'ready', version: activeVersion('ready') as BriefView['version'] }));
    expect(card.textContent).not.toContain('Nothing was sent');
    expect(within(card).getByText('Check the deal before trying again.')).toBeTruthy();
  });

  it('"Nothing was sent." only when the deal has no quote', async () => {
    const card = await submitPrint({ state: 'needs_creator', autopilot: null }, briefView({ status: 'needs_creator', version: null }));
    expect(within(card).getByText('Nothing was sent.')).toBeTruthy();
  });

  it('"Not sure" posts the unknown sender and shows the result card', async () => {
    Element.prototype.hasPointerCapture ??= () => false;
    Element.prototype.releasePointerCapture ??= () => {};
    Element.prototype.scrollIntoView ??= () => {};
    routes = (url) => {
      if (url === '/api/intake') return ok({ ok: true, briefId: BRIEF, state: 'extracted', autopilot: null }, 201);
      if (url === `/api/briefs/${BRIEF}`) return ok(briefView({ status: 'needs_creator', reasons: ['unknown_sender'], client: null, version: null }));
      throw new Error(url);
    };
    const dialog = await openSheet();
    await waitFor(() => expect((within(dialog).getByRole('button', { name: 'Load sample: Print add-on' }) as HTMLButtonElement).disabled).toBe(false));
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'Load sample: Print add-on' })); });
    const client = within(dialog).getByRole('combobox', { name: 'Client' });
    await act(async () => { fireEvent.keyDown(client, { key: 'Enter' }); });
    await act(async () => { fireEvent.click(await screen.findByRole('option', { name: 'Not sure (unknown sender)' })); });
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'Add request' })); });
    expect(posts[0]!.body.clientId).toBe('unknown');
    const card = await within(dialog).findByRole('region', { name: 'Request added' });
    expect(within(card).getByText(/Unknown sender/)).toBeTruthy();
    expect(within(card).getByRole('link', { name: 'Open the deal room' }).getAttribute('href')).toBe(`/deals/${BRIEF}`);
  });

  it('a screenshot over 5 MB is refused before anything is read or posted', async () => {
    routes = (url) => { throw new Error(url); };
    const dialog = await openSheet();
    await act(async () => { fireEvent.click(within(dialog).getByRole('radio', { name: 'Screenshot' })); });
    const big = new File([new Uint8Array(MAX_SCREENSHOT_BYTES + 1)], 'big.png', { type: 'image/png' });
    await act(async () => { fireEvent.change(within(dialog).getByLabelText(/Screenshot \(PNG, JPEG or WebP/), { target: { files: [big] } }); });
    expect(within(dialog).getByText(TOO_BIG)).toBeTruthy();
    expect(within(dialog).queryByAltText('Screenshot to read')).toBeNull();
    expect(posts).toEqual([]);
  });
});

// review B7C phase 1 findings 1, 2, 3, 4 and 5.
describe('review phase 1 fixes', () => {
  const clientBox = (d: HTMLElement) => within(d).getByRole('combobox', { name: 'Client' });
  const photoBox = (d: HTMLElement) => within(d).getByRole('combobox', { name: 'Photo' });
  async function loadSample(dialog: HTMLElement, name: string) {
    await waitFor(() => expect((within(dialog).getByRole('button', { name: `Load sample: ${name}` }) as HTMLButtonElement).disabled).toBe(false));
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: `Load sample: ${name}` })); });
  }

  it('1: "Add another request" clears the client and photo, so nothing goes to the last recipient', async () => {
    routes = (url) => {
      if (url === '/api/intake') return ok({ ok: true, briefId: BRIEF, state: 'extracted', autopilot: 'needs_approval' }, 201);
      if (url === `/api/briefs/${BRIEF}`) return ok(briefView({}));
      throw new Error(url);
    };
    const dialog = await openSheet();
    await loadSample(dialog, 'Billboard ask');
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'Add request' })); });
    await act(async () => { fireEvent.click(await within(dialog).findByRole('button', { name: 'Add another request' })); });
    fireEvent.change(within(dialog).getByLabelText('Client’s message'), { target: { value: 'A different client asks for web use.' } });
    expect((within(dialog).getByRole('button', { name: 'Add request' }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(dialog).getByText('Pick the client and the photo.')).toBeTruthy();
    expect(clientBox(dialog).textContent).toContain('Pick the client');
    expect(photoBox(dialog).textContent).toContain('Pick the photo');
    expect(posts).toHaveLength(1);
  });

  it('1: a sample whose client and photo are missing clears an earlier pick', async () => {
    currentOptions = { ...options, clients: [{ id: NORTHWIND, name: 'Northwind Coffee', email: 'buying@northwind.example', allowed: true }], assets: [{ id: MORNING, title: 'Morning Pour', is_public: true }] };
    const dialog = await openSheet();
    await loadSample(dialog, 'Billboard ask'); // picks Northwind and Morning Pour
    expect(photoBox(dialog).textContent).toContain('Morning Pour');
    await loadSample(dialog, 'New photo, social'); // Harbor Light is not in the options
    expect(photoBox(dialog).textContent).toContain('Pick the photo');
    expect((within(dialog).getByRole('button', { name: 'Add request' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('2: sample notes describe the message and never promise approval', () => {
    for (const s of SAMPLES) {
      expect(s.expect).not.toMatch(/always asks|waits in Ask me\.|within your limits|so it may be sent/);
      // B11 item 1: the paid sample has no price and cannot send, whatever the settings.
      if (s.source === 'paste' && s.key !== 'paid') {
        expect(s.expect).toContain('depends on your current settings');
        expect(s.expect).toContain('If every rule passes, UseRight may send a PayPal invoice to buying@northwind.example with no other click.');
      }
    }
  });

  it('3: when the read-back fails, the card says the details are unavailable, not "Unknown sender" or "No price yet"', async () => {
    routes = (url) => {
      if (url === '/api/intake') return ok({ ok: true, briefId: BRIEF, state: 'extracted', autopilot: 'skipped' }, 201);
      if (url === `/api/briefs/${BRIEF}`) return ok({ error: 'boom' }, 500);
      throw new Error(url);
    };
    const dialog = await openSheet();
    await loadSample(dialog, 'Print add-on');
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'Add request' })); });
    const card = await within(dialog).findByRole('region', { name: 'Request added' });
    expect(within(card).getByText(/Couldn’t load this deal’s details/)).toBeTruthy();
    for (const wrong of ['Unknown sender', 'no photo picked', 'No price yet', 'Nothing was sent']) expect(card.textContent).not.toContain(wrong);
    expect(within(card).getByText('Check the deal before trying again.')).toBeTruthy();
    expect(within(card).getByRole('link', { name: 'Open the deal room' }).getAttribute('href')).toBe(`/deals/${BRIEF}`);
  });

  it('3: "skipped" while the deal is sending reads as being sent', async () => {
    routes = (url) => {
      if (url === '/api/intake') return ok({ ok: true, briefId: BRIEF, state: 'extracted', autopilot: 'skipped' }, 201);
      if (url === `/api/briefs/${BRIEF}`) return ok(briefView({ status: 'sending' }));
      throw new Error(url);
    };
    const dialog = await openSheet();
    await loadSample(dialog, 'Print add-on');
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'Add request' })); });
    const card = await within(dialog).findByRole('region', { name: 'Request added' });
    expect(within(card).getByText(/The invoice is being sent to buying@northwind\.example through PayPal\./)).toBeTruthy();
    expect(card.textContent).not.toContain('Nothing was sent');
  });

  it('5: a hard block links to the deal to fix it and never offers typed approval', async () => {
    const blocked = briefView({});
    blocked.version!.policy = { ...blocked.version!.policy!, hardBlock: true, results: [{ rule: 'EMAIL', pass: false, code: 'no_client_email', message: 'The client has no email address.' }] };
    routes = (url) => {
      if (url === '/api/intake') return ok({ ok: true, briefId: BRIEF, state: 'extracted', autopilot: 'needs_approval' }, 201);
      if (url === `/api/briefs/${BRIEF}`) return ok(blocked);
      throw new Error(url);
    };
    const dialog = await openSheet();
    await loadSample(dialog, 'Billboard ask');
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'Add request' })); });
    const card = await within(dialog).findByRole('region', { name: 'Request added' });
    expect(within(card).getByRole('link', { name: 'Open the deal to fix it' }).getAttribute('href')).toBe(`/deals/${BRIEF}`);
    expect(within(card).getByText(/It cannot be approved as it is, so nothing was sent\./)).toBeTruthy();
    expect(card.textContent).not.toMatch(/typed approval|Open Ask me/);
  });

  it('4: demo invoices are never counted as live invoices out', () => {
    const demoOnly = dealsNextSteps([deal({ status: 'invoiced', briefId: 'd', gapTotalCents: 40000, demo: true })]);
    expect(demoOnly.map((s) => s.text)).toEqual(['Demo: 1 seeded invoice is shown as unpaid: $400.00. PayPal never saw it']);
    const mixed = dealsNextSteps([
      deal({ status: 'invoiced', briefId: 'l', gapTotalCents: 42000 }),
      deal({ status: 'invoiced', briefId: 'd', gapTotalCents: 40000, demo: true }),
    ]);
    expect(mixed.map((s) => [s.text, s.href])).toEqual([
      ['1 invoice is out, waiting for the client to pay: $420.00', '/deals/l'],
      ['Demo: 1 seeded invoice is shown as unpaid: $400.00. PayPal never saw it', '/deals/d'],
    ]);
  });
});

const deal = (over: Partial<DealRow>): DealRow => ({
  briefId: BRIEF, client: { id: 'c', name: 'Northwind Coffee' }, asset: { id: 'a', title: 'Morning Pour' }, source: 'paste',
  status: 'ready', reasons: [], gapTotalCents: 30000, paypalInvoiceId: null, demo: false, createdAt: iso as unknown as Date, ...over,
});

describe('next-step banners', () => {
  it('Deals: approvals first, with the server totals listed, then the other waits', () => {
    const steps = dealsNextSteps([
      deal({ status: 'invoiced', briefId: 'i', gapTotalCents: 40000 }),
      deal({ status: 'needs_approval', briefId: 'a', gapTotalCents: 90000 }),
      deal({ status: 'awaiting_transcript', briefId: 't', gapTotalCents: null }),
    ]);
    expect(steps.map((s) => [s.text, s.href, s.action])).toEqual([
      ['1 quote the rules stopped needs your review: $900.00', '/ask', 'Review'],
      ['1 screenshot needs you to check who said what', '/deals/t', 'Confirm transcript'],
      ['1 invoice is out, waiting for the client to pay: $400.00', '/deals/i', 'See invoice'],
    ]);
    expect(dealsNextSteps([deal({ status: 'paid' })])).toEqual([]);
  });

  it('Ask me: open quotes, hard blocks and payment problems', () => {
    const item: AskItem = { briefId: 'b', versionId: 'v1', versionNo: 2, client: { name: 'N', email: 'n@x.example' }, asset: { title: 'M' }, scope: 's', totalCents: 90000, failing: [], hardBlock: false, sendError: null, createdAt: iso as unknown as Date };
    const steps = askNextSteps([item, { ...item, versionId: 'v2', hardBlock: true }], [{ eventId: 'e', kind: 'refund_partial', briefId: null, message: 'm', createdAt: iso as unknown as Date, demo: false }]);
    expect(steps.map((s) => s.text)).toEqual([
      '1 quote waits for your typed approval: $900.00',
      '1 quote needs a change in the deal before it can be approved',
      '1 payment problem needs you',
    ]);
    expect(steps[0]!.href).toBe('#quote-v1');
  });
});

describe('help and share', () => {
  it('"What happens here?" opens fixed help text', () => {
    render(<HelpPanel id="x"><p>Fixed help.</p></HelpPanel>);
    expect(screen.queryByText('Fixed help.')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'What happens here?' }));
    expect(screen.getByText('Fixed help.')).toBeTruthy();
  });

  it('Share request page copies the public link and says what clients can do there', async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    render(<SharePage slug="imani" />);
    fireEvent.click(screen.getByRole('button', { name: 'Share request page' }));
    expect(screen.getByText(/Clients can request a licence themselves on your public page\./)).toBeTruthy();
    // review B7C-1 finding 1: no email reaches the client today, so the panel must not promise one.
    expect(screen.getByText(/Their request shows up in Deals right away, marked Waiting for email confirmation\. Open it to send them the confirm link\./)).toBeTruthy();
    expect(document.body.textContent).not.toContain('after they confirm their email');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Copy link' })); });
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/c/imani`);
    expect(screen.getByText('Link copied.')).toBeTruthy();
  });
});
