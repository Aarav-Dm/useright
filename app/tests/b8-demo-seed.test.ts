// B8 review fix 8 (review 1): the demo seed holds a licence whose renewal the tick sends on camera with no click.
// Its own PayPal Invoicing calls go to the in-memory mock here.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openPglite, type Db } from '../db/client';
import { initialize } from '../db/init';
import { advanceToNextRenewal } from '../lib/clock';
import { listLedger } from '../lib/ledger';
import { runTick } from '../lib/renewal';
import { mockInvoiceApi } from './helpers/mock-paypal';

let db: Db;
let dir: string;
let creatorId: string;
let briefs: Record<string, string>;
const DEMO = { DEMO_MODE: '1' };

beforeAll(async () => {
  process.env.PUBLIC_BASE_URL ??= 'https://useright.example';
  db = await openPglite();
  dir = await mkdtemp(join(tmpdir(), 'ur-b8-demo-'));
  const r = await initialize(db, dir);
  creatorId = r.seed.creatorId;
  briefs = r.demo.briefs;
});
afterAll(async () => {
  await db?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe('review fix 8: the filmable renewal', () => {
  it('the seeded Pinecrest licence is $300 with the box ticked, and ends before every other renewable licence', async () => {
    const [v] = await db.query<{ id: string; total_cents: number; renewal_opt_in: boolean; end_at: Date; txn: string }>(
      `select v.id, v.total_cents, v.renewal_opt_in, v.end_at, p.paypal_txn_id as txn
         from licence_versions v join payments p on p.version_id = v.id where v.brief_id = $1`, [briefs.renewable]);
    expect(v).toMatchObject({ total_cents: 30000, renewal_opt_in: true });
    expect(v!.txn).toMatch(/^SEED-DEMO-RENEW-/); // still a demo payment wherever it is shown
    const [cap] = await db.query<{ per_deal_cap_cents: number }>(`select per_deal_cap_cents from creator_settings where creator_id = $1`, [creatorId]);
    expect(cap!.per_deal_cap_cents).toBe(50000); // no cap change
    const [northwind] = await db.query<{ end_at: Date }>(
      `select v.end_at from licence_versions v join clients c on c.id = v.client_id where c.name = 'Northwind Coffee' and v.status = 'active'`);
    expect(v!.end_at.getTime()).toBeLessThan(northwind!.end_at.getTime());
  });

  it('one Advance to the next renewal: the tick sends exactly one renewal invoice, for it, and expires nothing', async () => {
    const m = mockInvoiceApi();
    expect(await advanceToNextRenewal(db, creatorId, DEMO)).toMatchObject({ ok: true, moved: true });
    const tick = await runTick({ db, api: m.api, env: DEMO });
    expect(tick).toMatchObject({ renewals: { created: 1, sent: 1, held: 0 }, expired: 0 });
    expect(m.count('create')).toBe(1);
    const [renewal] = await db.query<{ total_cents: number; send_state: string; client: string }>(
      `select c.total_cents, c.send_state, cl.name as client from licence_versions c
         join licence_versions p on p.id = c.renewal_of join clients cl on cl.id = c.client_id where p.brief_id = $1`, [briefs.renewable]);
    expect(renewal).toMatchObject({ total_cents: 30000, send_state: 'sent', client: 'Pinecrest Hotels' });
    // Review fix 9 (review 8, 9): the client's choice carries to the renewal, and the tick names the renewal deal.
    const [r] = await db.query<{ brief_id: string; renewal_opt_in: boolean }>(
      `select c.brief_id, c.renewal_opt_in from licence_versions c join licence_versions p on p.id = c.renewal_of where p.brief_id = $1`, [briefs.renewable]);
    expect(r!.renewal_opt_in).toBe(true);
    expect(tick.deals).toEqual([r!.brief_id]);
    expect((await listLedger(db, creatorId)).find((r) => r.kind === 'renewal.sent')).toMatchObject({ label: 'Renewal sent', demo: false });
  });

  it('review fix 9 (review 6): seeded licences that end are counted apart and stay Demo-labelled', async () => {
    const m = mockInvoiceApi();
    const tick = await runTick({ db, api: m.api, env: DEMO, real: () => Date.now() + 3 * 365 * 24 * 3600 * 1000 });
    expect(tick.seededExpired).toBeGreaterThan(0);
    expect(tick.seededExpired).toBeLessThanOrEqual(tick.expired);
    const seeded = await db.query<{ id: string }>(
      `select v.id from licence_versions v where v.status = 'expired' and exists (select 1 from payments p where p.version_id = v.id and p.paypal_txn_id like 'SEED-DEMO-%')`);
    expect(seeded).toHaveLength(tick.seededExpired);
    const rows = (await listLedger(db, creatorId)).filter((x) => x.kind === 'expired' && seeded.some((s) => s.id === x.versionId));
    expect(rows).toHaveLength(seeded.length);
    for (const row of rows) expect(row.demo).toBe(true);
  });
});

describe('review B8 re-review N1: a database seeded before B8', () => {
  it('gets the Pinecrest licence added once, keeps its deals, and one Advance sends that renewal', async () => {
    const old = await openPglite();
    const oldDir = await mkdtemp(join(tmpdir(), 'ur-b8-old-'));
    try {
      const r = await initialize(old, oldDir);
      // Back to the B7 state: every row of the Harbor Light deal goes, the other deals stay.
      const brief = r.demo.briefs.renewable!;
      const [v] = await old.query<{ id: string }>(`select id from licence_versions where brief_id = $1`, [brief]);
      for (const sql of [`delete from receipts where version_id = $1`, `delete from payments where version_id = $1`, `delete from invoices where version_id = $1`]) await old.query(sql, [v!.id]);
      await old.query(`delete from events where detail->>'briefId' = $1`, [brief]);
      await old.query(`delete from licence_versions where id = $1`, [v!.id]);
      for (const t of ['extractions', 'transcripts']) await old.query(`delete from ${t} where brief_id = $1`, [brief]);
      await old.query(`delete from briefs where id = $1`, [brief]);
      // The older seed's Northwind licence ended first, as it would on a database seeded weeks ago.
      await old.query(`update licence_versions v set end_at = now() + interval '60 days' from clients c where c.id = v.client_id and c.name = 'Northwind Coffee' and v.status = 'active'`);
      const counts = async () => (await old.query<{ n: number }>(`select count(*)::int as n from briefs`))[0]!.n;
      const before = await counts();

      const again = await initialize(old, oldDir);
      expect(again.demo.created).toBe(true);
      expect(Object.keys(again.demo.briefs)).toEqual(['renewable']);
      expect(await counts()).toBe(before + 1);
      expect((await initialize(old, oldDir)).demo.created).toBe(false);
      expect(await counts()).toBe(before + 1);

      const m = mockInvoiceApi();
      expect(await advanceToNextRenewal(old, r.seed.creatorId, DEMO)).toMatchObject({ ok: true, moved: true });
      const tick = await runTick({ db: old, api: m.api, env: DEMO });
      expect(tick).toMatchObject({ renewals: { created: 1, sent: 1, held: 0 } });
      const [renewal] = await old.query<{ total_cents: number; client: string; brief: string }>(
        `select c.total_cents, cl.name as client, p.brief_id as brief from licence_versions c
           join licence_versions p on p.id = c.renewal_of join clients cl on cl.id = c.client_id`);
      expect(renewal).toMatchObject({ total_cents: 30000, client: 'Pinecrest Hotels', brief: again.demo.briefs.renewable });
    } finally {
      await old.close();
      await rm(oldDir, { recursive: true, force: true });
    }
  }, 60_000);
});
