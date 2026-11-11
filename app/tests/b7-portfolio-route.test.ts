// Batch 7 review (review 4, 5; review 2): GET /api/portfolio over the normal seed, through the real route handler.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GET } from '@/app/api/portfolio/route';
import { openPglite, type Db } from '../db/client';
import { initialize } from '../db/init';
import { setRouteDepsForTests } from '../lib/server';
import manifest from '../public/portfolio/imani/photos.json';

const TOKEN = 'b7-portfolio-route-test-token';
let db: Db;
let dir: string;
const saved = { token: process.env.CREATOR_TOKEN, origin: process.env.APP_ORIGIN };

beforeAll(async () => {
  db = await openPglite();
  dir = await mkdtemp(join(tmpdir(), 'ur-b7-route-'));
  await initialize(db, dir);
  process.env.CREATOR_TOKEN = TOKEN;
  delete process.env.APP_ORIGIN;
  setRouteDepsForTests({ db, uploadsDir: dir });
});
afterAll(async () => {
  setRouteDepsForTests(null);
  if (saved.token === undefined) delete process.env.CREATOR_TOKEN; else process.env.CREATOR_TOKEN = saved.token;
  if (saved.origin !== undefined) process.env.APP_ORIGIN = saved.origin;
  await db?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

type Asset = { id: string; title: string; isPublic: boolean; onPublicPage: boolean; photo: { src: string } | null };

describe('GET /api/portfolio', () => {
  it('refuses a request without the creator session', async () => {
    expect((await GET(new Request('http://localhost/api/portfolio'))).status).toBe(401);
  });

  it('lists 25 assets in order; exactly the 24 photos the public page shows are marked shown; no storage keys leak', async () => {
    const res = await GET(new Request('http://localhost/api/portfolio', { headers: { authorization: `Bearer ${TOKEN}` } }));
    expect(res.status).toBe(200);
    const raw = await res.text();
    for (const leak of ['key_original', 'key_web', 'key_print', 'original.jpg', 'print.jpg', 'web.jpg', 'buying@']) expect(raw).not.toContain(leak);
    const body = JSON.parse(raw) as { publicPath: string; assets: Asset[] };
    expect(body.publicPath).toBe('/c/imani');
    expect(body.assets).toHaveLength(25);
    expect(body.assets.slice(0, 3).map((a) => a.title)).toEqual(['Morning Pour', 'Harbor Light', 'Studio Portrait']);
    const shown = body.assets.filter((a) => a.onPublicPage);
    // B9 9.1: Morning Pour (photo 11) and Harbor Light (photo 22) are the oldest assets, so they list first.
    const src = (a: Asset) => a.photo?.src ?? '';
    expect([...shown].sort((x, y) => src(x).localeCompare(src(y))).map((a) => a.title)).toEqual(manifest.photos.map((p) => p.title));
    expect(shown.map(src).sort()).toEqual(manifest.photos.map((p) => `/portfolio/imani/${p.num}.jpg`));
    expect(body.assets.filter((a) => a.isPublic)).toHaveLength(24);
    for (const t of ['Studio Portrait']) {
      expect(body.assets.find((a) => a.title === t)).toMatchObject({ onPublicPage: false, photo: null });
    }
  });
});
