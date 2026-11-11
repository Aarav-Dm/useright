// Batch 7 (7A): the demo seed gives every dashboard state through the real read models.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openPglite, type Db } from '../db/client';
import { initialize } from '../db/init';
import { seedDemo } from '../db/seed-demo';
import { getBriefView } from '../lib/briefs';
import { listDeals } from '../lib/deals';
import { listAlerts, listAsk, listLedger } from '../lib/ledger';
import { receiptView } from '../lib/receipts';
import { readAsset, sha256Bytes } from '../lib/storage';

let db: Db;
let dir: string;
let creatorId: string;
let briefs: Record<string, string>;

beforeAll(async () => {
  db = await openPglite();
  dir = await mkdtemp(join(tmpdir(), 'ur-b7-demo-'));
  const r = await initialize(db, dir);
  creatorId = r.seed.creatorId;
  briefs = r.demo.briefs;
});
afterAll(async () => {
  await db?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe('demo seed v2', () => {
  it('covers every deal state the dashboard shows', async () => {
    expect(Object.keys(briefs).sort()).toEqual(['invoiced', 'needsApproval', 'needsYou', 'paid', 'ready', 'refunded', 'rejected', 'renewable', 'withdrawn']);
    const deals = await listDeals(db, creatorId);
    const status = (key: string) => deals.find((d) => d.briefId === briefs[key])?.status;
    expect(status('ready')).toBe('ready');
    expect(status('needsYou')).toBe('needs_creator');
    expect(status('needsApproval')).toBe('needs_approval');
    expect(status('invoiced')).toBe('invoiced');
    expect(status('paid')).toBe('paid');
    expect(status('renewable')).toBe('paid');
    expect(status('refunded')).toBe('refunded');
    expect(status('withdrawn')).toBe('cancelled');
    expect(status('rejected')).toBe('rejected');
    // newest first, with a believable timeline
    expect(deals[0]!.briefId).toBe(briefs.ready);
    expect(deals.find((d) => d.briefId === briefs.needsYou)).toMatchObject({ client: null, reasons: ['unknown_sender'], gapTotalCents: 30000 });
  });

  it('puts the $900 billboard quote in Ask me with both stops, and the withdrawal as an alert', async () => {
    const ask = await listAsk(db, creatorId);
    expect(ask).toHaveLength(1);
    expect(ask[0]).toMatchObject({ briefId: briefs.needsApproval, totalCents: 90000, versionNo: 2, hardBlock: false, client: { name: 'Northwind Coffee' }, asset: { title: 'Morning Pour' } });
    expect(ask[0]!.failing.map((f) => f.code)).toEqual(['over_deal_cap:90000:50000', 'needs_approval:billboard']);
    const alerts = await listAlerts(db, creatorId);
    expect(alerts.map((a) => [a.kind, a.briefId])).toEqual([['revoked_by_parent_refund', briefs.withdrawn]]);
  });

  it('writes ledger rows for rules, sends, payment, refund and rejection, all marked as demo data', async () => {
    const rows = await listLedger(db, creatorId);
    const kinds = new Set(rows.map((r) => r.kind));
    for (const k of ['rule', 'invoice.creating', 'invoice.sent', 'grant', 'revoked', 'invoice.cancelled', 'revoked_by_parent_refund', 'rejected']) expect(kinds).toContain(k);
    const grant = rows.find((r) => r.kind === 'grant' && r.briefId === briefs.paid)!;
    expect(grant).toMatchObject({ result: 'pass', label: 'Granted', amountCents: 40000, deal: 'Quayside Press · Laptop Desk from Above' });
    expect(grant.paypalTxnId).toMatch(/^SEED-DEMO-/);
    expect(grant.paypalInvoiceId).toMatch(/^INV2-DEMO-/);
    const events = await db.query<{ n: number }>(`select count(*)::int as n from events where creator_id = $1 and (detail->>'demo')::boolean is not true`, [creatorId]);
    expect(events[0]!.n).toBe(0);
  });

  it('issues receipts whose file hash is the exact placeholder file the download serves', async () => {
    const rows = await db.query<{ public_id: string; status: string; version_id: string }>(
      `select r.public_id, r.status, r.version_id from receipts r join licence_versions v on v.id = r.version_id where v.brief_id is not null order by r.seq`);
    expect(rows.map((r) => r.status)).toEqual(['active', 'refunded', 'active', 'active']);
    for (const r of rows) {
      const view = (await receiptView(db, r.public_id))!;
      const [a] = await db.query<{ key_web: string; key_print: string }>(`select a.key_web, a.key_print from licence_versions v join assets a on a.id = v.asset_id where v.id = $1`, [r.version_id]);
      const bytes = await readAsset(dir, view.body.asset.file === 'print' ? a!.key_print : a!.key_web);
      expect(sha256Bytes(bytes!)).toBe(view.body.asset.sha256);
    }
    const paid = rows[2]!;
    expect((await receiptView(db, paid.public_id))!.liveStatus).toBe('active');
  });

  it('every demo deal opens in the deal room', async () => {
    for (const id of Object.values(briefs)) {
      const v = await getBriefView(db, id);
      expect(v?.transcript?.lines.length).toBeGreaterThan(0);
      expect(v?.extraction?.model).toBe('demo-seed');
    }
    const ready = (await getBriefView(db, briefs.ready!))!;
    expect(ready.gapPreview?.totalCents).toBe(30000);
    expect(ready.extraction?.suggested_price_cents).toBe(25000);
  });

  it('is idempotent and leaves the live demo paths open', async () => {
    expect((await seedDemo(db)).created).toBe(false);
    expect((await initialize(db, dir)).filesWritten).toBe(0);
    // R3 budget untouched: the demo writes no autopilot sends.
    const sends = await db.query<{ n: number }>(`select count(*)::int as n from autopilot_sends`);
    expect(sends[0]!.n).toBe(0);
    // Northwind keeps one active licence on Morning Pour (the RUNBOOK Run A base).
    const active = await db.query<{ n: number }>(
      `select count(*)::int as n from licence_versions v join assets a on a.id = v.asset_id where a.title = 'Morning Pour' and v.status = 'active'`);
    expect(active[0]!.n).toBe(1);
  });
});
