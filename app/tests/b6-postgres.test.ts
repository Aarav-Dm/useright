// Batch-6 fix round 2 (review R4, review major 2): the F3 grant and F7 download races on a real PostgreSQL pool, where
// separate connections really contend for the advisory locks. PGlite is one connection and serialises them, so these
// only run with TEST_DATABASE_URL set, in a throwaway schema:
//   TEST_DATABASE_URL=postgres://... npx vitest run tests/b6-postgres.test.ts tests/concurrency.test.ts --no-file-parallelism
// This is the H2 gate's executable path; a run against Supabase is the human/live step.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { openPostgres, type Db } from '../db/client';
import { migrate } from '../db/migrate';
import { seed, type SeedResult } from '../db/seed';
import { createAdapter, fixtureProvider } from '../lib/ai/extract';
import { getBriefView, type AiFor } from '../lib/briefs';
import { grantIfPaid, revokeFromCapture, type GrantDeps } from '../lib/grant';
import { intake, type IntakeDeps } from '../lib/intake';
import { consumeDownload, issueDownload, rotatePayLink } from '../lib/pay';
import { ensureAssetFiles } from '../lib/placeholder-files';
import { runAutopilot } from '../lib/send';
import { hashToken } from '../lib/tokens';
import * as T from './fixtures/texts';
import { assertTestSchema, refusePooler } from './helpers/pg-guard';
import { mockInvoiceApi } from './helpers/mock-paypal';

const url = process.env.TEST_DATABASE_URL;
const SCHEMA = 'ur_b6_races';
const aiFor: AiFor = (fixture) => createAdapter(fixtureProvider(fixture ?? 'paste'));
const creator = { creator: true, sessionSlug: 'imani' };

describe.skipIf(!url)('batch 6 races on real Postgres (TEST_DATABASE_URL)', () => {
  let db: Db;
  let s: SeedResult;
  let deps: IntakeDeps;
  let uploadsDir: string;
  let harborLight: string;
  let morningPour: string;
  let m: ReturnType<typeof mockInvoiceApi>;
  let g: GrantDeps;

  beforeAll(async () => {
    refusePooler(url!);
    const admin = await openPostgres(url!, { max: 1 });
    await admin.query(`drop schema if exists ${SCHEMA} cascade`);
    await admin.query(`create schema ${SCHEMA}`);
    await admin.close();
    db = await openPostgres(url!, { searchPath: `${SCHEMA}, public`, max: 8 });
    await assertTestSchema(db, SCHEMA); // before any write: migrate/seed must not reach public tables
    await migrate(db);
    s = await seed(db);
    [morningPour, harborLight] = s.assetIds as [string, string];
    uploadsDir = await mkdtemp(join(tmpdir(), 'ur-b6pg-'));
    await ensureAssetFiles(db, uploadsDir);
    deps = { db, aiFor, uploadsDir, env: { AI_PROVIDER: 'fixture', NODE_ENV: 'test' } as unknown as NodeJS.ProcessEnv };
  }, 120_000);
  afterAll(async () => {
    await db?.query(`drop schema if exists ${SCHEMA} cascade`);
    await db?.close();
    if (uploadsDir) await rm(uploadsDir, { recursive: true, force: true });
  });
  beforeEach(async () => {
    await assertTestSchema(db, SCHEMA, 2);
    m = mockInvoiceApi();
    g = { db, pp: m.pp, uploadsDir };
    await db.query(`update autopilot_sends set status = 'released' where status in ('reserved', 'sent')`);
    await db.query(`update creator_settings set per_deal_cap_cents = 50000, daily_max_sends = 50, rolling30_cap_cents = 10000000 where creator_id = $1`, [s.creatorId]);
    await db.query(`update licence_versions set status = 'superseded' where status in ('active', 'pending') and id <> $1`, [s.v1Id]);
    await db.query(`update licence_versions set status = 'active' where id = $1`, [s.v1Id]);
  });

  const paste = async (fixture: string, text: string, assetId: string) => {
    const r = await intake(deps, { source: 'paste', clientId: s.clientId, assetId, text, fixture }, creator);
    if (!r.ok) throw new Error(r.error);
    expect(await runAutopilot(db, m.api, r.briefId)).toMatchObject({ action: 'sent' });
    const v = (await getBriefView(db, r.briefId))!.version!;
    return { briefId: r.briefId, versionId: v.id, paypalId: v.invoice!.paypalInvoiceId!, token: v.invoice!.payPath!.split('/').pop()! };
  };
  const status = async (id: string) => (await db.query<{ status: string }>(`select status from licence_versions where id = $1`, [id]))[0]!.status;
  const activeCount = async () => (await db.query<{ n: number }>(
    `select count(*)::int as n from licence_versions where client_id = $1 and asset_id = $2 and status = 'active'`, [s.clientId, harborLight]))[0]!.n;

  it('F3: two pending siblings of v1 paid at once -> one active successor, the other locked with an alert', async () => {
    const v1 = await paste('suggests-price', T.SUGGESTS_PRICE, harborLight);
    m.pay(v1.paypalId);
    expect((await grantIfPaid(g, v1.versionId, 'test')).granted).toBe(true);
    const a = await paste('paste', T.PASTE, harborLight);
    const b = await paste('paste', T.PASTE, harborLight);
    m.pay(a.paypalId);
    m.pay(b.paypalId);
    const res = await Promise.all([grantIfPaid(g, a.versionId, 'test'), grantIfPaid(g, b.versionId, 'test')]);
    expect(res.filter((r) => r.granted)).toHaveLength(1);
    expect(res.filter((r) => !r.granted && r.reason === 'stale_version')).toHaveLength(1);
    expect(await activeCount()).toBe(1);
    const loser = res[0]!.granted ? b : a;
    expect(await status(loser.versionId)).toBe('pending');
    expect((await db.query(`select 1 from events where kind = 'paid_on_stale_version' and detail->>'versionId' = $1`, [loser.versionId])).length).toBe(1);
  });

  it('F3: two root quotes paid at once -> one active licence', async () => {
    const a = await paste('suggests-price', T.SUGGESTS_PRICE, harborLight);
    const b = await paste('suggests-price', T.SUGGESTS_PRICE, harborLight);
    m.pay(a.paypalId);
    m.pay(b.paypalId);
    const res = await Promise.all([grantIfPaid(g, a.versionId, 'test'), grantIfPaid(g, b.versionId, 'test')]);
    expect(res.filter((r) => r.granted)).toHaveLength(1);
    expect(await activeCount()).toBe(1);
  });

  it('R1: a grant racing a reversal of the same capture never leaves a usable licence', async () => {
    const d = await paste('suggests-price', T.SUGGESTS_PRICE, harborLight);
    const txn = m.pay(d.paypalId);
    m.reverse(txn); // the invoice still reads PAID
    await Promise.all([grantIfPaid(g, d.versionId, 'test'), revokeFromCapture(g, txn, 'webhook')]);
    expect(['refunded', 'superseded']).toContain(await status(d.versionId));
    expect(await issueDownload(db, d.token)).toMatchObject({ ok: false });
  });

  const paidDemo = async () => {
    const id = (await intake(deps, { source: 'paste', clientId: s.clientId, assetId: morningPour, text: T.DEMO_DM.lines.filter((l) => l.speaker === 'client').map((l) => `client: ${l.text}`).join('\n'), fixture: 'demo-dm' }, creator));
    if (!id.ok) throw new Error(id.error);
    const { confirmTranscript } = await import('../lib/briefs');
    await confirmTranscript(db, aiFor, id.briefId, T.DEMO_DM);
    expect(await runAutopilot(db, m.api, id.briefId)).toMatchObject({ action: 'sent' });
    const v = (await getBriefView(db, id.briefId))!.version!;
    const txn = m.pay(v.invoice!.paypalInvoiceId!);
    expect((await grantIfPaid(g, v.id, 'test')).granted).toBe(true);
    return { briefId: id.briefId, versionId: v.id, token: v.invoice!.payPath!.split('/').pop()!, txn };
  };

  it('F7: concurrent downloads at uses=2 -> exactly one success', async () => {
    const d = await paidDemo();
    const dl = await issueDownload(db, d.token);
    if (!dl.ok) throw new Error(dl.error);
    const t = dl.url.split('/').pop()!;
    await db.query(`update download_tokens set uses = 2 where token_hash = $1`, [hashToken(t)]);
    const res = await Promise.all([1, 2, 3, 4].map(() => consumeDownload(db, uploadsDir, t)));
    expect(res.filter((r) => r.ok)).toHaveLength(1);
    expect(await db.query(`select uses from download_tokens where token_hash = $1`, [hashToken(t)])).toEqual([{ uses: 3 }]);
  });

  it('F7: download issuance racing link rotation never leaves a usable token from the old link', async () => {
    const d = await paidDemo();
    const [issued] = await Promise.all([issueDownload(db, d.token), rotatePayLink(db, s.creatorId, d.briefId)]);
    if (issued.ok) expect(await consumeDownload(db, uploadsDir, issued.url.split('/').pop()!)).toMatchObject({ ok: false, status: 410 });
    else expect(issued.status).toBe(404);
  });

  it('F7: a refund committed while a download is being prepared stops the download', async () => {
    const d = await paidDemo();
    const dl = await issueDownload(db, d.token);
    if (!dl.ok) throw new Error(dl.error);
    m.refund(d.txn);
    const r = await consumeDownload(db, uploadsDir, dl.url.split('/').pop()!, { beforeAuthorize: async () => { await revokeFromCapture(g, d.txn, 'webhook'); } });
    expect(r).toMatchObject({ ok: false, status: 410 });
  });
});
