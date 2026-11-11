// B9 9.1: makes the 600px files /c/imani serves from the private originals, and records their sizes in the manifest.
// Run by hand when an original changes (`node db/public-photos.mjs`); the output is committed, so hosts do not run it.
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';

const PUBLIC_LONG_EDGE = 600; // smaller than the 800px web file, so paying gets a visibly better file
const manifestPath = join('public', 'portfolio', 'imani', 'photos.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));

for (const p of manifest.photos) {
  const out = join('public', 'portfolio', 'imani', p.filename);
  const info = await sharp(join('private', 'portfolio', 'imani', p.filename))
    .resize(PUBLIC_LONG_EDGE, PUBLIC_LONG_EDGE, { fit: 'inside' }).jpeg({ quality: 75 }).toFile(out);
  p.width = info.width;
  p.height = info.height;
  p.sizeBytes = (await stat(out)).size;
  p.sizeKB = Math.round((p.sizeBytes / 1024) * 10) / 10;
}
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
