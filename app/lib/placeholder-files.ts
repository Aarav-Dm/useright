// Files for the seeded assets. B9 9.1: an asset with a portfolio photo is sold as that photo: print is the private
// original (2400px), web is 2000px, the preview is watermarked, and /c/imani shows a 1600px copy (db/public-photos.mjs). Any
// other seeded asset gets placeholder PNGs (gradients, the preview with diagonal stripes).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import sharp from 'sharp';
import type { Queryable } from '../db/client';
import { manifestPhotoFor } from './portfolio';
import { ensureStore, putAsset, readAsset } from './storage';

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(b: Buffer): number {
  let c = 0xffffffff;
  for (const x of b) c = CRC_TABLE[(c ^ x) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** RGB PNG, w x h, warm gradient; `watermark` adds pale diagonal bands. */
export function placeholderPng(w: number, h: number, seed: number, watermark = false): Buffer {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    const row = y * (w * 3 + 1);
    raw[row] = 0;
    for (let x = 0; x < w; x++) {
      let r = 60 + Math.floor((140 * x) / w) + (seed % 40);
      let g = 40 + Math.floor((100 * y) / h);
      let b = 30 + ((seed * 37) % 80);
      if (watermark && Math.floor((x + y) / Math.max(8, Math.floor(w / 24))) % 4 === 0) {
        r = 230; g = 230; b = 230;
      }
      raw[row + 1 + x * 3] = Math.min(255, r);
      raw[row + 2 + x * 3] = Math.min(255, g);
      raw[row + 3 + x * 3] = Math.min(255, b);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** The full-size original of a portfolio photo. Outside `public`, so it is never served without a paid download. */
export const originalPhotoPath = (num: string) => join(process.cwd(), 'private', 'portfolio', 'imani', `${num}.jpg`);

const photoBytes = (title: string): Buffer | null => {
  const photo = manifestPhotoFor(title);
  return photo ? readFileSync(originalPhotoPath(photo.num)) : null;
};

/**
 * The file a web or print licence delivers for the asset at position `i`; the seeds hash these for their receipts (F9).
 * A photo's print file is its private original and its web file is the same image at 2000px; /c/imani shows 1600px.
 * shortcut: the stock originals are kept at 2400px, so "print" is only the largest file we keep; a creator's real
 * upload would give a true print-resolution file.
 */
export const printFile = async (title: string, i: number) => photoBytes(title) ?? placeholderPng(3000, 2000, i);
export const webFile = async (title: string, i: number) => {
  const photo = photoBytes(title);
  return photo ? sharp(photo).resize(2000, 2000, { fit: 'inside' }).jpeg({ quality: 85 }).toBuffer() : placeholderPng(1200, 800, i);
};

/** B9 9.1: the photo at preview size under pale diagonal bands, so the client sees the image they are buying. */
async function watermarkedPreview(photo: Buffer): Promise<Buffer> {
  const small = await sharp(photo).resize(600, 600, { fit: 'inside' }).toBuffer();
  const { width: w, height: h } = await sharp(small).metadata();
  const bands = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><defs><pattern id="b" width="96" height="96" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="24" height="96" fill="#fff" fill-opacity="0.45"/></pattern></defs><rect width="100%" height="100%" fill="url(#b)"/></svg>`;
  return sharp(small).composite([{ input: Buffer.from(bands) }]).jpeg({ quality: 80 }).toBuffer();
}

/** Writes the files for every asset key that has no file yet. Returns how many were written. */
export async function ensureAssetFiles(q: Queryable, uploadsDir: string): Promise<number> {
  await ensureStore();
  const assets = await q.query<{ title: string; key_original: string; key_web: string; key_print: string; key_preview: string }>(
    `select title, key_original, key_web, key_print, key_preview from assets order by created_at`);
  let written = 0;
  for (const [i, a] of assets.entries()) {
    const photo = photoBytes(a.title);
    const files: [string, () => Buffer | Promise<Buffer>][] = [
      [a.key_web, () => webFile(a.title, i)],
      [a.key_print, () => printFile(a.title, i)],
      [a.key_original, () => placeholderPng(3000, 2000, i + 1)], // never delivered (fix 11), so it stays a placeholder
      [a.key_preview, () => (photo ? watermarkedPreview(photo) : placeholderPng(600, 400, i, true))],
    ];
    for (const [key, make] of files) {
      if (await readAsset(uploadsDir, key)) continue;
      await putAsset(uploadsDir, key, await make());
      written++;
    }
  }
  return written;
}
