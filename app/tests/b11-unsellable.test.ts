// review 3 (judge-review.md, b9-review.md #3): Studio Portrait is a generated gradient. The picker hides it (b9-options.test.ts);
// this proves a direct API call cannot sell it either. review's build review 1 and 2: a quote made before the refusal cannot
// be sent, and only that placeholder is refused, not every private photo.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { POST as askPOST } from '@/app/api/ask/route';
import { POST as intakePOST } from '@/app/api/intake/route';
import { PATCH as briefPATCH } from '@/app/api/briefs/[id]/route';
import { POST as decidePOST } from '@/app/api/briefs/[id]/decide/route';
import { SAMPLES } from '@/components/creator/request-samples';
import { openPglite, type Db } from '../db/client';
import { initialize } from '../db/init';
import { creatorCard, gapPreview, latestExtraction, loadBrief } from '../lib/briefs';
import { runAutopilot } from '../lib/send';
import { setRouteDepsForTests } from '../lib/server';
import { PLACEHOLDER_ASSET_KEY, versionHash } from '../lib/versions';
import { mockInvoiceApi } from './helpers/mock-paypal';

const TOKEN = 'b11-unsellable-token';
let db: Db;
let dir: string;
let northwind: string;
let studio: string;
let m: ReturnType<typeof mockInvoiceApi>;
const saved = { token: process.env.CREATOR_TOKEN, origin: process.env.APP_ORIGIN };
const headers = { host: 'app.test', origin: 'http://app.test', cookie: `ur_creator=${TOKEN}`, 'content-type': 'application/json' };
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const social = SAMPLES.find((s) => s.key === 'social')!;

beforeAll(async () => {
  db = await openPglite();
  dir = await mkdtemp(join(tmpdir(), 'ur-b11u-'));
  await initialize(db, dir);
  process.env.CREATOR_TOKEN = TOKEN;
  delete process.env.APP_ORIGIN;
  m = mockInvoiceApi();
  setRouteDepsForTests({ db, uploadsDir: dir, invoices: m.api });
  northwind = (await db.query<{ id: string }>(`select id from clients where email = $1`, [social.clientEmail]))[0]!.id;
  studio = (await db.query<{ id: string }>(`select id from assets where title = 'Studio Portrait'`))[0]!.id;
});
afterAll(async () => {
  setRouteDepsForTests(null);
  if (saved.token === undefined) delete process.env.CREATOR_TOKEN; else process.env.CREATOR_TOKEN = saved.token;
  if (saved.origin !== undefined) process.env.APP_ORIGIN = saved.origin;
  await db?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

async function add(assetId: string, s = social) {
  const res = await intakePOST(new Request('http://app.test/api/intake', { method: 'POST', headers, body: JSON.stringify({ source: 'paste', clientId: northwind, assetId, text: s.text, fixture: s.fixture }) }));
  expect(res.status).toBe(201);
  return (await res.json() as { briefId: string; autopilot: string | null });
}
const nothingSold = async (id: string) => {
  expect(await db.query(`select 1 from licence_versions where brief_id = $1`, [id])).toEqual([]);
};

describe('the placeholder photo cannot be sold', () => {
  it('intake on the private photo: autopilot sends nothing and approve refuses', async () => {
    const { briefId, autopilot } = await add(studio);
    expect(autopilot).not.toBe('sent');
    await nothingSold(briefId);
    const res = await decidePOST(new Request(`http://app.test/api/briefs/${briefId}/decide`, { method: 'POST', headers, body: JSON.stringify({ action: 'approve', typedTotal: '300.00' }) }), params(briefId));
    expect(res.status).toBe(409);
    expect((await res.json() as { code: string }).code).toBe('asset_not_for_sale');
    await nothingSold(briefId);
  });

  it('switching a deal to the private photo sends nothing', async () => {
    const morning = (await db.query<{ id: string }>(`select id from assets where title = 'Morning Pour'`))[0]!.id;
    const { briefId, autopilot } = await add(morning, SAMPLES.find((x) => x.key === 'billboard')!);
    expect(autopilot).toBe('needs_approval');
    const res = await briefPATCH(new Request(`http://app.test/api/briefs/${briefId}`, { method: 'PATCH', headers, body: JSON.stringify({ assetId: studio }) }), params(briefId));
    expect(res.status).toBe(200);
    expect(await db.query(`select 1 from licence_versions where brief_id = $1 and asset_id = $2`, [briefId, studio])).toEqual([]);
    expect(await db.query(`select 1 from invoices i join licence_versions v on v.id = i.version_id where v.brief_id = $1`, [briefId])).toEqual([]);
  });

  it('a public photo still sells', async () => {
    const harbor = (await db.query<{ id: string }>(`select id from assets where title = 'Harbor Light'`))[0]!.id;
    const { briefId, autopilot } = await add(harbor);
    expect(autopilot).toBe('sent');
    expect(await db.query(`select 1 from licence_versions where brief_id = $1`, [briefId])).toHaveLength(1);
  });

  it('the constant names the seeded placeholder', async () => {
    expect((await db.query<{ key_original: string }>(`select key_original from assets where id = $1`, [studio]))[0]!.key_original).toBe(PLACEHOLDER_ASSET_KEY);
  });

  it('a placeholder quote made before the refusal cannot be sent by Approve, Ask, Retry or autopilot', async () => {
    const { briefId } = await add(studio);
    const brief = (await loadBrief(db, briefId))!;
    const x = (await latestExtraction(db, briefId))!;
    const p = (await gapPreview(db, brief, x.raw.requested))!;
    const hash = versionHash({ scope: p.combined, totalCents: p.totalCents, assetId: studio, clientId: northwind, parentId: null });
    const [v] = await db.query<{ id: string }>(
      `insert into licence_versions (creator_id, client_id, asset_id, parent_id, version_no, scope, rate_card, total_cents, paid_cents, content_hash, status, brief_id, extraction_id)
       values ($1, $2, $3, null, 1, $4, $5, $6, 0, $7, 'pending', $8, $9) returning id`,
      [brief.creator_id, northwind, studio, JSON.stringify(p.combined), JSON.stringify(await creatorCard(db, brief.creator_id)), p.totalCents, hash, briefId, x.id]);
    const typedTotal = (p.totalCents / 100).toFixed(2);
    m.reset();
    const refused = async (res: Response) => { expect(res.status).toBe(409); expect((await res.json() as { code: string }).code).toBe('asset_not_for_sale'); };
    await refused(await decidePOST(new Request(`http://app.test/api/briefs/${briefId}/decide`, { method: 'POST', headers, body: JSON.stringify({ action: 'approve', typedTotal }) }), params(briefId)));
    await refused(await askPOST(new Request('http://app.test/api/ask', { method: 'POST', headers, body: JSON.stringify({ versionId: v!.id, action: 'approve', typedTotal }) })));
    await refused(await decidePOST(new Request(`http://app.test/api/briefs/${briefId}/decide`, { method: 'POST', headers, body: JSON.stringify({ action: 'retry' }) }), params(briefId)));
    expect(await runAutopilot(db, m.api, briefId)).toMatchObject({ action: 'failed' });
    expect(m.calls).toEqual([]);
    expect(await db.query(`select 1 from autopilot_sends where version_id = $1 and status = 'reserved'`, [v!.id])).toEqual([]);
  });

  it('a private real photo still sells', async () => {
    const [s] = await db.query<{ creator_id: string }>(`select creator_id from assets where id = $1`, [studio]);
    const [a] = await db.query<{ id: string }>(
      `insert into assets (creator_id, title, key_original, key_web, key_print, key_preview, file_hash, is_public)
       values ($1, 'Private Commission', 'imani/private/original.jpg', 'imani/private/web.jpg', 'imani/private/print.jpg', 'imani/private/preview.jpg', 'seed-private', false) returning id`, [s!.creator_id]);
    m.reset();
    const { briefId, autopilot } = await add(a!.id);
    expect(autopilot).toBe('sent');
    expect(await db.query(`select 1 from licence_versions where brief_id = $1`, [briefId])).toHaveLength(1);
    expect(m.calls.some((c) => c.op === 'send')).toBe(true);
  });
});
