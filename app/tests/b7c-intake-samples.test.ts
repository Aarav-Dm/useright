// Batch 7C phase 1: the sheet's sample messages through the real POST /api/intake and GET /api/briefs/:id on the
// demo seed, with PayPal mocked. Proves the samples do what the sheet tells the creator to expect.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { POST as intakePOST } from '@/app/api/intake/route';
import { GET as briefGET } from '@/app/api/briefs/[id]/route';
import { SAMPLES } from '@/components/creator/request-samples';
import { openPglite, type Db } from '../db/client';
import { initialize } from '../db/init';
import type { BriefView } from '../lib/briefs';
import { setRouteDepsForTests } from '../lib/server';
import { mockInvoiceApi } from './helpers/mock-paypal';

const TOKEN = 'b7c-intake-samples-token';
let db: Db;
let dir: string;
let ids: { clients: Record<string, string>; assets: Record<string, string> };
const saved = { token: process.env.CREATOR_TOKEN, origin: process.env.APP_ORIGIN };
const headers = { host: 'app.test', origin: 'http://app.test', cookie: `ur_creator=${TOKEN}`, 'content-type': 'application/json' };

beforeAll(async () => {
  db = await openPglite();
  dir = await mkdtemp(join(tmpdir(), 'ur-b7c-'));
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

async function submit(key: string) {
  const s = SAMPLES.find((x) => x.key === key)!;
  const body = { source: 'paste', clientId: ids.clients[s.clientEmail], assetId: ids.assets[s.assetTitle], text: s.text, fixture: s.fixture };
  const res = await intakePOST(new Request('http://app.test/api/intake', { method: 'POST', headers, body: JSON.stringify(body) }));
  expect(res.status).toBe(201);
  const posted = await res.json() as { briefId: string; autopilot: string | null };
  const v = await briefGET(new Request(`http://app.test/api/briefs/${posted.briefId}`, { headers }), { params: Promise.resolve({ id: posted.briefId }) });
  return { posted, view: (await v.json()) as BriefView };
}

describe('sheet samples through the real intake route', () => {
  it('Billboard ask: $900 quote stopped by the rules, nothing sent', async () => {
    const { posted, view } = await submit('billboard');
    expect(posted.autopilot).toBe('needs_approval');
    expect(view.status).toBe('needs_approval');
    expect(view.version!.totalCents).toBe(90000);
    expect(view.version!.invoice).toBeNull();
  });

  it('Print add-on: $420 within the limits, so autopilot sends it (PayPal mocked)', async () => {
    const { posted, view } = await submit('print');
    expect(posted.autopilot).toBe('sent');
    expect(view.status).toBe('invoiced');
    expect(view.version!.totalCents).toBe(42000);
  });

  it('B9 9.3 Paid ads ask: flagged for the creator, no price line added, nothing sent', async () => {
    const { posted, view } = await submit('paid');
    expect(posted.autopilot).toBeNull();
    expect(view.status).toBe('needs_creator');
    expect(view.extraction!.reasons).toEqual(expect.arrayContaining(['tripwire:boost', 'tripwire:paid ads']));
    expect(view.version?.invoice ?? null).toBeNull();
    const card = await db.query<{ option_id: string }>(`select option_id from rate_card_options where option_id ilike '%paid%'`);
    expect(card).toEqual([]);
  });

  it('New photo, social: a $300 first licence', async () => {
    const { view } = await submit('social');
    expect(view.version!.totalCents).toBe(30000);
    expect(view.version!.versionNo).toBe(1);
  });
});
