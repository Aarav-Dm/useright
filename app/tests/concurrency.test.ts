// Spec §8 "two concurrent sends at the cap -> only one goes" (batch-5 fixes 5, 10, 17). PGlite is one connection,
// so this only runs against real Postgres: TEST_DATABASE_URL=postgres://... npx vitest run tests/concurrency.test.ts
// KNOWN GAP until Supabase exists; it must run green before batch 6 is signed off.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openPostgres, type Db } from '../db/client';
import { migrate } from '../db/migrate';
import { seed, type SeedResult } from '../db/seed';
import { createAdapter, fixtureProvider } from '../lib/ai/extract';
import { confirmTranscript, type AiFor } from '../lib/briefs';
import { intake, type IntakeDeps } from '../lib/intake';
import { approve, runAutopilot } from '../lib/send';
import { pendingVersionFor } from '../lib/versions';
import * as T from './fixtures/texts';
import { assertTestSchema, refusePooler } from './helpers/pg-guard';
import { mockInvoiceApi } from './helpers/mock-paypal';

const url = process.env.TEST_DATABASE_URL;
const aiFor: AiFor = (fixture) => createAdapter(fixtureProvider(fixture ?? 'paste'));

describe.skipIf(!url)('concurrency on real Postgres (TEST_DATABASE_URL)', () => {
  let db: Db;
  let s: SeedResult;
  let deps: IntakeDeps;
  beforeAll(async () => {
    // B5 review 3: create the throwaway schema on its own connection, then open the pool with search_path as a
    // startup parameter so every pooled connection (and the transaction pooler) uses it.
    refusePooler(url!);
    const admin = await openPostgres(url!, { max: 1 });
    await admin.query(`drop schema if exists ur_concurrency cascade`);
    await admin.query(`create schema ur_concurrency`);
    await admin.close();
    db = await openPostgres(url!, { searchPath: 'ur_concurrency, public' });
    await assertTestSchema(db, 'ur_concurrency', 5); // review 5bae423 #2: before any write
    await migrate(db);
    s = await seed(db);
    deps = { db, aiFor, uploadsDir: '.uploads-concurrency', env: { AI_PROVIDER: 'fixture', NODE_ENV: 'test' } as unknown as NodeJS.ProcessEnv };
  });
  afterAll(async () => {
    await db?.query(`drop schema if exists ur_concurrency cascade`);
    await db?.close();
  });

  const demo = async () => {
    const r = await intake(deps, { source: 'paste', clientId: s.clientId, assetId: s.assetIds[0]!, text: T.DEMO_DM.lines.filter((l) => l.speaker === 'client').map((l) => `client: ${l.text}`).join('\n'), fixture: 'demo-dm' }, { creator: true, sessionSlug: 'imani' });
    if (!r.ok) throw new Error(r.error);
    await confirmTranscript(db, aiFor, r.briefId, T.DEMO_DM);
    return r.briefId;
  };

  it('two autopilot sends with one slot left under the daily max -> only one goes', async () => {
    await db.query(`update creator_settings set daily_max_sends = 1 where creator_id = $1`, [s.creatorId]);
    const pp = mockInvoiceApi();
    const [a, b] = [await demo(), await demo()];
    const results = await Promise.all([runAutopilot(db, pp.api, a), runAutopilot(db, pp.api, b)]);
    expect(results.filter((r) => r.action === 'sent')).toHaveLength(1);
    expect(results.filter((r) => r.action === 'needs_approval')).toHaveLength(1);
    expect(pp.count('create')).toBe(1);
  });

  it('two parallel approves of one quote -> one invoice', async () => {
    await db.query(`update creator_settings set per_deal_cap_cents = 100 where creator_id = $1`, [s.creatorId]);
    const pp = mockInvoiceApi();
    const id = await demo();
    await runAutopilot(db, pp.api, id);
    const pv = await pendingVersionFor(db, id);
    if (!pv.ok) throw new Error(pv.error);
    const out = await Promise.all([approve(db, pp.api, s.creatorId, { versionId: pv.version.id }, '420'), approve(db, pp.api, s.creatorId, { versionId: pv.version.id }, '420')]);
    // review 12: exactly one call made the invoice; the other returned it (already) or was told it is in flight.
    expect(out.filter((r) => r.ok && !r.send.already)).toHaveLength(1);
    expect(pp.count('create')).toBe(1);
  });
});
