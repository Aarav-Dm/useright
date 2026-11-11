// B12 D2: the read-only JSON door for a buyer's agent (quote, receipt check), through the real route handlers on PGlite.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { GET as quoteGET } from '@/app/api/agent/quote/route';
import { GET as receiptGET } from '@/app/api/agent/receipt/route';
import { openPglite, type Db } from '../db/client';
import { initialize } from '../db/init';
import { AGENT_DOOR_LIMIT_PER_HOUR, verifyReceipt } from '../lib/agent-door';
import { createAdapter, fixtureProvider } from '../lib/ai/extract';
import { creatorCard } from '../lib/briefs';
import { gap } from '../lib/gap';
import { setRouteDepsForTests } from '../lib/server';

let db: Db;
let dir: string;

beforeAll(async () => {
  db = await openPglite();
  dir = await mkdtemp(join(tmpdir(), 'ur-b12d-'));
  await initialize(db, dir);
  setRouteDepsForTests({ db, aiFor: (f) => createAdapter(fixtureProvider(f ?? 'paste')), uploadsDir: dir });
});
afterAll(async () => {
  setRouteDepsForTests(null);
  await db?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

let ip = 1;
const get = async (handler: (r: Request) => Promise<Response>, path: string, from = `203.0.113.${ip++}`) => {
  const res = await handler(new Request(`http://app.test${path}`, { headers: { 'x-forwarded-for': from } }));
  return { status: res.status, body: await res.json() as Record<string, unknown> };
};
const counts = async () => (await db.query<{ v: number; i: number }>(
  `select (select count(*)::int from licence_versions) as v, (select count(*)::int from invoices) as i`))[0];

describe('quote', () => {
  it('prices a named public photo and use from the rate card through gap(), and creates nothing', async () => {
    const before = await counts();
    const r = await get(quoteGET, '/api/agent/quote?photo=morning%20pour&use=social,web&territory=US&months=12');
    expect(r.status).toBe(200);
    const [creator] = await db.query<{ id: string }>(`select id from creators limit 1`);
    const want = gap({ channels: ['social', 'web'], territory: 'US', durationMonths: 12, exclusive: false }, null, 0, await creatorCard(db, creator!.id));
    expect(r.body).toMatchObject({ photo: { title: 'Morning Pour' }, totalCents: want.totalCents, currency: 'USD', invoiced: false });
    expect((r.body.request as { path: string }).path).toBe('/api/intake');
    expect(await counts()).toEqual(before);
  });

  it('paid promotion gets a refusal and no figure', async () => {
    for (const use of ['paid%20ads', 'social,boost', 'spark%20ads']) {
      const r = await get(quoteGET, `/api/agent/quote?photo=Morning%20Pour&use=${use}`);
      expect(r.status).toBe(422);
      expect(r.body.code).toBe('paid_use_unpriced');
      expect(JSON.stringify(r.body)).not.toMatch(/cents|\$|\d+\.\d\d/i);
    }
  });

  it('does not reflect a client email in invalid-use errors', async () => {
    const email = 'private.buyer@example.com';
    const r = await get(quoteGET, `/api/agent/quote?photo=Morning%20Pour&use=${encodeURIComponent(email)}`);
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).not.toContain(email);
  });

  it('refuses unknown uses, territories, durations and private or unknown photos', async () => {
    expect((await get(quoteGET, '/api/agent/quote?photo=Morning%20Pour&use=radio')).status).toBe(400);
    expect((await get(quoteGET, '/api/agent/quote?photo=Morning%20Pour&use=social&territory=MARS')).status).toBe(400);
    expect((await get(quoteGET, '/api/agent/quote?photo=Morning%20Pour&use=social&months=3')).status).toBe(400);
    const [priv] = await db.query<{ title: string }>(`select title from assets where not is_public limit 1`);
    if (priv) expect((await get(quoteGET, `/api/agent/quote?photo=${encodeURIComponent(priv.title)}&use=social`)).status).toBe(404);
    expect((await get(quoteGET, '/api/agent/quote?photo=No%20Such%20Photo&use=social')).status).toBe(404);
  });

  it('is rate limited per IP', async () => {
    for (let n = 0; n < AGENT_DOOR_LIMIT_PER_HOUR; n++) await get(quoteGET, '/api/agent/quote?use=radio', '198.51.100.7');
    expect((await get(quoteGET, '/api/agent/quote?use=radio', '198.51.100.7')).status).toBe(429);
  });

  it('shares the limit across both GETs behind an appending proxy despite forged first hops', async () => {
    for (let n = 0; n < AGENT_DOOR_LIMIT_PER_HOUR; n++) {
      const handler = n % 2 ? receiptGET : quoteGET;
      const path = n % 2 ? `/api/agent/receipt?id=NOPE&sha256=${'0'.repeat(64)}` : '/api/agent/quote?use=radio';
      const r = await get(handler, path, `203.0.113.${n + 1}, 198.51.100.90`);
      expect(r.status).not.toBe(429);
    }
    expect((await get(receiptGET, `/api/agent/receipt?id=NOPE&sha256=${'0'.repeat(64)}`, '192.0.2.3, 198.51.100.90')).status).toBe(429);
  });
});

describe('receipt check', () => {
  it('confirms a receipt by id and file hash, says when the hash differs, and 404s an unknown id', async () => {
    const [r] = await db.query<{ public_id: string; sha: string }>(
      `select public_id, body->'asset'->>'sha256' as sha from receipts where coalesce(body->>'kind', 'grant') = 'grant' limit 1`);
    const ok = await get(receiptGET, `/api/agent/receipt?id=${r!.public_id}&sha256=${r!.sha.toUpperCase()}`);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ receipt: r!.public_id, sha256: r!.sha, sha256Matches: true });
    // Seeded receipts say so, and carry no PayPal proof.
    expect(ok.body).toMatchObject({ demo: true, paypal: null });
    expect((await get(receiptGET, `/api/agent/receipt?id=NOPE&sha256=${r!.sha}`)).status).toBe(404);
    expect((await get(receiptGET, '/api/agent/receipt')).status).toBe(400);
  });

  it('wrong hashes reveal no receipt details and have the same response as an unknown receipt', async () => {
    const [r] = await db.query<{ public_id: string }>(`select public_id from receipts limit 1`);
    const wrong = await get(receiptGET, `/api/agent/receipt?id=${r!.public_id}&sha256=${'0'.repeat(64)}`);
    const unknown = await get(receiptGET, `/api/agent/receipt?id=${'A'.repeat(43)}&sha256=${'0'.repeat(64)}`);
    expect(wrong).toEqual(unknown);
    expect(wrong.status).toBe(404);
    for (const hash of ['', 'not-a-hash']) {
      const invalid = await get(receiptGET, `/api/agent/receipt?id=${r!.public_id}&sha256=${hash}`);
      expect(invalid.status).toBe(400);
      expect(invalid.body).not.toHaveProperty('receipt');
      expect(invalid.body).not.toHaveProperty('photo');
      expect(invalid.body).not.toHaveProperty('paypal');
    }
  });

  it('wrong and token-shaped unknown hashes stop after one narrow query; legacy fileHash still matches', async () => {
    const [r] = await db.query<{ public_id: string; body: Record<string, unknown>; sha: string }>(`select public_id, body, body->'asset'->>'sha256' as sha from receipts limit 1`);
    const spy = vi.spyOn(db, 'query');
    try {
      for (const id of [r!.public_id, 'A'.repeat(43)]) {
        spy.mockClear();
        expect((await verifyReceipt(db, id, '0'.repeat(64))).status).toBe(404);
        expect(spy.mock.calls).toHaveLength(1);
        expect(spy.mock.calls[0]![0]).toContain("body->'asset'");
      }
    } finally { spy.mockRestore(); }
    const legacy = { ...r!.body, kind: undefined, asset: { ...(r!.body.asset as object), sha256: undefined, fileHash: r!.sha } };
    await db.query(`update receipts set body = $2 where public_id = $1`, [r!.public_id, JSON.stringify(legacy)]);
    try { expect((await verifyReceipt(db, r!.public_id, r!.sha)).status).toBe(200); }
    finally { await db.query(`update receipts set body = $2 where public_id = $1`, [r!.public_id, JSON.stringify(r!.body)]); }
  });
});
