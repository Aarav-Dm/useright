// Seed (batch-2 §6, spec §2): Imani, her settings and rate card, 3 assets (2 public) plus the 24 public portfolio
// photos (batch 7), client Northwind, and Northwind's paid v1 with its payment and receipt.
import type { Db, Queryable } from './client';
import { contentHash, sha256Hex } from '../lib/hash';
import { webFile } from '../lib/placeholder-files';
import { DEFAULT_CARD, optionKind, price, type PricedOptionId, type Scope } from '../lib/pricing';
import { grantReceiptBody } from '../lib/receipts';
import { sha256Bytes } from '../lib/storage';
import { newToken } from '../lib/tokens';
import portfolio from '../public/portfolio/imani/photos.json';

export type SeedResult = {
  created: boolean;
  creatorId: string;
  clientId: string;
  assetIds: string[];
  v1Id: string;
};

const SEED_ASSETS = [
  { slug: 'morning-pour', title: 'Morning Pour', isPublic: true },
  { slug: 'harbor-light', title: 'Harbor Light', isPublic: true },
  { slug: 'studio-portrait', title: 'Studio Portrait', isPublic: false },
] as const;

/**
 * Batch 7 (7A): the 24 portfolio photos in `public/portfolio/imani/photos.json`, public, in file order 01..24.
 * They come after SEED_ASSETS by created_at, so tests, fixtures and the seeded receipt keep pointing at Morning Pour.
 * Keys are `imani/portfolio/<num>/...`; ensureAssetFiles writes the files behind them from the photos (B9 9.1).
 */
export const PORTFOLIO_PHOTOS = portfolio.photos
  // B9 9.1: a manifest photo titled like a seed asset (Morning Pour) is that asset's photo, not a second asset.
  .filter((p) => !SEED_ASSETS.some((a) => a.title === p.title))
  .map((p) => ({ num: p.num, title: p.title }));
export const portfolioKeyBase = (num: string) => `imani/portfolio/${num}`;

/** Inserts each portfolio photo whose original key is not there yet, in order. Returns ids of all 24, in order. */
async function seedPortfolioPhotos(tx: Queryable, creatorId: string, now: Date, offsetMs: number): Promise<string[]> {
  const ids: string[] = [];
  for (const [i, p] of PORTFOLIO_PHOTOS.entries()) {
    const base = portfolioKeyBase(p.num);
    const [found] = await tx.query<{ id: string }>(
      `select id from assets where creator_id = $1 and key_original = $2`, [creatorId, `${base}/original.jpg`]);
    if (found) { ids.push(found.id); continue; }
    const { id } = await one<{ id: string }>(
      tx,
      `insert into assets (creator_id, title, key_original, key_web, key_print, key_preview, file_hash, is_public, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, true, $8) returning id`,
      [creatorId, p.title, `${base}/original.jpg`, `${base}/web.jpg`, `${base}/print.jpg`, `${base}/preview.jpg`,
        sha256Hex(`seed:portfolio:${p.num}`), new Date(now.getTime() + offsetMs + i)],
    );
    ids.push(id);
  }
  return ids;
}

export const SEED_V1_SCOPE: Scope = { channels: ['social'], territory: 'US', durationMonths: 6, exclusive: false };
export const SEED_V1_TXN_ID = 'SEED-V1';

function addMonths(d: Date, months: number): Date {
  const out = new Date(d);
  out.setUTCMonth(out.getUTCMonth() + months);
  return out;
}

async function one<T extends Record<string, unknown>>(tx: Queryable, text: string, params: unknown[]): Promise<T> {
  const rows = await tx.query<T>(text, params);
  if (!rows[0]) throw new Error(`seed: no row returned for: ${text}`);
  return rows[0];
}

/**
 * Idempotent: if creator `imani` exists, writes nothing except any missing portfolio photo assets (so a database
 * seeded before batch 7 gains the 24 photos), and returns the existing ids.
 */
export async function seed(db: Db, now: Date = new Date()): Promise<SeedResult> {
  return db.transaction(async (tx) => {
    const existing = await tx.query<{ id: string }>(`select id from creators where slug = $1`, ['imani']);
    if (existing[0]) {
      const creatorId = existing[0].id;
      await seedPortfolioPhotos(tx, creatorId, now, 0);
      const client = await one<{ id: string }>(tx, `select id from clients where creator_id = $1 and lower(email) = $2`, [creatorId, 'buying@northwind.example']);
      const assets = await tx.query<{ id: string }>(`select id from assets where creator_id = $1 order by created_at, title`, [creatorId]);
      const v1 = await one<{ id: string }>(tx, `select id from licence_versions where creator_id = $1 and client_id = $2 and version_no = 1`, [creatorId, client.id]);
      return { created: false, creatorId, clientId: client.id, assetIds: assets.map((a) => a.id), v1Id: v1.id };
    }

    const { id: creatorId } = await one<{ id: string }>(
      tx,
      `insert into creators (slug, name, email) values ($1, $2, $3) returning id`,
      ['imani', 'Imani', 'imani@useright.example'],
    );

    await tx.query(
      `insert into creator_settings
         (creator_id, per_deal_cap_cents, daily_max_sends, rolling30_cap_cents, auto_channels, ask_channels, timezone)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [creatorId, 50000, 10, 150000, ['social', 'web', 'print'], ['billboard', 'exclusive'], 'America/New_York'],
    );

    for (const [optionId, cents] of Object.entries(DEFAULT_CARD) as [PricedOptionId, number][]) {
      await tx.query(
        `insert into rate_card_options (creator_id, option_id, kind, cents) values ($1, $2, $3, $4)`,
        [creatorId, optionId, optionKind(optionId), cents],
      );
    }

    // Storage keys only; files arrive with Supabase Storage in a later batch.
    // file_hash is a placeholder (sha256 of the slug) until real originals are uploaded.
    const assetIds: string[] = [];
    for (const a of SEED_ASSETS) {
      const base = `imani/${a.slug}`;
      const { id } = await one<{ id: string }>(
        tx,
        `insert into assets (creator_id, title, key_original, key_web, key_print, key_preview, file_hash, is_public, created_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
        [creatorId, a.title, `${base}/original.jpg`, `${base}/web.jpg`, `${base}/print.jpg`, `${base}/preview.jpg`,
          sha256Hex(`seed:${a.slug}`), a.isPublic, new Date(now.getTime() + assetIds.length)],
      );
      assetIds.push(id);
    }
    assetIds.push(...await seedPortfolioPhotos(tx, creatorId, now, assetIds.length));
    const assetId = assetIds[0]!;

    const { id: clientId } = await one<{ id: string }>(
      tx,
      `insert into clients (creator_id, name, email, allowed) values ($1, $2, $3, true) returning id`,
      [creatorId, 'Northwind Coffee', 'buying@northwind.example'],
    );

    const v1Price = price(SEED_V1_SCOPE, DEFAULT_CARD);
    const startAt = now;
    const endAt = addMonths(now, SEED_V1_SCOPE.durationMonths);
    const hash = contentHash({
      creatorId, clientId, assetId, parentId: null, versionNo: 1,
      scope: SEED_V1_SCOPE, rateCard: DEFAULT_CARD, totalCents: v1Price.totalCents,
    });
    const { id: v1Id } = await one<{ id: string }>(
      tx,
      `insert into licence_versions
         (creator_id, client_id, asset_id, parent_id, version_no, scope, rate_card, total_cents, paid_cents,
          rail, start_at, end_at, renewal_opt_in, content_hash, status)
       values ($1, $2, $3, null, 1, $4, $5, $6, $6, 'order', $7, $8, false, $9, 'active') returning id`,
      [creatorId, clientId, assetId, JSON.stringify(SEED_V1_SCOPE), JSON.stringify(DEFAULT_CARD), v1Price.totalCents, startAt, endAt, hash],
    );

    await tx.query(
      `insert into orders (creator_id, version_id, paypal_order_id, custom_id, state) values ($1, $2, $3, $4, 'completed')`,
      [creatorId, v1Id, 'SEED-ORDER-V1', v1Id],
    );
    await tx.query(
      `insert into payments (creator_id, version_id, paypal_txn_id, amount_cents, currency, payer_email, paid_at, created_at)
       values ($1, $2, $3, $4, 'USD', null, $5, $5)`,
      [creatorId, v1Id, SEED_V1_TXN_ID, v1Price.totalCents, now],
    );

    // Batch-6 review F9: the seeded receipt uses the live producer's shape (masked email, scope words, file + hash
    // of the exact web rendition `npm run db:files` writes for this asset), and a 32-byte public id.
    const asset = SEED_ASSETS[0];
    const body = grantReceiptBody({
      creatorName: 'Imani', clientName: 'Northwind Coffee', clientEmail: 'buying@northwind.example', payerEmail: null,
      title: asset.title, scope: SEED_V1_SCOPE, startAt, endAt, versionNo: 1, parentVersionNo: null,
    }, { txnId: SEED_V1_TXN_ID, amountCents: v1Price.totalCents, fileSha256: sha256Bytes(await webFile(SEED_ASSETS[0].title, 0)), paypalInvoiceId: null, invoiceNumber: null }, now);
    await tx.query(
      `insert into receipts (creator_id, version_id, status, public_id, body) values ($1, $2, 'active', $3, $4)`,
      [creatorId, v1Id, newToken(), JSON.stringify(body)],
    );

    return { created: true, creatorId, clientId, assetIds, v1Id };
  });
}
