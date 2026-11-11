// @vitest-environment jsdom
// Audit row 1 (useright/docs/reviews/audit-product.md) and B12 Part E item 7 (docs/batch-12.md):
// Stale-version approve money bug regression.
// After the print upgrade on Morning Pour is paid (v1 superseded, v2 active), approving the older
// seeded Social and Billboard card must stop before sending. Real route handlers on PGlite with mocked PayPal.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import AskPage from '@/app/(creator)/ask/page';
import { POST as askPOST } from '@/app/api/ask/route';
import { POST as decidePOST } from '@/app/api/briefs/[id]/decide/route';
import { POST as intakePOST } from '@/app/api/intake/route';
import { SAMPLES } from '@/components/creator/request-samples';
import { openPglite, type Db } from '../db/client';
import { initialize } from '../db/init';
import { grantIfPaid } from '../lib/grant';
import { setRouteDepsForTests } from '../lib/server';
import { sendInvoice } from '../lib/send';
import { runTick } from '../lib/renewal';
import { listAsk } from '../lib/ledger';
import { hashOf, loadVersion } from '../lib/versions';
import { mockInvoiceApi } from './helpers/mock-paypal';

const TOKEN = 'b12-stale-approve-token';
let db: Db;
let dir: string;
let m: ReturnType<typeof mockInvoiceApi>;
let ids: { clients: Record<string, string>; assets: Record<string, string> };
const saved = { token: process.env.CREATOR_TOKEN, origin: process.env.APP_ORIGIN, demo: process.env.DEMO_MODE };
const headers = { host: 'app.test', origin: 'http://app.test', cookie: `ur_creator=${TOKEN}`, 'content-type': 'application/json' };
const params = (id: string) => ({ params: Promise.resolve({ id }) });

const router = vi.hoisted(() => ({ replace() {}, push() {}, refresh() {} }));
vi.mock('next/navigation', () => ({ useRouter: () => router, usePathname: () => '/ask', useSearchParams: () => new URLSearchParams() }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

beforeAll(async () => {
  db = await openPglite();
  dir = await mkdtemp(join(tmpdir(), 'ur-b12-stale-'));
  await initialize(db, dir);
  process.env.CREATOR_TOKEN = TOKEN;
  delete process.env.APP_ORIGIN;
  m = mockInvoiceApi();
  setRouteDepsForTests({ db, uploadsDir: dir, invoices: m.api });
  const clients = await db.query<{ id: string; email: string }>(`select id, email from clients`);
  const assets = await db.query<{ id: string; title: string }>(`select id, title from assets`);
  ids = { clients: Object.fromEntries(clients.map((c) => [c.email, c.id])), assets: Object.fromEntries(assets.map((a) => [a.title, a.id])) };
});

afterAll(async () => {
  setRouteDepsForTests(null);
  if (saved.token === undefined) delete process.env.CREATOR_TOKEN; else process.env.CREATOR_TOKEN = saved.token;
  if (saved.origin !== undefined) process.env.APP_ORIGIN = saved.origin;
  if (saved.demo === undefined) delete process.env.DEMO_MODE; else process.env.DEMO_MODE = saved.demo;
  await db?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

beforeEach(() => m.reset());

async function submit(key: string) {
  const s = SAMPLES.find((x) => x.key === key)!;
  const body = { source: 'paste', clientId: ids.clients[s.clientEmail], assetId: ids.assets[s.assetTitle], text: s.text, fixture: s.fixture };
  const res = await intakePOST(new Request('http://app.test/api/intake', { method: 'POST', headers, body: JSON.stringify(body) }));
  expect(res.status).toBe(201);
  return ((await res.json()) as { briefId: string }).briefId;
}

const decide = (id: string, body: object) => decidePOST(new Request(`http://app.test/api/briefs/${id}/decide`, { method: 'POST', headers, body: JSON.stringify(body) }), params(id));
const ask = (body: object) => askPOST(new Request('http://app.test/api/ask', { method: 'POST', headers, body: JSON.stringify(body) }));
const paypalWrites = () => m.calls.filter((c) => c.op === 'create' || c.op === 'send');

describe('audit row 1: approving older seeded billboard quote after print upgrade is paid', () => {
  it('allows the valid print upgrade, then stops the obsolete billboard quote before creating an invoice', async () => {
    const northwindId = ids.clients['buying@northwind.example']!;
    const morningPourId = ids.assets['Morning Pour']!;

    // 1. Initial seeded state:
    // v1 is active (Morning Pour, Social, $300 paid).
    const [v1] = await db.query<{ id: string; status: string; total_cents: number; version_no: number }>(
      `select id, status, total_cents, version_no from licence_versions
        where client_id = $1 and asset_id = $2 and status = 'active'`,
      [northwindId, morningPourId]
    );
    expect(v1).toBeDefined();
    expect(v1!.status).toBe('active');
    expect(v1!.version_no).toBe(1);

    // The seeded billboard quote exists in pending state extending v1.
    const [seededBillboard] = await db.query<{ id: string; brief_id: string; parent_id: string; status: string; total_cents: number }>(
      `select id, brief_id, parent_id, status, total_cents from licence_versions
        where client_id = $1 and asset_id = $2 and total_cents = 90000 and status = 'pending'`,
      [northwindId, morningPourId]
    );
    expect(seededBillboard).toBeDefined();
    expect(seededBillboard!.parent_id).toBe(v1!.id);
    expect(seededBillboard!.status).toBe('pending');

    // 2. Client requests print upgrade via intake:
    // Autopilot prices gap ($420.00) and sends PayPal invoice.
    m.reset();
    const printBriefId = await submit('print');
    const [printVersion] = await db.query<{ id: string; status: string; total_cents: number }>(
      `select id, status, total_cents from licence_versions where brief_id = $1 and status = 'pending'`,
      [printBriefId]
    );
    expect(printVersion).toBeDefined();
    expect(printVersion!.total_cents).toBe(42000);

    const [printInv] = await db.query<{ id: string; paypal_invoice_id: string }>(
      `select id, paypal_invoice_id from invoices where version_id = $1 and state = 'sent'`,
      [printVersion!.id]
    );
    expect(printInv).toBeDefined();

    // Client pays the print upgrade invoice.
    m.pay(printInv!.paypal_invoice_id);
    const printGrant = await grantIfPaid({ db, pp: m.pp, uploadsDir: dir }, printVersion!.id, 'test');
    expect(printGrant).toMatchObject({ granted: true });

    // Print upgrade is now active, and parent v1 is superseded!
    const [v1AfterPrint] = await db.query<{ status: string }>(`select status from licence_versions where id = $1`, [v1!.id]);
    expect(v1AfterPrint!.status).toBe('superseded');
    const [printAfterGrant] = await db.query<{ status: string }>(`select status from licence_versions where id = $1`, [printVersion!.id]);
    expect(printAfterGrant!.status).toBe('active');

    // The older quote remains open, but must not reach PayPal with its stale parent.
    // In Ask me / deal room, the seeded $900 billboard quote is STILL 'pending', with parent_id = v1 (superseded).
    const [billboardBeforeApprove] = await db.query<{ status: string; parent_id: string }>(
      `select status, parent_id from licence_versions where id = $1`,
      [seededBillboard!.id]
    );
    expect(billboardBeforeApprove!.status).toBe('pending');
    expect(billboardBeforeApprove!.parent_id).toBe(v1!.id);

    // Creator approves the older quote after a different upgrade replaced its parent.
    m.reset();
    const approvalsBefore = await db.query(`select 1 from approvals where version_id = $1`, [seededBillboard!.id]);
    const decideRes = await decide(seededBillboard!.brief_id, { action: 'approve', typedTotal: '900.00' });
    expect(decideRes.status).toBe(409);
    expect(await decideRes.json()).toMatchObject({ code: 'parent_superseded' });
    expect(m.calls).toEqual([]);
    expect(await db.query(`select 1 from approvals where version_id = $1`, [seededBillboard!.id])).toEqual(approvalsBefore);

    const [billboardInv] = await db.query<{ id: string; paypal_invoice_id: string; state: string }>(
      `select id, paypal_invoice_id, state from invoices where version_id = $1 and state = 'sent'`,
      [seededBillboard!.id]
    );
    expect(billboardInv).toBeUndefined();

    // The licence version stays pending, locked, with no active status.
    const [billboardAfterPay] = await db.query<{ status: string }>(
      `select status from licence_versions where id = $1`,
      [seededBillboard!.id]
    );
    expect(billboardAfterPay!.status).toBe('pending');

    // Nothing was charged, so there is no paid-on-stale alert to clean up.
    const [alert] = await db.query<{ kind: string; detail: string }>(
      `select kind, detail from events where creator_id = (select creator_id from licence_versions where id = $1)
       and kind = 'paid_on_stale_version' order by created_at desc limit 1`,
      [seededBillboard!.id]
    );
    expect(alert).toBeUndefined();
  });

  // Both routes must apply the same first-send guard.

  it('deal-room approve: must refuse 409 and make no PayPal call when parent licence is superseded', async () => {
    const northwindId = ids.clients['buying@northwind.example']!;
    const morningPourId = ids.assets['Morning Pour']!;

    const [seededBillboard] = await db.query<{ id: string; brief_id: string }>(
      `select id, brief_id from licence_versions
        where client_id = $1 and asset_id = $2 and total_cents = 90000 and status = 'pending'`,
      [northwindId, morningPourId]
    );

    // Print upgrade is paid and active, so seededBillboard's parent is superseded.
    m.reset();
    const res = await decide(seededBillboard!.brief_id, { action: 'approve', typedTotal: '900.00' });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'parent_superseded' });
    expect(m.calls).toEqual([]);
  });

  it('direct Ask approve: must refuse 409 and make no PayPal call when parent licence is superseded', async () => {
    const northwindId = ids.clients['buying@northwind.example']!;
    const morningPourId = ids.assets['Morning Pour']!;

    const [seededBillboard] = await db.query<{ id: string }>(
      `select id from licence_versions
        where client_id = $1 and asset_id = $2 and total_cents = 90000 and status = 'pending'`,
      [northwindId, morningPourId]
    );

    m.reset();
    const res = await ask({ versionId: seededBillboard!.id, action: 'approve', typedTotal: '900.00' });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'parent_superseded' });
    expect(m.calls).toEqual([]);
  });

  it.each(['autopilot', 'approval'] as const)('releases a stale quote reservation in %s mode', async (mode) => {
    const [v] = await db.query<{ id: string }>(`select id from licence_versions where client_id = $1 and asset_id = $2 and total_cents = 90000 and status = 'pending'`, [ids.clients['buying@northwind.example'], ids.assets['Morning Pour']]);
    const [r] = await db.query<{ id: string }>(`insert into autopilot_sends (creator_id, client_id, version_id, status, amount_cents, expires_at) select creator_id, client_id, id, 'reserved', total_cents, now() + interval '1 hour' from licence_versions where id = $1 returning id`, [v!.id]);
    expect(await sendInvoice(db, m.api, v!.id, { mode })).toMatchObject({ ok: false, status: 409, code: 'parent_superseded' });
    expect(await db.query(`select status from autopilot_sends where id = $1`, [r!.id])).toEqual([{ status: 'released' }]);
    expect(m.calls).toEqual([]);
  });

  it('Retry of the approved stale quote with no invoice refuses as well', async () => {
    const [v] = await db.query<{ id: string; brief_id: string }>(`select id, brief_id from licence_versions where client_id = $1 and asset_id = $2 and total_cents = 90000 and status = 'pending'`, [ids.clients['buying@northwind.example'], ids.assets['Morning Pour']]);
    const version = (await loadVersion(db, v!.id))!;
    await db.query(`insert into approvals (creator_id, version_id, version_hash, amount_cents, recipient) values ($1, $2, $3, $4, $5)`, [version.creator_id, version.id, hashOf(version), version.total_cents, 'buying@northwind.example']);
    const res = await decide(v!.brief_id, { action: 'retry' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'parent_superseded' });
    expect(m.calls).toEqual([]);
  });

  it('an Autopilot refusal is saved as failed and shows its plain sentence in Ask me', async () => {
    const [v] = await db.query<{ id: string; creator_id: string }>(`select id, creator_id from licence_versions where client_id = $1 and asset_id = $2 and total_cents = 90000 and status = 'pending'`, [ids.clients['buying@northwind.example'], ids.assets['Morning Pour']]);
    const result = await sendInvoice(db, m.api, v!.id, { mode: 'autopilot' });
    expect(result).toMatchObject({ ok: false, code: 'parent_superseded' });
    const message = !result.ok ? result.error : '';
    expect(message).toContain('the licence this quote extends is no longer current');
    expect(await db.query(`select send_state, send_error from licence_versions where id = $1`, [v!.id])).toEqual([{ send_state: 'failed', send_error: message }]);
    const items = await listAsk(db, v!.creator_id);
    expect(items.find((item) => item.versionId === v!.id)?.sendError).toBe(message);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ items, alerts: [] }))));
    render(createElement(AskPage));
    expect(await screen.findByText(`Last send failed: ${message}`)).toBeTruthy();
    expect(screen.queryByText('parent_superseded')).toBeNull();
    expect(m.calls).toEqual([]);
  });

  it('a first licence without a parent still sends', async () => {
    const briefId = await submit('social');
    const [v] = await db.query<{ parent_id: string | null }>(`select parent_id from licence_versions where brief_id = $1`, [briefId]);
    expect(v!.parent_id).toBeNull();
    if (!paypalWrites().length) expect((await decide(briefId, { action: 'approve', typedTotal: '300.00' })).status).toBe(200);
    expect(paypalWrites()).toHaveLength(2);
  });

  it.each(['sent', 'created'])('an existing %s invoice still reconciles if its parent expires', async (state) => {
    const briefId = await submit('billboard');
    expect((await decide(briefId, { action: 'approve', typedTotal: '900.00' })).status).toBe(200);
    const [v] = await db.query<{ id: string; parent_id: string; paypal_invoice_id: string }>(`select v.id, v.parent_id, i.paypal_invoice_id from licence_versions v join invoices i on i.version_id = v.id where v.brief_id = $1 and i.state = 'sent'`, [briefId]);
    await db.query(`update licence_versions set status = 'expired' where id = $1`, [v!.parent_id]);
    await db.query(`update invoices set state = $2 where version_id = $1`, [v!.id, state]);
    if (state === 'created') await db.query(`update licence_versions set send_state = 'failed' where id = $1`, [v!.id]);
    m.reset();
    try {
      expect(await sendInvoice(db, m.api, v!.id, { mode: 'approval' })).toMatchObject({ ok: true, paypalInvoiceId: v!.paypal_invoice_id });
      expect(paypalWrites()).toEqual([]);
      expect(await db.query(`select state, paypal_invoice_id from invoices where version_id = $1`, [v!.id])).toEqual([{ state: 'sent', paypal_invoice_id: v!.paypal_invoice_id }]);
    } finally { await db.query(`update licence_versions set status = 'active' where id = $1`, [v!.parent_id]); }
  });

  it('a renewal of an expired current licence still sends after approval', async () => {
    const [parent] = await db.query<{ id: string; end_at: Date }>(`select id, end_at from licence_versions where client_id = $1 and status = 'active'`, [ids.clients['brand@pinecresthotels.example']]);
    expect(parent).toBeDefined();
    await db.query(`update licence_versions set renewal_opt_in = false where id = $1`, [parent!.id]);
    await runTick({ db, api: m.api, env: { DEMO_MODE: '1' }, real: () => new Date(parent!.end_at).getTime() - 6 * 86400000 });
    const [renewal] = await db.query<{ id: string; brief_id: string; total_cents: number }>(`select id, brief_id, total_cents from licence_versions where renewal_of = $1`, [parent!.id]);
    expect(renewal).toBeDefined();
    expect(await db.query(`select 1 from invoices where version_id = $1`, [renewal!.id])).toEqual([]);
    await db.query(`update licence_versions set status = 'expired' where id = $1`, [parent!.id]);
    m.reset();
    expect((await decide(renewal!.brief_id, { action: 'approve', typedTotal: (renewal!.total_cents / 100).toFixed(2) })).status).toBe(200);
    expect(paypalWrites()).toHaveLength(2);
  });
});
