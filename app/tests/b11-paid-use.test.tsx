// B11 item 1: a paid-promotion request cannot be priced, so nothing can sell it as plain social. Real route handlers on
// PGlite with PayPal mocked. Nobody has clicked this in a browser.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { POST as intakePOST } from '@/app/api/intake/route';
import { GET as briefGET, PATCH as briefPATCH } from '@/app/api/briefs/[id]/route';
import { POST as decidePOST } from '@/app/api/briefs/[id]/decide/route';
import { DealRoomView } from '@/components/creator/deal-room';
import { DealsTable } from '@/components/creator/deals-table';
import { STATUS_MEANING, PAID_USE_MEANING } from '@/components/creator/explain';
import { RequestResult } from '@/components/creator/request-sheet';
import { SAMPLES } from '@/components/creator/request-samples';
import { openPglite, type Db } from '../db/client';
import { initialize } from '../db/init';
import type { BriefView } from '../lib/briefs';
import { TRIPWIRES } from '../lib/checks';
import { listDeals } from '../lib/deals';
import { PAID_PROMO_TRIPWIRES, PAID_USE_REFUSAL } from '../lib/reasons';
import { setRouteDepsForTests } from '../lib/server';
import { mockInvoiceApi } from './helpers/mock-paypal';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => {}, refresh: () => {} }), usePathname: () => '/deals', useSearchParams: () => new URLSearchParams() }));

const TOKEN = 'b11-paid-use-token';
let db: Db;
let dir: string;
let ids: { clients: Record<string, string>; assets: Record<string, string> };
const saved = { token: process.env.CREATOR_TOKEN, origin: process.env.APP_ORIGIN };
const headers = { host: 'app.test', origin: 'http://app.test', cookie: `ur_creator=${TOKEN}`, 'content-type': 'application/json' };
const params = (id: string) => ({ params: Promise.resolve({ id }) });

beforeAll(async () => {
  db = await openPglite();
  dir = await mkdtemp(join(tmpdir(), 'ur-b11-'));
  await initialize(db, dir);
  process.env.CREATOR_TOKEN = TOKEN;
  delete process.env.APP_ORIGIN;
  setRouteDepsForTests({ db, uploadsDir: dir, invoices: mockInvoiceApi().api });
  const clients = await db.query<{ id: string; email: string }>(`select id, email from clients`);
  const assets = await db.query<{ id: string; title: string }>(`select id, title from assets`);
  ids = { clients: Object.fromEntries(clients.map((c) => [c.email, c.id])), assets: Object.fromEntries(assets.map((a) => [a.title, a.id])) };
});
afterAll(async () => {
  setRouteDepsForTests(null);
  if (saved.token === undefined) delete process.env.CREATOR_TOKEN; else process.env.CREATOR_TOKEN = saved.token;
  if (saved.origin !== undefined) process.env.APP_ORIGIN = saved.origin;
  await db?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

async function submit(key: string, text?: string) {
  const s = SAMPLES.find((x) => x.key === key)!;
  const body = { source: 'paste', clientId: ids.clients[s.clientEmail], assetId: ids.assets[s.assetTitle], text: text ?? s.text, fixture: s.fixture };
  const res = await intakePOST(new Request('http://app.test/api/intake', { method: 'POST', headers, body: JSON.stringify(body) }));
  expect(res.status).toBe(201);
  return ((await res.json()) as { briefId: string }).briefId;
}
const view = async (id: string) => (await (await briefGET(new Request(`http://app.test/api/briefs/${id}`, { headers }), params(id))).json()) as BriefView;
const decide = (id: string, body: object) => decidePOST(new Request(`http://app.test/api/briefs/${id}/decide`, { method: 'POST', headers, body: JSON.stringify(body) }), params(id));
const versions = (id: string) => db.query(`select 1 from licence_versions where brief_id = $1`, [id]);
const invoices = (id: string) => db.query(`select 1 from invoices i join licence_versions v on v.id = i.version_id where v.brief_id = $1`, [id]);
const actions = { onEdit: () => {}, onConfirm: () => {}, onDecide: () => {}, onCopy: () => {}, onError: () => {} };

describe('paid use is refused, everything else is not', () => {
  it('approve: 409 paid_use_unpriced and no version created', async () => {
    const id = await submit('paid');
    const res = await decide(id, { action: 'approve', typedTotal: '300.00' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'paid_use_unpriced', error: PAID_USE_REFUSAL });
    expect(await versions(id)).toEqual([]);
    expect(await invoices(id)).toEqual([]);
  });

  it('Retry cannot make a quote on this stop either', async () => {
    const id = await submit('paid');
    expect((await decide(id, { action: 'retry' })).status).toBe(409);
    expect(await versions(id)).toEqual([]);
  });

  it('Reject, the one thing offered, works with no quote and charges nothing', async () => {
    const id = await submit('paid');
    expect((await decide(id, { action: 'reject' })).status).toBe(200);
    const v = await view(id);
    expect(v.status).toBe('rejected');
    expect(await versions(id)).toEqual([]);
    const row = (await listDeals(db, v.brief.creator_id)).find((d) => d.briefId === id)!;
    expect(renderToStaticMarkup(<DealsTable deals={[row]} />)).toContain('Not charged');
    // Click review 10: this deal has no price and no rules to point at.
    expect(renderToStaticMarkup(<DealRoomView view={v} options={null} busy={false} actions={actions} />)).not.toContain('below the price and rules');
  });

  it('PATCH: the Setup save leaves the deal needs_creator with no invoice row', async () => {
    const id = await submit('paid');
    const v = await view(id);
    const uses = v.checks!.kept.map((k) => ({ optionId: k.optionId, quote: k.quote }));
    expect(uses.length).toBeGreaterThan(0);
    const res = await briefPATCH(new Request(`http://app.test/api/briefs/${id}`, { method: 'PATCH', headers, body: JSON.stringify({ uses }) }), params(id));
    expect(res.status).toBe(200);
    const after = (await res.json()) as BriefView;
    expect(after.status).toBe('needs_creator');
    expect(after.extraction!.model).toBe('creator_edit');
    expect(await versions(id)).toEqual([]);
    expect(await invoices(id)).toEqual([]);
  });

  it('another tripwire is still approvable', async () => {
    // "worldwide" on a US social fixture: tripwire:worldwide, not paid promotion. Rate card, typed total, invoice as before.
    const id = await submit('social', "Hi, this is Northwind Coffee. We'd like to license the Harbor Light photo for our social media in the US for six months. We may go worldwide later.");
    const v = await view(id);
    expect(v.status).toBe('needs_creator');
    expect(v.reasons).toContain('tripwire:worldwide');
    const res = await decide(id, { action: 'approve', typedTotal: (v.gapPreview!.totalCents / 100).toFixed(2) });
    expect(res.status).toBe(200);
    expect(await invoices(id)).toHaveLength(1);
  });

  it('the billboard is still approvable', async () => {
    const id = await submit('billboard');
    const v = await view(id);
    expect(v.status).toBe('needs_approval');
    expect(v.version!.totalCents).toBe(90000);
    expect((await decide(id, { action: 'approve', typedTotal: '900.00' })).status).toBe(200);
    expect(await invoices(id)).toHaveLength(1);
  });

  it('the list of words matches the tripwire table', () => {
    for (const { word } of PAID_PROMO_TRIPWIRES) expect(TRIPWIRES.some((t) => t.word === word && t.cover.kind === 'never')).toBe(true);
  });

  it('a new paid term added in the one place is a tripwire and cannot be reviewed away', async () => {
    vi.resetModules();
    const reasons = await import('../lib/reasons');
    reasons.PAID_PROMO_TRIPWIRES.push({ word: 'promo push', pattern: /\bpromo push\b/i });
    const { runChecks, TRIPWIRES: table } = await import('../lib/checks');
    const { pasteToTranscript } = await import('../lib/intake');
    expect(table.some((t) => t.word === 'promo push' && t.cover.kind === 'never')).toBe(true);
    const r = runChecks({
      transcript: pasteToTranscript("We'd like the photo for social media in the US for six months, with a promo push.", true),
      extraction: { uses: [], clarifyingQuestion: null },
      current: null,
      reviewedByCreator: true,
    });
    expect(r.reasons).toContain('tripwire:promo push');
    expect(r.notes).not.toContain('tripwire:promo push');
    expect(reasons.hasPaidUse(r.reasons)).toBe(true);
    vi.resetModules();
  });

  it('other tripwires stay reviewable', async () => {
    const { runChecks } = await import('../lib/checks');
    const { pasteToTranscript } = await import('../lib/intake');
    const r = runChecks({ transcript: pasteToTranscript('We might go worldwide later.', true), extraction: { uses: [], clarifyingQuestion: null }, current: null, reviewedByCreator: true });
    expect(r.notes).toContain('tripwire:worldwide');
  });
});

describe('no $300 shows on this stop', () => {
  it('deal room, Request added card, Deals Due column and status tip', async () => {
    const id = await submit('paid');
    const v = await view(id);
    expect(v.gapPreview).toBeNull();
    expect(v.licence).toBeNull(); // first licence, so no earlier $300 can appear

    const room = renderToStaticMarkup(<DealRoomView view={v} options={null} busy={false} actions={actions} />);
    expect(room).not.toContain('$300');
    expect(room).not.toContain('Approve and send');
    expect(room).not.toContain('price-title');
    expect(room).not.toContain('The price is');
    expect(room).not.toContain('tripwire:');
    expect(room).toContain(PAID_USE_REFUSAL);
    expect(room).toContain('Reject');
    expect(room).toContain('The client mentioned');

    const card = renderToStaticMarkup(<RequestResult result={{ posted: { briefId: id, state: 'extracted', autopilot: null }, view: v }} onAnother={() => {}} onLeave={() => {}} />);
    expect(card).not.toContain('$300');
    expect(card).toContain('No price yet');

    const row = (await listDeals(db, v.brief.creator_id)).find((d) => d.briefId === id)!;
    expect(row.gapTotalCents).toBeNull();
    const table = renderToStaticMarkup(<DealsTable deals={[row]} />);
    expect(table).not.toContain('$300');

    // Overview's unpaid list only takes invoiced deals, and reads the same gapTotalCents.
    expect(row.status).not.toBe('invoiced');
    expect(JSON.stringify(PAID_USE_MEANING)).not.toContain('$');
    expect(STATUS_MEANING.needs_creator!.next).toContain('carries on');
    expect(PAID_USE_MEANING.next).not.toContain('carries on');
    expect(SAMPLES.find((s) => s.key === 'paid')!.expect).not.toMatch(/may send|\$/i);
  });
});
