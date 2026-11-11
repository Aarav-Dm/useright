// LIVE sandbox invoice test (batch-5 §6, fixes 6, 10). Skipped unless LIVE_PAYPAL=1. Run once with:
//   set LIVE_PAYPAL=1, then
//   npx vitest run tests/paypal.live.test.ts (credentials set in the environment)
// Sends one real sandbox invoice for the $420 demo deal, reads it back, then cancels it so the ledger stays clean.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openPglite, type Db } from '../db/client';
import { migrate } from '../db/migrate';
import { seed, type SeedResult } from '../db/seed';
import { createAdapter, fixtureProvider } from '../lib/ai/extract';
import { confirmTranscript, getBriefView, type AiFor } from '../lib/briefs';
import { intake } from '../lib/intake';
import { createPayPalClient } from '../lib/paypal/client';
import { createInvoiceApi } from '../lib/paypal/invoices';
import { cancelAndRequote, runAutopilot } from '../lib/send';
import * as T from './fixtures/texts';

const live = process.env.LIVE_PAYPAL === '1';
const aiFor: AiFor = (fixture) => createAdapter(fixtureProvider(fixture ?? 'paste'));

describe.skipIf(!live)('LIVE_PAYPAL: sandbox invoice for the $420 demo deal', () => {
  let db: Db;
  let s: SeedResult;
  let dir: string;
  beforeAll(async () => {
    db = await openPglite();
    await migrate(db);
    s = await seed(db);
    dir = await mkdtemp(join(tmpdir(), 'ur-live-'));
  });
  afterAll(async () => {
    await db?.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('autopilot sends a real invoice via the Agent Toolkit (REST fallback), reads it back, then cancels it', { timeout: 120_000 }, async () => {
    const client = createPayPalClient();
    // B5 review 3: this test sends a real invoice; it must never run against live PayPal.
    if (client.credentials().base !== 'https://api-m.sandbox.paypal.com') throw new Error('LIVE_PAYPAL test refuses to run: PayPal host is not the sandbox');
    const api = createInvoiceApi(client);
    const deps = { db, aiFor, uploadsDir: dir, env: { AI_PROVIDER: 'fixture', NODE_ENV: 'test' } as unknown as NodeJS.ProcessEnv };
    const r = await intake(deps, { source: 'paste', clientId: s.clientId, assetId: s.assetIds[0]!, text: 'Placeholder until the transcript is confirmed.', fixture: 'demo-dm' }, { creator: true, sessionSlug: 'imani' });
    if (!r.ok) throw new Error(r.error);
    await confirmTranscript(db, aiFor, r.briefId, T.DEMO_DM);

    const out = await runAutopilot(db, api, r.briefId);
    expect(out.action).toBe('sent');
    if (out.action !== 'sent') return;
    const id = out.send.paypalInvoiceId;
    console.log(`[live] sandbox invoice ${id} (${out.send.invoiceNumber})`);
    try {
      const inv = await api.get(id);
      // PayPal omits configuration.partial_payment when partial payment is off (seen live 2026-10-29).
      expect(inv).toMatchObject({ status: 'SENT', invoiceNumber: out.send.invoiceNumber, amountValue: '420.00', currency: 'USD', allowTip: false });
      expect(inv.allowPartial).not.toBe(true);
      expect(inv.payerUrl).toMatch(/^https:\/\/www\.sandbox\.paypal\.com\//);
      expect((await getBriefView(db, r.briefId))!.status).toBe('invoiced');
    } finally {
      // Fix 10: always cancel what we created, even when a check above fails.
      expect(await cancelAndRequote(db, api, s.creatorId, r.briefId)).toEqual({ ok: true });
      expect((await api.get(id)).status).toBe('CANCELLED');
      console.log(`[live] cancelled ${id}`);
    }
  });
});
