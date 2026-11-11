// review b9 3: Studio Portrait still has generated gradient files, so the creator's request options must not offer it.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GET } from '@/app/api/options/route';
import { openPglite, type Db } from '../db/client';
import { initialize } from '../db/init';
import { setRouteDepsForTests } from '../lib/server';

const TOKEN = 'b9-options-token';
const saved = process.env.CREATOR_TOKEN;
let db: Db;
let dir: string;

beforeAll(async () => {
  db = await openPglite();
  dir = await mkdtemp(join(tmpdir(), 'ur-b9-options-'));
  await initialize(db, dir);
  setRouteDepsForTests({ db, uploadsDir: dir });
  process.env.CREATOR_TOKEN = TOKEN;
});
afterAll(async () => {
  setRouteDepsForTests(null);
  if (saved === undefined) delete process.env.CREATOR_TOKEN; else process.env.CREATOR_TOKEN = saved;
  await db?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe('GET /api/options', () => {
  it('offers the public photos and not the private gradient', async () => {
    const res = await GET(new Request('http://app.test/api/options', { headers: { cookie: `ur_creator=${TOKEN}` } }));
    expect(res.status).toBe(200);
    const { assets } = await res.json() as { assets: { title: string; is_public: boolean }[] };
    const titles = assets.map((a) => a.title);
    expect(titles).toContain('Morning Pour');
    expect(titles).toContain('Harbor Light');
    expect(titles).not.toContain('Studio Portrait');
    expect(assets.every((a) => a.is_public)).toBe(true);
    expect((await db.query(`select 1 from assets where title = 'Studio Portrait'`))).toHaveLength(1);
  });
});
