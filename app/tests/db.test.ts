import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openPglite, type Db } from '../db/client';
import { migrate } from '../db/migrate';
import { seed, SEED_V1_TXN_ID, type SeedResult } from '../db/seed';
import portfolio from '../public/portfolio/imani/photos.json';

let db: Db;
let seeded: SeedResult;

beforeAll(async () => {
  db = await openPglite();
});
afterAll(async () => {
  await db?.close();
});

describe('§7.6 migration + seed on PGlite', () => {
  it('migrate applies 001_init', async () => {
    expect(await migrate(db)).toEqual(['001_init.sql', '002_intake.sql', '003_policy.sql', '004_invoice_recipient.sql', '005_payments.sql', '006_send_attempt.sql', '007_b6_fixes.sql', '008_b6_round2.sql', '009_row_seq.sql', '010_b8_renewal.sql', '011_page_confirmation.sql', '012_rls.sql']);
  });

  it('re-running migrate is a no-op', async () => {
    expect(await migrate(db)).toEqual([]);
    const rows = await db.query<{ n: number }>(`select count(*)::int as n from schema_migrations`);
    expect(rows[0]?.n).toBe(12);
  });

  it('enables RLS without public policies on every public table, including migration history', async () => {
    const tables = await db.query<{ relname: string; relrowsecurity: boolean }>(
      `select c.relname, c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind in ('r', 'p') order by c.relname`);
    expect(tables).toHaveLength(24);
    expect(tables.find((t) => t.relname === 'schema_migrations')?.relrowsecurity).toBe(true);
    expect(tables.filter((t) => !t.relrowsecurity)).toEqual([]);
    expect(await db.query(`select tablename from pg_policies where schemaname = 'public'`)).toEqual([]);
  });

  it('seed applies cleanly and matches batch-2 §6', async () => {
    seeded = await seed(db, new Date('2026-10-28T12:00:00Z'));
    expect(seeded.created).toBe(true);

    const [settings] = await db.query(`select * from creator_settings where creator_id = $1`, [seeded.creatorId]);
    expect(settings).toMatchObject({
      per_deal_cap_cents: 50000, daily_max_sends: 10, rolling30_cap_cents: 150000,
      auto_channels: ['social', 'web', 'print'], ask_channels: ['billboard', 'exclusive'], timezone: 'America/New_York',
    });

    const card = await db.query<{ n: number; total: number }>(
      `select count(*)::int as n, sum(cents)::int as total from rate_card_options where creator_id = $1`, [seeded.creatorId]);
    expect(card[0]).toEqual({ n: 11, total: 15000 + 10000 + 42000 + 90000 + 90000 + 150000 + 0 + 10000 + 30000 + 15000 + 30000 });

    const assets = await db.query<{ is_public: boolean }>(`select is_public from assets where creator_id = $1`, [seeded.creatorId]);
    expect(assets).toHaveLength(3 + 22);
    expect(assets.filter((a) => a.is_public)).toHaveLength(2 + 22);

    // Batch 7: the portfolio photos, public, in photos.json order, after the original three. B9 9.1: the Morning Pour
    // and Harbor Light manifest photos belong to those original assets, so they add no row.
    const ownRows = portfolio.photos.filter((p) => p.title !== 'Morning Pour' && p.title !== 'Harbor Light');
    const photos = await db.query<{ id: string; title: string; key_web: string }>(
      `select id, title, key_web from assets where creator_id = $1 and is_public and key_original like 'imani/portfolio/%' order by created_at`,
      [seeded.creatorId]);
    expect(photos.map((p) => p.title)).toEqual(ownRows.map((p) => p.title));
    expect(photos.map((p) => p.key_web)).toEqual(ownRows.map((p) => `imani/portfolio/${p.num}/web.jpg`));
    expect(seeded.assetIds.slice(3)).toEqual(photos.map((p) => p.id));

    const [client] = await db.query(`select name, allowed from clients where id = $1`, [seeded.clientId]);
    expect(client).toEqual({ name: 'Northwind Coffee', allowed: true });

    const [v1] = await db.query<Record<string, unknown> & { start_at: Date; end_at: Date }>(
      `select * from licence_versions where id = $1`, [seeded.v1Id]);
    expect(v1).toMatchObject({
      version_no: 1, parent_id: null, total_cents: 30000, paid_cents: 30000, rail: 'order', status: 'active',
      scope: { channels: ['social'], territory: 'US', durationMonths: 6, exclusive: false },
    });
    expect(v1?.start_at.toISOString()).toBe('2026-10-28T12:00:00.000Z');
    expect(v1?.end_at.toISOString()).toBe('2027-04-28T12:00:00.000Z');

    const [payment] = await db.query(`select paypal_txn_id, amount_cents, currency from payments where version_id = $1`, [seeded.v1Id]);
    expect(payment).toEqual({ paypal_txn_id: SEED_V1_TXN_ID, amount_cents: 30000, currency: 'USD' });

    // Batch-6 review F9: the seeded receipt has the live producer's shape and a 32-byte public id.
    const [receipt] = await db.query<{ status: string; public_id: string; body: Record<string, unknown> & { asset: { file: string }; priceCents: number; licensee: { email: string } } }>(
      `select status, public_id, body from receipts where version_id = $1`, [seeded.v1Id]);
    expect(receipt?.status).toBe('active');
    expect(receipt?.public_id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(receipt?.body).toMatchObject({ kind: 'grant', versionNo: 1, priceCents: 30000, asset: { file: 'web', fileLabel: 'Web file' }, scope: { words: 'Social, US, 6 mo' } });
    expect(receipt?.body.licensee.email).toBe('b*****@northwind.example');
  });

  it('re-running seed writes nothing', async () => {
    const again = await seed(db);
    expect(again).toMatchObject({ created: false, creatorId: seeded.creatorId, clientId: seeded.clientId, v1Id: seeded.v1Id });
    const rows = await db.query<{ n: number }>(`select count(*)::int as n from licence_versions`);
    expect(rows[0]?.n).toBe(1);
    expect(again.assetIds).toEqual(seeded.assetIds);
  });

  it('re-running seed on a pre-batch-7 database adds only the missing portfolio photos, in order', async () => {
    await db.query(`delete from assets where key_original in ('imani/portfolio/05/original.jpg', 'imani/portfolio/24/original.jpg')`);
    const again = await seed(db);
    expect(again.created).toBe(false);
    const photos = await db.query<{ title: string }>(
      `select title from assets where creator_id = $1 and key_original like 'imani/portfolio/%' order by key_original`, [seeded.creatorId]);
    expect(photos.map((p) => p.title)).toEqual(portfolio.photos.filter((p) => p.title !== 'Morning Pour' && p.title !== 'Harbor Light').map((p) => p.title));
    const rows = await db.query<{ n: number }>(`select count(*)::int as n from assets`);
    expect(rows[0]?.n).toBe(3 + 22);
  });
});

describe('one non-cancelled payable object per version', () => {
  const invoiceNo = (versionId: string) => `UR-${versionId.replace(/-/g, '').slice(0, 22)}`;

  it('blocks an invoice while the seeded order is open, allows it once the order is cancelled', async () => {
    const insertInvoice = () => db.query(
      `insert into invoices (creator_id, version_id, invoice_number, state) values ($1, $2, $3, 'creating')`,
      [seeded.creatorId, seeded.v1Id, invoiceNo(seeded.v1Id)]);
    await expect(insertInvoice()).rejects.toThrow(/open order/);
    await db.query(`update orders set state = 'cancelled' where version_id = $1`, [seeded.v1Id]);
    await insertInvoice();
    // Reopening the order now conflicts with the open invoice.
    await expect(db.query(`update orders set state = 'completed' where version_id = $1`, [seeded.v1Id])).rejects.toThrow(/open invoice/);
  });

  it('blocks a second open order on the same version', async () => {
    await db.query(`update invoices set state = 'cancelled' where version_id = $1`, [seeded.v1Id]);
    const insertOrder = () => db.query(
      `insert into orders (creator_id, version_id, custom_id, state) values ($1, $2, $3, 'created')`,
      [seeded.creatorId, seeded.v1Id, seeded.v1Id]);
    await insertOrder();
    await expect(insertOrder()).rejects.toThrow(/duplicate key|unique/);
  });

  it('rejects an invoice_number that is not UR- plus 22 hex', async () => {
    await expect(
      db.query(`insert into invoices (creator_id, version_id, invoice_number, state) values ($1, $2, 'UR-123', 'cancelled')`,
        [seeded.creatorId, seeded.v1Id]),
    ).rejects.toThrow(/check/);
  });
});
