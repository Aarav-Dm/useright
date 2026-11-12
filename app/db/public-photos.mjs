// B9 9.1: makes the public files (B18: 1600px, sharp on a 2x screen) /c/imani serves from the private originals, and records their sizes in the manifest.
// Run by hand when an original changes (`node db/public-photos.mjs`); the output is committed, so hosts do not run it.
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';

const PUBLIC_LONG_EDGE = 1600; // smaller than the 2000px web file and the 2400px print original, so paying still gets a better file
const manifestPath = join('public', 'portfolio', 'imani', 'photos.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));

for (const p of manifest.photos) {
  const out = join('public', 'portfolio', 'imani', p.filename);
  const info = await sharp(join('private', 'portfolio', 'imani', p.filename))
    .resize(PUBLIC_LONG_EDGE, PUBLIC_LONG_EDGE, { fit: 'inside' }).jpeg({ quality: 80, mozjpeg: true }).toFile(out);
  p.width = info.width;
  p.height = info.height;
  p.sizeBytes = (await stat(out)).size;
  p.sizeKB = Math.round((p.sizeBytes / 1024) * 10) / 10;
}
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
