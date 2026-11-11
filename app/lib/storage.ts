// Private asset storage (batch-6 §5, fixes 16, 22; B10 10.2). A local directory (`<uploadsDir>/assets/<key>`) by default;
// with SUPABASE_URL set, a private Supabase Storage bucket behind the same functions, so files survive a host restart.
// Files are only ever streamed by our routes, never linked publicly: the service key stays on the server and no signed
// or public URL is made. Env is read at each call, never at import.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

const KEY_RE = /^[a-z0-9][a-z0-9/_.-]{0,200}$/i;
const STORE_TIMEOUT_MS = 30_000;
const UPLOAD_PREFIX = 'bucket:';

type Store = { base: string; name: string; headers: Record<string, string> };

/**
 * The bucket when one is configured. Either half of the pair alone refuses, and so does Render with neither (it sets RENDER
 * itself), rather than quietly writing to a disk that a restart wipes. A local production run with neither keeps the disk.
 */
function store(env: NodeJS.ProcessEnv = process.env): Store | null {
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!env.SUPABASE_URL && key) throw new Error('SUPABASE_URL is not set');
  if (!env.SUPABASE_URL) {
    if (env.RENDER) throw new Error('no file store on Render: set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');
    return null;
  }
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not set');
  const url = new URL(env.SUPABASE_URL);
  if (url.protocol !== 'https:') throw new Error('SUPABASE_URL must be https');
  return { base: `${url.origin}/storage/v1`, name: env.SUPABASE_BUCKET || 'useright-private', headers: { authorization: `Bearer ${key}`, apikey: key } };
}

const call = (s: Store, path: string, init: RequestInit = {}) =>
  fetch(`${s.base}${path}`, { ...init, headers: { ...s.headers, ...init.headers }, signal: AbortSignal.timeout(STORE_TIMEOUT_MS) });

/** Supabase answers a missing object or bucket with 404, or with 400 and a not_found body. */
async function isMissing(res: Response): Promise<boolean> {
  if (res.status === 404) return true;
  return res.status === 400 && /not.?found|"404"/i.test(await res.text().catch(() => ''));
}

const objectPath = (s: Store, key: string) => {
  checkKey(key);
  return `/object/${encodeURIComponent(s.name)}/${key.split('/').map(encodeURIComponent).join('/')}`;
};

/** Creates the private bucket if it is not there, and refuses a public one. Run by db:init each time. No-op for the local directory. */
export async function ensureStore(): Promise<void> {
  const s = store();
  if (s) await checkBucket(s);
}

/**
 * review's B11 build review 3: no object is touched until this process has seen the bucket private. Once per process by
 * decision, with no periodic re-check; a failed check is not kept, so it is tried again. docs/KEYS-NEEDED.md probes the real one.
 */
const checked = new Map<string, Promise<void>>();
function checkedOnce(s: Store): Promise<void> {
  const id = `${s.base}/${s.name}`;
  let check = checked.get(id);
  if (!check) {
    check = checkBucket(s).catch((err: unknown) => {
      checked.delete(id);
      throw err;
    });
    checked.set(id, check);
  }
  return check;
}

async function checkBucket(s: Store): Promise<void> {
  const res = await call(s, `/bucket/${encodeURIComponent(s.name)}`);
  if (res.ok) {
    if ((await res.json() as { public?: boolean }).public !== false) throw new Error('the file store bucket is public; it must be private');
    return;
  }
  if (!(await isMissing(res))) throw new Error(`file store check failed: ${res.status}`);
  const made = await call(s, '/bucket', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: s.name, name: s.name, public: false }) });
  if (!made.ok) throw new Error(`file store setup failed: ${made.status}`);
}

function checkKey(key: string) {
  if (!KEY_RE.test(key) || key.includes('..')) throw new Error('bad storage key');
}

/** Absolute path for a storage key; refuses anything that would leave the assets directory. */
export function assetPath(uploadsDir: string, key: string): string {
  checkKey(key);
  const root = resolve(/*turbopackIgnore: true*/ uploadsDir, 'assets');
  const p = resolve(/*turbopackIgnore: true*/ root, key);
  if (!p.startsWith(root + sep)) throw new Error('bad storage key');
  return p;
}

export async function readAsset(uploadsDir: string, key: string): Promise<Buffer | null> {
  const s = store();
  if (s) {
    const path = objectPath(s, key);
    await checkedOnce(s);
    const res = await call(s, path);
    if (res.ok) return Buffer.from(await res.arrayBuffer());
    if (await isMissing(res)) return null;
    throw new Error(`file store read failed: ${res.status}`);
  }
  try {
    return await readFile(assetPath(uploadsDir, key));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export async function putAsset(uploadsDir: string, key: string, bytes: Buffer): Promise<void> {
  const s = store();
  if (s) {
    const path = objectPath(s, key);
    await checkedOnce(s);
    const res = await call(s, path, { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-upsert': 'true' }, body: new Uint8Array(bytes) });
    if (!res.ok) throw new Error(`file store write failed: ${res.status}`);
    return;
  }
  const p = assetPath(uploadsDir, key);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, bytes);
}

/** Saves a DM screenshot; the returned path goes in `briefs.upload_path`. Never built from the request. */
export async function saveUpload(uploadsDir: string, name: string, bytes: Buffer): Promise<string> {
  if (store()) {
    const key = `uploads/${name}`;
    await putAsset(uploadsDir, key, bytes);
    return UPLOAD_PREFIX + key;
  }
  const dir = resolve(/*turbopackIgnore: true*/ uploadsDir);
  await mkdir(dir, { recursive: true });
  const path = join(/*turbopackIgnore: true*/ dir, name);
  await writeFile(path, bytes);
  return path;
}

/** Reads what saveUpload wrote, or null when the file is gone. */
export async function readUpload(uploadsDir: string, path: string): Promise<Buffer | null> {
  if (path.startsWith(UPLOAD_PREFIX)) return readAsset(uploadsDir, path.slice(UPLOAD_PREFIX.length));
  store(); // the same refusals as every other file operation
  try {
    return await readFile(/*turbopackIgnore: true*/ path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export const sha256Bytes = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/** Content type from the file's magic bytes (the key's extension is not trusted). */
export function contentTypeOf(b: Buffer): string {
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return 'application/octet-stream';
}

export const extFor = (type: string) => ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' })[type] ?? 'bin';
