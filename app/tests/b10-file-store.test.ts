// B10 10.2: the durable private file store, proved against an in-memory stand-in for Supabase Storage's REST API. The
// real bucket has not been used: that needs an account (docs/KEYS-NEEDED.md).
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET as imageGET } from '@/app/api/briefs/[id]/image/route';
import { SAMPLES } from '@/components/creator/request-samples';
import { openPglite, type Db } from '../db/client';
import { initialize } from '../db/init';
import { createAdapter, fixtureProvider } from '../lib/ai/extract';
import { getBriefView, type AiFor } from '../lib/briefs';
import { grantIfPaid, type GrantDeps } from '../lib/grant';
import { intake, type IntakeDeps } from '../lib/intake';
import { consumeDownload, issueDownload, previewFor } from '../lib/pay';
import { ensureAssetFiles } from '../lib/placeholder-files';
import { latestReceiptId, receiptView } from '../lib/receipts';
import { runAutopilot } from '../lib/send';
import { setRouteDepsForTests } from '../lib/server';
import { ensureStore, putAsset, readAsset, readUpload, saveUpload, sha256Bytes } from '../lib/storage';
import { mockInvoiceApi } from './helpers/mock-paypal';

const STORE = 'https://store.test';
const KEY = 'test-service-key-not-real';
const TOKEN = 'b10-file-token';

// What the app must send and what it must get back; anything else fails the test.
const objects = new Map<string, Buffer>();
let buckets: Record<string, { public: boolean }>;
let requests: { method: string; path: string }[];
let failNext: number | null;
const realFetch = globalThis.fetch;

async function fakeStorage(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const url = new URL(String(input));
  if (url.origin !== STORE) throw new Error(`unexpected fetch to ${url.origin}`);
  const method = init.method ?? 'GET';
  requests.push({ method, path: url.pathname });
  const h = new Headers(init.headers);
  if (h.get('authorization') !== `Bearer ${KEY}` || h.get('apikey') !== KEY) return new Response('{}', { status: 401 });
  if (failNext) { const status = failNext; failNext = null; return new Response('boom', { status }); }
  const missing = () => new Response(JSON.stringify({ statusCode: '404', error: 'not_found', message: 'Object not found' }), { status: 400 });
  const path = decodeURIComponent(url.pathname.replace('/storage/v1', ''));
  if (path === '/bucket' && method === 'POST') {
    const b = JSON.parse(String(init.body)) as { id: string; public: boolean };
    buckets[b.id] = { public: b.public };
    return new Response('{}', { status: 200 });
  }
  const bucket = path.match(/^\/bucket\/(.+)$/);
  if (bucket) return buckets[bucket[1]!] ? new Response(JSON.stringify(buckets[bucket[1]!]), { status: 200 }) : missing();
  const object = path.match(/^\/object\/([^/]+)\/(.+)$/);
  if (object && buckets[object[1]!]) {
    const id = `${object[1]}/${object[2]}`;
    if (method === 'POST') { objects.set(id, Buffer.from(init.body as Uint8Array)); return new Response('{}', { status: 200 }); }
    const found = objects.get(id);
    return found ? new Response(new Uint8Array(found), { status: 200 }) : missing();
  }
  return new Response('not a storage call', { status: 500 });
}

let db: Db;
let dir: string;
let m: ReturnType<typeof mockInvoiceApi>;
let deps: IntakeDeps;
let g: GrantDeps;
const aiFor: AiFor = (fixture) => createAdapter(fixtureProvider(fixture ?? 'paste'));
const env0 = { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY, bucket: process.env.SUPABASE_BUCKET, token: process.env.CREATOR_TOKEN, origin: process.env.APP_ORIGIN };
const restore = (k: string, v: string | undefined) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };
const env0Render = process.env.RENDER;
/** A new server process: a fresh copy of the module, with nothing checked yet. */
const newProcess = async () => { vi.resetModules(); return import('../lib/storage'); };

beforeAll(async () => {
  buckets = {};
  requests = [];
  failNext = null;
  process.env.SUPABASE_URL = STORE;
  process.env.SUPABASE_SERVICE_ROLE_KEY = KEY;
  delete process.env.SUPABASE_BUCKET;
  process.env.CREATOR_TOKEN = TOKEN;
  delete process.env.APP_ORIGIN;
  vi.stubGlobal('fetch', vi.fn(fakeStorage));
  db = await openPglite();
  dir = await mkdtemp(join(tmpdir(), 'ur-b10-'));
  await initialize(db, dir);
  m = mockInvoiceApi();
  deps = { db, aiFor, uploadsDir: dir, env: { AI_PROVIDER: 'fixture', NODE_ENV: 'test' } as unknown as NodeJS.ProcessEnv };
  g = { db, pp: m.pp, uploadsDir: dir };
}, 120_000);
afterAll(async () => {
  setRouteDepsForTests(null);
  vi.stubGlobal('fetch', realFetch);
  vi.unstubAllGlobals();
  restore('SUPABASE_URL', env0.url); restore('SUPABASE_SERVICE_ROLE_KEY', env0.key); restore('SUPABASE_BUCKET', env0.bucket);
  restore('CREATOR_TOKEN', env0.token); restore('APP_ORIGIN', env0.origin); restore('RENDER', env0Render);
  await db?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});
beforeEach(() => { requests = []; failNext = null; process.env.SUPABASE_URL = STORE; process.env.SUPABASE_SERVICE_ROLE_KEY = KEY; delete process.env.RENDER; });

describe('setup', () => {
  it('db:init makes a private bucket and writes every file there, none on disk', async () => {
    expect(buckets['useright-private']).toEqual({ public: false });
    expect(objects.size).toBeGreaterThan(0);
    expect([...objects.keys()].every((k) => k.startsWith('useright-private/'))).toBe(true);
    expect(await readdir(dir)).toEqual([]);
  });

  it('a second init writes nothing', async () => {
    expect(await ensureAssetFiles(db, dir)).toBe(0);
    expect(requests.some((r) => r.method === 'POST')).toBe(false);
  });

  it('refuses a public bucket', async () => {
    buckets['useright-private']!.public = true;
    await expect(ensureStore()).rejects.toThrow(/public/);
    buckets['useright-private']!.public = false;
    await expect(ensureStore()).resolves.toBeUndefined();
  });

  it('a half-set config refuses instead of falling back to the disk', async () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    await expect(readAsset(dir, 'imani/x.jpg')).rejects.toThrow(/SUPABASE_SERVICE_ROLE_KEY/);
    process.env.SUPABASE_SERVICE_ROLE_KEY = KEY;
    process.env.SUPABASE_URL = 'http://store.test';
    await expect(putAsset(dir, 'imani/x.jpg', Buffer.from('x'))).rejects.toThrow(/https/);
  });
});

describe('the bucket stays private (review build review 3)', () => {
  const objectCalls = () => requests.filter((r) => r.path.includes('/object/'));
  const bucketChecks = () => requests.filter((r) => r.path.includes('/bucket/'));

  it('a new process with a public bucket refuses its first read and write, and touches no object', async () => {
    buckets['useright-private']!.public = true;
    try {
      const s = await newProcess();
      const before = objects.size;
      await expect(s.readAsset(dir, 'b10/a-b.jpg')).rejects.toThrow(/public/);
      await expect(s.putAsset(dir, 'b10/new.jpg', Buffer.from('x'))).rejects.toThrow(/public/);
      await expect(s.saveUpload(dir, 'x.png', Buffer.from('x'))).rejects.toThrow(/public/);
      expect(objectCalls()).toEqual([]);
      expect(objects.size).toBe(before);
    } finally {
      buckets['useright-private']!.public = false;
    }
  });

  it('checks once per process, not on every file; a bucket made public later is refused by the next process', async () => {
    const s = await newProcess();
    await s.putAsset(dir, 'b10/once.jpg', Buffer.from([1]));
    await s.readAsset(dir, 'b10/once.jpg');
    expect(bucketChecks()).toHaveLength(1);
    // The decision: no periodic re-check, so this process keeps working. The acceptance run probes the real bucket.
    buckets['useright-private']!.public = true;
    try {
      expect(await s.readAsset(dir, 'b10/once.jpg')).toEqual(Buffer.from([1]));
      await expect((await newProcess()).readAsset(dir, 'b10/once.jpg')).rejects.toThrow(/public/);
    } finally {
      buckets['useright-private']!.public = false;
    }
  });

  it('a check that could not finish fails closed, and is tried again', async () => {
    const s = await newProcess();
    failNext = 500;
    await expect(s.readAsset(dir, 'b10/once.jpg')).rejects.toThrow('file store check failed: 500');
    expect(objectCalls()).toEqual([]);
    expect(await s.readAsset(dir, 'b10/once.jpg')).toEqual(Buffer.from([1]));
  });
});

describe('half a store, or no store on Render (review build review 4)', () => {
  const allRefuse = async (pattern: RegExp) => {
    await expect(readAsset(dir, 'imani/x.jpg')).rejects.toThrow(pattern);
    await expect(putAsset(dir, 'imani/x.jpg', Buffer.from('x'))).rejects.toThrow(pattern);
    await expect(saveUpload(dir, 'x.png', Buffer.from('x'))).rejects.toThrow(pattern);
    await expect(readUpload(dir, join(dir, 'x.png'))).rejects.toThrow(pattern);
    expect(await readdir(dir)).toEqual([]);
    expect(requests).toEqual([]);
  };

  it('the key without the URL refuses', async () => {
    delete process.env.SUPABASE_URL;
    await allRefuse(/SUPABASE_URL/);
  });

  it('the URL without the key refuses', async () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    await allRefuse(/SUPABASE_SERVICE_ROLE_KEY/);
  });

  it('on Render with neither, refuses to use the disk', async () => {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    process.env.RENDER = 'true';
    await allRefuse(/Render/);
  });

  it('on Render with both, the bucket is used', async () => {
    process.env.RENDER = 'true';
    await putAsset(dir, 'b10/render.jpg', Buffer.from([7]));
    expect(await readAsset(dir, 'b10/render.jpg')).toEqual(Buffer.from([7]));
    expect(await readdir(dir)).toEqual([]);
  });

  it('a local production run with neither keeps the disk store', async () => {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const local = await mkdtemp(join(tmpdir(), 'ur-b10-local-'));
    try {
      await putAsset(local, 'b10/local.jpg', Buffer.from([9]));
      expect(await readAsset(local, 'b10/local.jpg')).toEqual(Buffer.from([9]));
      expect(requests).toEqual([]);
    } finally {
      await rm(local, { recursive: true, force: true });
    }
  });
});

describe('reads and writes', () => {
  it('round-trips bytes; a missing object is null', async () => {
    await putAsset(dir, 'b10/a-b.jpg', Buffer.from([1, 2, 3]));
    expect(await readAsset(dir, 'b10/a-b.jpg')).toEqual(Buffer.from([1, 2, 3]));
    expect(await readAsset(dir, 'b10/none.jpg')).toBeNull();
  });

  it('a store failure throws with the status and no secret', async () => {
    failNext = 500;
    const err = await readAsset(dir, 'b10/a-b.jpg').catch((e: Error) => e);
    expect((err as Error).message).toBe('file store read failed: 500');
    expect(String(err)).not.toContain(KEY);
  });

  it('a path-escaping key is refused before any request', async () => {
    await expect(readAsset(dir, '../secrets')).rejects.toThrow('bad storage key');
    await expect(putAsset(dir, 'a/../../b', Buffer.from('x'))).rejects.toThrow('bad storage key');
    expect(requests).toEqual([]);
  });
});

describe('access checks and a restart', () => {
  it('unpaid: no download. Paid: the bucket file, its hash on the receipt, from a host with an empty disk', async () => {
    const harbor = (await db.query<{ id: string }>(`select id from assets where title = 'Harbor Light'`))[0]!.id;
    const northwind = (await db.query<{ id: string }>(`select id from clients where email = 'buying@northwind.example'`))[0]!.id;
    const s = SAMPLES.find((x) => x.key === 'social')!;
    const r = await intake(deps, { source: 'paste', clientId: northwind, assetId: harbor, text: s.text!, fixture: s.fixture }, { creator: true, sessionSlug: 'imani' });
    if (!r.ok) throw new Error(r.error);
    expect(await runAutopilot(db, m.api, r.briefId)).toMatchObject({ action: 'sent' });
    const v = (await getBriefView(db, r.briefId))!.version!;
    const token = v.invoice!.payPath!.split('/').pop()!;

    expect((await issueDownload(db, token)).ok).toBe(false);
    // The preview is the one image an unpaid client gets.
    expect((await previewFor(db, dir, token))?.bytes.length).toBeGreaterThan(0);

    m.pay(v.invoice!.paypalInvoiceId!);
    expect((await grantIfPaid(g, v.id, 'test')).granted).toBe(true);

    // A restarted host: a new, empty directory. The file still comes back, because only the bucket holds it.
    const restarted = await mkdtemp(join(tmpdir(), 'ur-b10-restart-'));
    try {
      const issued = await issueDownload(db, token);
      if (!issued.ok) throw new Error('no download');
      const dl = await consumeDownload(db, restarted, issued.url.split('/').pop()!);
      expect(dl.ok).toBe(true);
      if (!dl.ok) return;
      const [a] = await db.query<{ key_web: string }>(`select key_web from assets where id = $1`, [harbor]);
      expect(dl.bytes!.equals(objects.get(`useright-private/${a!.key_web}`)!)).toBe(true);
      const receipt = await receiptView(db, (await latestReceiptId(db, v.id))!);
      expect(JSON.stringify(receipt)).toContain(sha256Bytes(dl.bytes!));
    } finally {
      await rm(restarted, { recursive: true, force: true });
    }
  });

  it('a DM screenshot lives in the bucket and only the creator route reads it', async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const path = await saveUpload(dir, 'dm-1.png', bytes);
    expect(path).toBe('bucket:uploads/dm-1.png');
    expect(await readUpload(dir, path)).toEqual(bytes);
    expect(await readdir(dir)).toEqual([]);

    setRouteDepsForTests({ db, uploadsDir: dir, invoices: m.api });
    const [b] = await db.query<{ id: string }>(`select id from briefs limit 1`);
    await db.query(`update briefs set upload_path = $1 where id = $2`, [path, b!.id]);
    const ctx = { params: Promise.resolve({ id: b!.id }) };
    const denied = await imageGET(new Request(`http://app.test/api/briefs/${b!.id}/image`, { headers: { host: 'app.test' } }), ctx);
    expect(denied.status).toBe(401);
    const res = await imageGET(new Request(`http://app.test/api/briefs/${b!.id}/image`, { headers: { host: 'app.test', cookie: `ur_creator=${TOKEN}` } }), ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await res.arrayBuffer())).toEqual(bytes);
    await db.query(`update briefs set upload_path = 'bucket:uploads/gone.png' where id = $1`, [b!.id]);
    expect((await imageGET(new Request(`http://app.test/api/briefs/${b!.id}/image`, { headers: { host: 'app.test', cookie: `ur_creator=${TOKEN}` } }), ctx)).status).toBe(404);
    await db.query(`update briefs set upload_path = null where id = $1`, [b!.id]);
  });
});
