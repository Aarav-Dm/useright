// B9 9.1: the paid file is the photo shown (review win finding 1), and nobody gets it without paying. Morning Pour and
// Harbor Light are on the public page, which serves only a smaller copy; the print file is the private original.
import { readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openPglite, type Db } from '../db/client';
import { initialize } from '../db/init';
import { originalPhotoPath } from '../lib/placeholder-files';
import { manifestPhotoFor } from '../lib/portfolio';
import manifest from '../public/portfolio/imani/photos.json';
import { readAsset, sha256Bytes } from '../lib/storage';

let db: Db;
let dir: string;
const photo = readFileSync(originalPhotoPath('11'));
const longEdge = async (b: Buffer) => { const m = await sharp(b).metadata(); return Math.max(m.width, m.height); };
const publicFiles = (d: string): string[] => readdirSync(d, { withFileTypes: true })
  .flatMap((e) => (e.isDirectory() ? publicFiles(join(d, e.name)) : [join(d, e.name)]));
const keys = async (title: string) => (await db.query<{ key_web: string; key_print: string; key_preview: string }>(
  `select key_web, key_print, key_preview from assets where title = $1`, [title]))[0]!;
/** Mean difference per channel between two images, compared at one small size. */
async function distance(a: Buffer, b: Buffer) {
  const raw = (x: Buffer) => sharp(x).resize(32, 32, { fit: 'fill' }).removeAlpha().raw().toBuffer();
  const [ra, rb] = [await raw(a), await raw(b)];
  return ra.reduce((sum, v, i) => sum + Math.abs(v - rb[i]!), 0) / ra.length;
}

describe('photo provenance (security review finding 2)', () => {
  it('the served manifest has no download link, and each photo has one outside public/', () => {
    const sources = JSON.parse(readFileSync(join('private', 'portfolio', 'imani', 'sources.json'), 'utf8')) as { photos: { filename: string; downloadUrl: string }[] };
    expect(JSON.stringify(manifest)).not.toContain('downloadUrl');
    expect(sources.photos.map((s) => s.filename)).toEqual(manifest.photos.map((p) => p.filename));
    expect(sources.photos.every((s) => s.downloadUrl.startsWith('https://'))).toBe(true);
  });
});

beforeAll(async () => {
  db = await openPglite();
  dir = await mkdtemp(join(tmpdir(), 'ur-b9-asset-'));
  await initialize(db, dir);
});
afterAll(async () => {
  await db?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe('B9 9.1: one consistent demo asset', () => {
  it('Morning Pour and Harbor Light are in the public manifest, one asset each; the page keeps 24 tiles', async () => {
    expect(manifestPhotoFor('Morning Pour')?.src).toBe('/portfolio/imani/11.jpg');
    expect(manifestPhotoFor('Harbor Light')?.src).toBe('/portfolio/imani/22.jpg');
    expect(await db.query(`select id from assets where title in ('Morning Pour', 'Harbor Light')`)).toHaveLength(2);
    expect(manifest.photos).toHaveLength(24);
  });

  it('no file under public holds a print file, and every public photo is smaller than its web file', async () => {
    const served = publicFiles(join(process.cwd(), 'public')).map((f) => sha256Bytes(readFileSync(f)));
    for (const p of manifest.photos) {
      const k = await keys(p.title);
      const print = (await readAsset(dir, k.key_print))!;
      expect(print.equals(readFileSync(originalPhotoPath(p.num)))).toBe(true);
      expect(served).not.toContain(sha256Bytes(print));
      const web = (await readAsset(dir, k.key_web))!;
      expect(served).not.toContain(sha256Bytes(web));
      const shown = readFileSync(join(process.cwd(), 'public', 'portfolio', 'imani', p.filename));
      expect(await longEdge(shown)).toBe(1600);
      expect(await longEdge(web)).toBe(2000);
      expect(await longEdge(print)).toBeGreaterThan(2000);
    }
  });

  it('every seeded deal names a photo in the manifest', async () => {
    const titles = await db.query<{ title: string }>(`select distinct a.title from briefs b join assets a on a.id = b.asset_id`);
    expect(titles.length).toBeGreaterThan(5);
    for (const { title } of titles) expect(manifestPhotoFor(title), title).not.toBeNull();
  });

  it('Morning Pour is the CC0 coffee pour, with its source in the manifest and CREDITS; titles are unique', async () => {
    const m = manifest.photos.find((p) => p.title === 'Morning Pour')!;
    expect(m.licenceUrl).toBe('https://creativecommons.org/publicdomain/zero/1.0/');
    expect(m.photographer).toBe('Annie Spratt');
    const credits = readFileSync(join(process.cwd(), 'public/portfolio/imani/CREDITS.md'), 'utf8');
    for (const p of manifest.photos) expect(credits).toContain(`**${p.title}**`);
    expect(new Set(manifest.photos.map((p) => p.title)).size).toBe(24);
    expect(await longEdge(photo)).toBeGreaterThanOrEqual(1200);
  });

  it('every photo the filmed flows sell is a real image, not a generated gradient', async () => {
    for (const title of ['Morning Pour', 'Harbor Light']) {
      const k = await keys(title);
      for (const key of [k.key_web, k.key_print, k.key_preview]) expect((await sharp((await readAsset(dir, key))!).metadata()).format).toBe('jpeg');
    }
  });

  it('the print file is the photo itself; the web file is the same image, smaller', async () => {
    const k = await keys('Morning Pour');
    expect((await readAsset(dir, k.key_print))!.equals(photo)).toBe(true);
    const web = (await readAsset(dir, k.key_web))!;
    expect(await longEdge(web)).toBe(2000);
    expect(await distance(web, photo)).toBeLessThan(5);
  });

  it('the preview is the same image with the watermark on it, and is neither paid file', async () => {
    const k = await keys('Morning Pour');
    const preview = (await readAsset(dir, k.key_preview))!;
    const d = await distance(preview, photo);
    expect(d).toBeGreaterThan(5); // the bands show
    expect(d).toBeLessThan(80); // the photo still shows through
    expect(preview.equals(photo)).toBe(false);
    expect(preview.equals((await readAsset(dir, k.key_web))!)).toBe(false);
  });

  it('every seeded receipt hash for a photo asset is the file the download serves', async () => {
    const rows = await db.query<{ hash: string; scope: { channels: string[] }; title: string }>(
      `select r.body->'asset'->>'sha256' as hash, v.scope, a.title from receipts r
         join licence_versions v on v.id = r.version_id join assets a on a.id = v.asset_id
        where r.body->'asset'->>'sha256' is not null`);
    const photos = rows.filter((r) => manifestPhotoFor(r.title));
    expect(photos.length).toBeGreaterThan(0);
    for (const r of photos) {
      const k = await keys(r.title);
      const file = (await readAsset(dir, r.scope.channels.includes('print') ? k.key_print : k.key_web))!;
      expect(r.hash).toBe(sha256Bytes(file));
    }
  });
});
