// @vitest-environment jsdom
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { POST as intakePOST } from '@/app/api/intake/route';
import { POST as emailPOST } from '@/app/api/verify/[token]/route';
import { POST as pagePOST } from '@/app/api/verify/[token]/page/route';
import { POST as askPOST } from '@/app/api/ask/route';
import { PATCH as editPATCH } from '@/app/api/briefs/[id]/route';
import { RequestDrawer } from '@/components/client/request-drawer';
import { GapTable } from '@/components/creator/licence';
import { renderToStaticMarkup } from 'react-dom/server';
import { SAMPLES } from '@/components/creator/request-samples';
import { openPglite, type Db } from '@/db/client';
import { initialize } from '@/db/init';
import { createAdapter, fixtureProvider } from '@/lib/ai/extract';
import { issueVerifyLink } from '@/lib/intake';
import { listAsk } from '@/lib/ledger';
import { getBriefView } from '@/lib/briefs';
import { setRouteDepsForTests } from '@/lib/server';
import { hashToken } from '@/lib/tokens';
import { mockInvoiceApi } from './helpers/mock-paypal';

vi.mock('@/components/client/motion-pref', () => ({ useReduce: () => true }));
let db: Db;
let dir: string;
let m: ReturnType<typeof mockInvoiceApi>;
let creatorId: string;
let assetId: string;
let ip = 1;
const ctx = (token: string) => ({ params: Promise.resolve({ token }) });
const env = { token: process.env.CREATOR_TOKEN, origin: process.env.APP_ORIGIN };
const headers = { host: 'app.test', origin: 'http://app.test', 'content-type': 'application/json' };
const creatorHeaders = { ...headers, cookie: 'ur_creator=b13-test-creator' };
const text = SAMPLES.find((s) => s.key === 'social')!.text!;
const req = (url: string, body?: unknown, address = `198.51.100.${ip++}`) => new Request(`http://app.test${url}`, { method: 'POST', headers: { ...headers, 'x-forwarded-for': address }, body: JSON.stringify(body ?? {}) });
const writes = () => m.calls.filter((c) => c.op === 'create' || c.op === 'send');

beforeAll(async () => {
  db = await openPglite();
  dir = await mkdtemp(join(tmpdir(), 'ur-b13-confirm-'));
  const seeded = await initialize(db, dir);
  creatorId = seeded.seed.creatorId;
  const [asset] = await db.query<{ id: string }>(`select id from assets where title = 'Harbor Light'`);
  assetId = asset!.id;
  m = mockInvoiceApi();
  process.env.CREATOR_TOKEN = 'b13-test-creator';
  delete process.env.APP_ORIGIN;
  setRouteDepsForTests({ db, uploadsDir: dir, invoices: m.api, aiFor: () => createAdapter(fixtureProvider('paste')) });
  await db.query(`update creator_settings set per_deal_cap_cents = 50000, daily_max_sends = 100, rolling30_cap_cents = 1000000`);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); m.reset(); });
afterAll(async () => {
  setRouteDepsForTests(null);
  if (env.token === undefined) delete process.env.CREATOR_TOKEN; else process.env.CREATOR_TOKEN = env.token;
  if (env.origin === undefined) delete process.env.APP_ORIGIN; else process.env.APP_ORIGIN = env.origin;
  await db?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

async function start(onPage = true, address?: string) {
  const res = await intakePOST(req('/api/intake', { source: 'portfolio', assetId, email: 'buying@northwind.example', text, confirmOnPage: onPage }, address));
  expect(res.status).toBe(201);
  return await res.json() as { briefId: string; confirmation?: { token: string }; state: string };
}

describe('page confirmation trust boundary', () => {
  it('reaches Ask me under the cap, survives creator edits, and sends only after typed approval', async () => {
    const intake = await start();
    expect(intake.state).toBe('awaiting_verification');
    expect(intake.confirmation?.token).toBeTruthy();
    const token = intake.confirmation!.token;
    expect((await emailPOST(req(`/api/verify/${token}`), ctx(token))).status).toBe(400);
    expect((await pagePOST(req(`/api/verify/${token}/page`), ctx(token))).status).toBe(200);
    expect((await pagePOST(req(`/api/verify/${token}/page`), ctx(token))).status).toBe(410);
    let items = (await listAsk(db, creatorId)).filter((i) => i.briefId === intake.briefId);
    expect(items).toHaveLength(1);
    expect(items[0]!.totalCents).toBe(30000);
    expect(items[0]!.hardBlock).toBe(false);
    expect(items[0]!.failing).toEqual([{ rule: 'Identity', code: 'confirmed_on_page', message: 'Confirmed on the page, not by email. This request needs your approval.' }]);
    expect(writes()).toEqual([]);
    expect(await db.query(`select 1 from invoices i join licence_versions v on v.id = i.version_id where v.brief_id = $1`, [intake.briefId])).toEqual([]);
    const [client] = await db.query<{ id: string; allowed: boolean }>(`select id, allowed from clients where email = 'buying@northwind.example'`);
    expect(client!.allowed).toBe(true);
    const edited = await editPATCH(new Request(`http://app.test/api/briefs/${intake.briefId}`, { method: 'PATCH', headers: creatorHeaders, body: JSON.stringify({ clientId: client!.id }) }), { params: Promise.resolve({ id: intake.briefId }) });
    expect(edited.status).toBe(200);
    expect(writes()).toEqual([]);
    items = (await listAsk(db, creatorId)).filter((i) => i.briefId === intake.briefId);
    expect(items[0]!.failing.some((r) => r.code === 'confirmed_on_page')).toBe(true);
    const approved = await askPOST(new Request('http://app.test/api/ask', { method: 'POST', headers: creatorHeaders, body: JSON.stringify({ versionId: items[0]!.versionId, action: 'approve', typedTotal: '300.00' }) }));
    expect(approved.status).toBe(200);
    expect(writes()).toHaveLength(2);
  });

  it('keeps emailed-link behavior and does not let page confirmation consume an email token', async () => {
    const intake = await start(false);
    expect(intake.confirmation).toBeUndefined();
    const link = await issueVerifyLink(db, creatorId, intake.briefId);
    if (!link.ok) throw new Error(link.error);
    const token = link.url.split('/').pop()!;
    expect((await pagePOST(req(`${link.url}/page`), ctx(token))).status).toBe(400);
    const email = await emailPOST(req(link.url), ctx(token));
    expect(email.status).toBe(200);
    expect(await email.json()).toMatchObject({ verified: true });
    expect(writes()).toHaveLength(2);
  });

  it('retains origin, expiry, replay and per-address intake limits', async () => {
    const intake = await start();
    const token = intake.confirmation!.token;
    const cross = new Request(`http://app.test/api/verify/${token}/page`, { method: 'POST', headers: { ...headers, origin: 'https://other.test' } });
    expect((await pagePOST(cross, ctx(token))).status).toBe(403);
    await db.query(`update email_verifications set expires_at = now() - interval '1 second' where token = $1`, [hashToken(token)]);
    expect((await pagePOST(req(`/api/verify/${token}/page`), ctx(token))).status).toBe(410);
    for (let n = 0; n < 5; n++) await start(true, '192.0.2.80');
    const limited = await intakePOST(req('/api/intake', { source: 'portfolio', assetId, email: 'buyer@example.com', text, confirmOnPage: true }, '192.0.2.80'));
    expect(limited.status).toBe(429);
    expect(writes()).toEqual([]);
  });

  it('rate limits confirmation attempts without spending another intake', async () => {
    const token = 'Z'.repeat(43);
    for (let n = 0; n < 20; n++) expect((await pagePOST(req(`/api/verify/${token}/page`, {}, '192.0.2.81'), ctx(token))).status).toBe(404);
    expect((await pagePOST(req(`/api/verify/${token}/page`, {}, '192.0.2.81'), ctx(token))).status).toBe(429);
    expect(writes()).toEqual([]);
  });

  it('existing form requests cannot opt into page confirmation', async () => {
    const res = await intakePOST(req('/api/intake', { source: 'form', creatorSlug: 'imani', assetId, email: 'buying@northwind.example', text, confirmOnPage: true }));
    expect(res.status).toBe(201);
    const saved = await res.json();
    expect(saved.state).toBe('extracted');
    expect(saved.confirmation).toBeUndefined();
    expect((await db.query<{ confirmed_on_page: boolean }>(`select confirmed_on_page from briefs where id = $1`, [saved.briefId]))[0]!.confirmed_on_page).toBe(false);
    expect(writes()).toEqual([]);
  });

  it.each(['paid ads', 'unclear'])('%s requests stay in Deals review with no price or automatic invoice', async (kind) => {
    const sentence = `We want social media in the US for six months${kind === 'paid ads' ? ' as paid ads' : ''}.`;
    const ai = createAdapter({ model: 'test-unclear', complete: async () => JSON.stringify({
      uses: ['social', 'US', '6mo'].map((optionId) => ({ optionId, quote: sentence })),
      suggestedPriceCents: 12345, clarifyingQuestion: kind === 'unclear' ? 'Which campaign is this for?' : null,
    }) });
    setRouteDepsForTests({ db, uploadsDir: dir, invoices: m.api, aiFor: () => ai });
    try {
      const res = await intakePOST(req('/api/intake', { source: 'portfolio', assetId, email: 'buying@northwind.example', text: sentence, confirmOnPage: true }));
      expect(res.status).toBe(201);
      const saved = await res.json();
      const token = saved.confirmation.token;
      expect((await pagePOST(req(`/api/verify/${token}/page`), ctx(token))).status).toBe(200);
      const view = (await getBriefView(db, saved.briefId))!;
      expect(view.status).toBe(kind === 'unclear' ? 'clarify' : 'needs_creator');
      expect(view.version).toBeNull();
      expect(view.gapPreview).toBeNull();
      expect(renderToStaticMarkup(<GapTable view={view} />)).not.toContain('$');
      expect((await listAsk(db, creatorId)).some((i) => i.briefId === saved.briefId)).toBe(false);
      expect(writes()).toEqual([]);
    } finally { setRouteDepsForTests({ db, uploadsDir: dir, invoices: m.api, aiFor: () => createAdapter(fixtureProvider('paste')) }); }
  });

  it('the real drawer waits for Confirm and uses the creator record name', async () => {
    await db.query(`update creators set name = 'Avery Chen' where id = $1`, [creatorId]);
    const [creator] = await db.query<{ name: string }>(`select name from creators where id = $1`, [creatorId]);
    const photo = { num: '01', title: 'Harbor Light', assetId, alt: 'Harbor', src: '/photo.jpg', width: 1200, height: 800, orientation: 'landscape' as const };
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      const request = req(url, JSON.parse(String(init?.body ?? '{}')));
      if (url === '/api/intake') return intakePOST(request);
      const token = url.split('/')[3]!;
      return pagePOST(request, ctx(token));
    });
    vi.stubGlobal('fetch', fetcher);
    render(<RequestDrawer open photo={photo} photos={[photo]} creatorSlug="imani" creatorName={creator!.name} onClose={() => {}} />);
    expect(screen.getByRole('button', { name: 'Out-of-home' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'TV' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'Not sure yet — confirm by email link' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'buying@northwind.example' } });
    fireEvent.change(screen.getByPlaceholderText(/Where it runs/), { target: { value: text } });
    fireEvent.click(screen.getByRole('button', { name: 'Send request' }));
    expect(await screen.findByRole('button', { name: 'Confirm request' })).toBeTruthy();
    expect(screen.getByText('Send this request to Avery Chen for review. This confirms the request on this page; it does not verify your email. No invoice is sent until Avery Chen approves.')).toBeTruthy();
    expect(screen.getByLabelText('Request summary').textContent).toContain('No. 01');
    expect(screen.getByLabelText('Request summary').textContent).toContain('Harbor Light');
    expect(screen.getByLabelText('Request summary').textContent).toContain('buying@northwind.example');
    expect(screen.getByLabelText('Request summary').textContent).toContain(text);
    expect(screen.queryByText('Request sent')).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm request' }));
    expect(await screen.findByText('Request sent')).toBeTruthy();
    expect(screen.getByText(/Avery Chen has your request/)).toBeTruthy();
    expect(screen.queryByText(/Imani has your request/)).toBeNull();
    expect(writes()).toEqual([]);
  });

  it.each(['link expired', 'link already used'])('a %s response does not falsely claim the request is unconfirmed', async (error) => {
    const photo = { num: '01', assetId, title: 'Harbor Light', alt: 'Harbor', src: '/photo.jpg', width: 1200, height: 800, orientation: 'landscape' as const };
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url === '/api/intake'
      ? new Response(JSON.stringify({ confirmation: { token: 'page-token' } }), { status: 201 })
      : new Response(JSON.stringify({ error }), { status: 410 })));
    render(<RequestDrawer open photo={photo} photos={[photo]} creatorSlug="imani" creatorName="Avery Chen" onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'buyer@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Social' }));
    fireEvent.click(screen.getByRole('button', { name: 'Send request' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm request' }));
    expect((await screen.findByRole('alert')).textContent).toBe('This confirmation expired or was already used. We could not confirm your request in this attempt. Contact Avery Chen before sending another request.');
    expect(screen.queryByText(/your request is not confirmed/)).toBeNull();
    expect(screen.queryByText('Request sent')).toBeNull();
  });
});
