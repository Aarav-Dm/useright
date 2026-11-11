// Batch 5: policy R1-R5, autopilot, Ask me approval, invoice lifecycle. PayPal is mocked (tests/helpers/mock-paypal).
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { openPglite, type Db } from '../db/client';
import { migrate } from '../db/migrate';
import { seed, type SeedResult } from '../db/seed';
import { createAdapter, fixtureProvider } from '../lib/ai/extract';
import { confirmTranscript, editBrief, getBriefView, type AiFor } from '../lib/briefs';
import { listDeals } from '../lib/deals';
import { intake, type IntakeDeps } from '../lib/intake';
import { listAsk, listLedger } from '../lib/ledger';
import { evaluate } from '../lib/policy';
import { describeReason } from '../lib/reasons';
import { approve, cancelAndRequote, reject, retry, runAutopilot, sendInvoice } from '../lib/send';
import { invoiceNumberFor, pendingVersionFor } from '../lib/versions';
import * as T from './fixtures/texts';
import { mockInvoiceApi } from './helpers/mock-paypal';

let db: Db;
let s: SeedResult;
let deps: IntakeDeps;
let uploadsDir: string;
let morningPour: string;
let harborLight: string;
let pp: ReturnType<typeof mockInvoiceApi>;
const aiFor: AiFor = (fixture) => createAdapter(fixtureProvider(fixture ?? 'paste'));
const creator = { creator: true, sessionSlug: 'imani' };

async function paste(fixture: string, text: string, assetId: string) {
  const r = await intake(deps, { source: 'paste', clientId: s.clientId, assetId, text, fixture }, creator);
  if (!r.ok) throw new Error(r.error);
  return r.briefId;
}
async function demoDm() {
  const png = await readFile(join(import.meta.dirname, 'fixtures', 'demo-dm.png'));
  const r = await intake(deps, { source: 'screenshot', clientId: s.clientId, assetId: morningPour, fixture: 'demo-dm', image: { mime: 'image/png', base64: png.toString('base64') } }, creator);
  if (!r.ok) throw new Error(r.error);
  await confirmTranscript(db, aiFor, r.briefId, T.DEMO_DM);
  return r.briefId;
}
const versionOf = async (briefId: string) => (await getBriefView(db, briefId))!.version!;
const sendsFor = (versionId: string) => db.query<{ status: string }>(`select status from autopilot_sends where version_id = $1 order by seq`, [versionId]);
const invoicesFor = (versionId: string) => db.query<{ state: string; paypal_invoice_id: string | null; invoice_number: string }>(`select state, paypal_invoice_id, invoice_number from invoices where version_id = $1 order by seq`, [versionId]);

beforeAll(async () => {
  db = await openPglite();
  await migrate(db);
  s = await seed(db);
  [morningPour, harborLight] = s.assetIds as [string, string];
  uploadsDir = await mkdtemp(join(tmpdir(), 'ur-b5-'));
  deps = { db, aiFor, uploadsDir, env: { AI_PROVIDER: 'fixture', NODE_ENV: 'test' } as unknown as NodeJS.ProcessEnv };
});
afterAll(async () => {
  await db?.close();
  if (uploadsDir) await rm(uploadsDir, { recursive: true, force: true });
});
beforeEach(async () => {
  pp = mockInvoiceApi();
  // Fresh send capacity for each test; caps are reset to the seed values.
  await db.query(`update autopilot_sends set status = 'released' where status in ('reserved', 'sent')`);
  await db.query(`update creator_settings set per_deal_cap_cents = 50000, daily_max_sends = 10, rolling30_cap_cents = 150000 where creator_id = $1`, [s.creatorId]);
});

describe('autopilot (fix 11): the $420 demo deal is invoiced with no creator click', () => {
  it('all five rules pass -> one invoice sent, version rail invoice, reservation sent, deal invoiced', async () => {
    const id = await demoDm();
    const r = await runAutopilot(db, pp.api, id);
    expect(r.action).toBe('sent');
    const v = await versionOf(id);
    expect(v).toMatchObject({ versionNo: 2, totalCents: 42000, status: 'pending', sendState: 'sent' });
    expect(v.policy!.results.filter((x) => x.rule.startsWith('R')).map((x) => [x.rule, x.pass])).toEqual([['R1', true], ['R2', true], ['R3', true], ['R4', true], ['R5', true]]);
    expect(v.invoice).toMatchObject({ state: 'sent', invoiceNumber: invoiceNumberFor(v.id) });
    expect(v.invoice!.invoiceNumber).toMatch(/^UR-[0-9a-f]{22}$/);
    expect(v.invoice!.payerUrl).toMatch(/^https:\/\/www\.sandbox\.paypal\.com/);
    expect(await sendsFor(v.id)).toEqual([{ status: 'sent' }]);
    const [lv] = await db.query(`select rail, parent_id from licence_versions where id = $1`, [v.id]);
    expect(lv).toEqual({ rail: 'invoice', parent_id: s.v1Id });
    expect((await getBriefView(db, id))!.status).toBe('invoiced');
    const draft = [...pp.invoices.values()][0]!.draft;
    expect(draft).toMatchObject({ amountCents: 42000, recipientEmail: 'buying@northwind.example' });
    expect(draft.itemName).toContain('Morning Pour');
  });

  it('duplicate send requests -> one invoice', async () => {
    const id = await demoDm();
    await runAutopilot(db, pp.api, id);
    const again = await runAutopilot(db, pp.api, id);
    expect(again).toMatchObject({ action: 'skipped', reason: 'already sent' });
    const v = await versionOf(id);
    const direct = await sendInvoice(db, pp.api, v.id, { mode: 'autopilot' });
    expect(direct).toMatchObject({ ok: true, already: true, paypalInvoiceId: v.invoice!.paypalInvoiceId });
    const pv = await pendingVersionFor(db, id);
    expect(pv.ok && pv.version.id).toBe(v.id); // fix 1: same pending version, same invoice_number
    expect(pp.count('create')).toBe(1);
    expect(await invoicesFor(v.id)).toHaveLength(1);
  });
});

describe('spec §8: $900 billboard deal', () => {
  it('no PayPal call; two reasons (over cap, not sellable); lands in Ask me with numbers', async () => {
    const id = await paste('billboard', T.BILLBOARD, morningPour);
    const r = await runAutopilot(db, pp.api, id);
    expect(r.action).toBe('needs_approval');
    expect(pp.calls).toHaveLength(0);
    const view = (await getBriefView(db, id))!;
    expect(view.status).toBe('needs_approval');
    expect(view.reasons).toEqual(['over_deal_cap:90000:50000', 'needs_approval:billboard']);
    expect(view.reasons.map(describeReason)).toEqual(['$900.00 exceeds your $500.00 per-deal cap.', 'Billboard needs your approval.']);
    const ask = (await listAsk(db, s.creatorId)).find((a) => a.briefId === id)!;
    expect(ask).toMatchObject({ totalCents: 90000, hardBlock: false });
    expect(ask.failing.map((f) => f.message)).toEqual(['$900.00 exceeds your $500.00 per-deal cap.', 'Billboard needs your approval.']);
    const rules = await db.query<{ rule: string; pass: boolean }>(`select rule, (detail->>'pass')::boolean as pass from events where kind = 'rule' and detail->>'briefId' = $1 order by created_at, rule`, [id]);
    expect(rules.map((x) => `${x.rule}:${x.pass}`).sort()).toEqual(['R1:true', 'R2:false', 'R3:true', 'R4:false', 'R5:true']);
  });

  it('wrong typed total is rejected; "900" or "900.00" approves and sends; approval does not count toward caps', async () => {
    const id = await paste('billboard', T.BILLBOARD, morningPour);
    await runAutopilot(db, pp.api, id);
    const v = await versionOf(id);
    expect(await approve(db, pp.api, s.creatorId, { versionId: v.id }, '800')).toMatchObject({ ok: false, status: 400, error: 'Type 900.00 to approve.' });
    expect(await approve(db, pp.api, s.creatorId, { versionId: v.id }, '$900')).toMatchObject({ ok: false, status: 400, code: 'bad_amount' });
    expect(await approve(db, pp.api, s.creatorId, { versionId: v.id }, '900,00')).toMatchObject({ ok: false, status: 400, code: 'bad_amount' });
    expect(pp.calls).toHaveLength(0);
    const ok = await approve(db, pp.api, s.creatorId, { versionId: v.id }, '900');
    expect(ok).toMatchObject({ ok: true, send: { already: false } });
    expect((await getBriefView(db, id))!.status).toBe('invoiced');
    const [a] = await db.query(`select version_hash, amount_cents, recipient from approvals where version_id = $1`, [v.id]);
    expect(a).toEqual({ version_hash: v.contentHash, amount_cents: 90000, recipient: 'buying@northwind.example' });
    expect(await sendsFor(v.id)).toEqual([]); // fix 4
    // A repeat approval is idempotent: it returns the invoice already sent, never a second one.
    expect(await approve(db, pp.api, s.creatorId, { versionId: v.id }, '900.00')).toMatchObject({ ok: true, send: { already: true } });
    expect(pp.count('create')).toBe(1);
  });

  it('two approves of one quote are idempotent -> one invoice (PGlite runs them serially; the real race is in concurrency.test.ts)', async () => {
    const id = await paste('billboard', T.BILLBOARD, morningPour);
    await runAutopilot(db, pp.api, id);
    const v = await versionOf(id);
    const [a, b] = await Promise.all([
      approve(db, pp.api, s.creatorId, { versionId: v.id }, '900.00'),
      approve(db, pp.api, s.creatorId, { versionId: v.id }, '900.00'),
    ]);
    expect([a, b].filter((x) => x.ok)).toHaveLength(1);
    expect(pp.count('create')).toBe(1);
    expect((await invoicesFor(v.id)).filter((i) => i.state !== 'cancelled')).toHaveLength(1);
  });

  it('approval with a changed version hash is refused right before sending', async () => {
    const id = await paste('billboard', T.BILLBOARD, morningPour);
    await runAutopilot(db, pp.api, id);
    const v = await versionOf(id);
    await db.query(`insert into approvals (creator_id, version_id, version_hash, amount_cents, recipient) values ($1, $2, $3, 90000, 'buying@northwind.example')`, [s.creatorId, v.id, v.contentHash]);
    await db.query(`update licence_versions set total_cents = 80000 where id = $1`, [v.id]); // the quote changed underneath
    expect(await sendInvoice(db, pp.api, v.id, { mode: 'approval' })).toMatchObject({ ok: false, status: 409, code: 'approval_stale' });
    await db.query(`update licence_versions set total_cents = 90000 where id = $1`, [v.id]);
    await db.query(`update clients set email = 'other@northwind.example' where id = $1`, [s.clientId]); // recipient changed
    expect(await sendInvoice(db, pp.api, v.id, { mode: 'approval' })).toMatchObject({ ok: false, status: 409, code: 'approval_stale' });
    await db.query(`update clients set email = 'buying@northwind.example' where id = $1`, [s.clientId]);
    expect(pp.calls).toHaveLength(0);
  });

  it('reject -> version draft + rejected event; deal shows rejected (fix 7)', async () => {
    const id = await paste('billboard', T.BILLBOARD, morningPour);
    await runAutopilot(db, pp.api, id);
    const v = await versionOf(id);
    expect(await reject(db, s.creatorId, id)).toEqual({ ok: true });
    const [lv] = await db.query<{ status: string; rejected_at: Date | null }>(`select status, rejected_at from licence_versions where id = $1`, [v.id]);
    expect(lv!.status).toBe('draft');
    expect(lv!.rejected_at).not.toBeNull();
    expect((await getBriefView(db, id))!).toMatchObject({ status: 'rejected', reasons: ['rejected'] });
    expect((await listAsk(db, s.creatorId)).some((a) => a.briefId === id)).toBe(false);
    expect((await db.query(`select 1 from events where kind = 'rejected' and detail->>'briefId' = $1`, [id]))).toHaveLength(1);
    expect(await approve(db, pp.api, s.creatorId, { briefId: id }, '900')).toMatchObject({ ok: false, status: 409, error: 'this quote was rejected' });
  });
});

describe('R3 counts reservations (fix 4)', () => {
  it('a live reservation fills the daily max; an expired one is released and frees it', async () => {
    await db.query(`update creator_settings set daily_max_sends = 1 where creator_id = $1`, [s.creatorId]);
    const [held] = await db.query<{ id: string }>(
      `insert into autopilot_sends (creator_id, client_id, version_id, status, amount_cents, expires_at) values ($1, $2, $3, 'reserved', 100, now() + interval '10 minutes') returning id`,
      [s.creatorId, s.clientId, s.v1Id]);
    const id = await demoDm();
    expect(await runAutopilot(db, pp.api, id)).toMatchObject({ action: 'needs_approval' });
    const v = await versionOf(id);
    expect(v.policy!.results.find((r) => r.rule === 'R3')).toMatchObject({ pass: false, code: 'daily_max_reached:1' });
    expect(pp.calls).toHaveLength(0);

    await db.query(`update autopilot_sends set expires_at = now() - interval '1 minute' where id = $1`, [held!.id]);
    const ev = await evaluate(db, v.id);
    expect(ev.ok && ev.policy.pass).toBe(true);
    const [h] = await db.query(`select status from autopilot_sends where id = $1`, [held!.id]);
    expect(h).toEqual({ status: 'released' });
  });

  it('the rolling 30-day cap is per client and includes this deal', async () => {
    await db.query(`update creator_settings set rolling30_cap_cents = 50000 where creator_id = $1`, [s.creatorId]);
    await db.query(`insert into autopilot_sends (creator_id, client_id, version_id, status, amount_cents) values ($1, $2, $3, 'sent', 10000)`, [s.creatorId, s.clientId, s.v1Id]);
    const id = await demoDm();
    await runAutopilot(db, pp.api, id);
    expect((await getBriefView(db, id))!.reasons).toEqual(['rolling_cap_reached:52000:50000']);
    expect(describeReason('rolling_cap_reached:52000:50000')).toBe('This would bring the client to $520.00 in 30 days, over your $500.00 cap.');
  });
});

describe('PayPal failure paths (§4, fix 3)', () => {
  it('create fails -> invoice row cancelled, reservation released, deal failed, Ask me shows the error', async () => {
    const id = await demoDm();
    pp.failNext('create', 500);
    expect(await runAutopilot(db, pp.api, id)).toMatchObject({ action: 'failed' });
    const v = await versionOf(id);
    expect(await invoicesFor(v.id)).toEqual([expect.objectContaining({ state: 'cancelled' })]);
    expect(await sendsFor(v.id)).toEqual([{ status: 'released' }]);
    expect(v).toMatchObject({ sendState: 'failed', sendError: 'PayPal refused the invoice (INTERNAL_SERVER_ERROR).' });
    expect((await getBriefView(db, id))!.status).toBe('failed');
    expect((await listAsk(db, s.creatorId)).find((a) => a.briefId === id)?.sendError).toMatch(/PayPal refused/);
    expect(JSON.stringify(await db.query(`select detail from events where kind = 'invoice.failed'`))).not.toContain('@');

    // Fix 12: Retry re-runs evaluate() and sends; a new invoice_number because PayPal saw the old one.
    const again = await retry(db, pp.api, s.creatorId, id);
    expect(again).toMatchObject({ ok: true });
    const rows = await invoicesFor(v.id);
    expect(rows.map((r) => r.state)).toEqual(['cancelled', 'sent']);
    expect(rows[1]!.invoice_number).toBe(invoiceNumberFor(v.id, 1));
    expect(rows[1]!.invoice_number).toHaveLength(25);
    expect((await getBriefView(db, id))!.status).toBe('invoiced');
  });

  it('send fails after create -> PayPal draft deleted, row cancelled', async () => {
    const id = await demoDm();
    pp.failNext('send', 422, 'INVALID_REQUEST');
    await runAutopilot(db, pp.api, id);
    const v = await versionOf(id);
    expect(pp.count('remove')).toBe(1);
    expect(pp.invoices.size).toBe(0);
    expect(await invoicesFor(v.id)).toEqual([expect.objectContaining({ state: 'cancelled' })]);
    expect(await sendsFor(v.id)).toEqual([{ status: 'released' }]);
  });

  it('create times out but PayPal made it -> found by invoice_number search, reused, sent once', async () => {
    const id = await demoDm();
    pp.failNext('create', 'created-then-timeout');
    expect(await runAutopilot(db, pp.api, id)).toMatchObject({ action: 'sent' });
    expect(pp.count('create')).toBe(1);
    expect(pp.count('findByNumber')).toBe(1);
    expect(pp.invoices.size).toBe(1);
  });

  it('create times out and nothing exists -> failed, no blind retry', async () => {
    const id = await demoDm();
    pp.failNext('create', 'timeout');
    expect(await runAutopilot(db, pp.api, id)).toMatchObject({ action: 'failed' });
    expect(pp.count('create')).toBe(1);
    expect((await versionOf(id)).sendError).toMatch(/did not answer in time/);
  });

  it('422 DUPLICATE_INVOICE_NUMBER -> fetch and reuse the existing invoice', async () => {
    const id = await demoDm();
    const pv = await pendingVersionFor(db, id);
    if (!pv.ok) throw new Error(pv.error);
    // An earlier run created the PayPal invoice but crashed before saving its id.
    await pp.api.create({ invoiceNumber: invoiceNumberFor(pv.version.id), recipientEmail: 'x@y.example', itemName: 'x', itemDescription: 'x', amountCents: 42000, note: 'x' });
    pp.reset();
    expect(await runAutopilot(db, pp.api, id)).toMatchObject({ action: 'sent' });
    expect(pp.count('findByNumber')).toBe(1);
    expect(pp.invoices.size).toBe(1);
  });
});

describe('edits after evaluation (fixes 14, 16, 18)', () => {
  it('a creator edit supersedes a pending quote and releases its reservation; Ask me never shows the stale scope', async () => {
    const id = await paste('billboard-and-web', T.BILLBOARD_AND_WEB, morningPour);
    expect(await runAutopilot(db, pp.api, id)).toMatchObject({ action: 'needs_approval' }); // billboard not sellable
    const stale = await versionOf(id);
    const r = await editBrief(db, s.creatorId, id, { uses: [{ optionId: 'web', quote: 'Please add our website as well.' }] });
    expect(r.ok).toBe(true);
    const [old] = await db.query(`select status from licence_versions where id = $1`, [stale.id]);
    expect(old).toEqual({ status: 'superseded' });
    expect((await listAsk(db, s.creatorId)).some((a) => a.versionId === stale.id)).toBe(false);
    expect(await runAutopilot(db, pp.api, id)).toMatchObject({ action: 'sent' });
    expect((await versionOf(id)).totalCents).toBe(10000);
  });

  it('once invoiced the deal is locked; cancel and re-quote frees R3 capacity and allows a new quote', async () => {
    const id = await demoDm();
    await runAutopilot(db, pp.api, id);
    const v = await versionOf(id);
    expect(await editBrief(db, s.creatorId, id, { assetId: harborLight })).toMatchObject({ ok: false, status: 409 });
    expect(await reject(db, s.creatorId, id)).toMatchObject({ ok: false, status: 409 });

    expect(await cancelAndRequote(db, pp.api, s.creatorId, id)).toEqual({ ok: true });
    expect(pp.count('cancel')).toBe(1);
    expect([...pp.invoices.values()][0]!.status).toBe('CANCELLED');
    expect(await sendsFor(v.id)).toEqual([{ status: 'released' }]); // fix 18
    const after = (await getBriefView(db, id))!;
    expect(after).toMatchObject({ status: 'cancelled', version: { id: v.id, status: 'superseded', invoice: { state: 'cancelled' } } });
    expect(await runAutopilot(db, pp.api, id)).toMatchObject({ action: 'skipped' }); // the same extraction is not re-sent

    const edit = await editBrief(db, s.creatorId, id, { uses: [{ optionId: 'print', quote: T.DEMO_DM_PRINT_SENTENCE }] });
    expect(edit.ok).toBe(true);
    expect(await runAutopilot(db, pp.api, id)).toMatchObject({ action: 'sent' });
    expect((await versionOf(id)).id).not.toBe(v.id);
  });
});

describe('hard blocks (fixes 15, 19)', () => {
  it('a total under $1.00 is refused before PayPal, even with approval', async () => {
    await db.query(`update rate_card_options set cents = 50 where creator_id = $1 and option_id = 'web'`, [s.creatorId]);
    await db.query(`update rate_card_options set cents = 0 where creator_id = $1 and option_id = '6mo'`, [s.creatorId]);
    try {
      const id = await paste('suggests-price', T.SUGGESTS_PRICE, harborLight);
      expect(await runAutopilot(db, pp.api, id)).toMatchObject({ action: 'needs_approval' });
      expect((await getBriefView(db, id))!.reasons[0]).toBe('amount_too_small:50');
      expect(await approve(db, pp.api, s.creatorId, { briefId: id }, '0.50')).toMatchObject({ ok: false, status: 409, code: 'amount_too_small:50' });
      expect(pp.calls).toHaveLength(0);
      expect((await listAsk(db, s.creatorId)).find((a) => a.briefId === id)).toMatchObject({ hardBlock: true });
    } finally {
      await db.query(`update rate_card_options set cents = 10000 where creator_id = $1 and option_id = 'web'`, [s.creatorId]);
      await db.query(`update rate_card_options set cents = 15000 where creator_id = $1 and option_id = '6mo'`, [s.creatorId]);
    }
  });

  it('a client without a valid email -> missing_client_email, no PayPal call', async () => {
    const id = await paste('suggests-price', T.SUGGESTS_PRICE, harborLight);
    await db.query(`update clients set email = 'not-an-email' where id = $1`, [s.clientId]);
    try {
      await runAutopilot(db, pp.api, id);
      expect((await getBriefView(db, id))!.reasons).toContain('missing_client_email');
      expect(await approve(db, pp.api, s.creatorId, { briefId: id }, '250')).toMatchObject({ ok: false, code: 'missing_client_email' });
      expect(pp.calls).toHaveLength(0);
    } finally {
      await db.query(`update clients set email = 'buying@northwind.example' where id = $1`, [s.clientId]);
    }
  });
});

describe('deals list + ledger (fixes 8, 9)', () => {
  it('deals list shows invoiced / needs_approval / rejected with the quoted total and PayPal id', async () => {
    const sent = await demoDm();
    await runAutopilot(db, pp.api, sent);
    const asked = await paste('billboard', T.BILLBOARD, morningPour);
    await runAutopilot(db, pp.api, asked);
    const rejected = await paste('billboard', T.BILLBOARD, morningPour);
    await runAutopilot(db, pp.api, rejected);
    await reject(db, s.creatorId, rejected);
    const deals = await listDeals(db, s.creatorId);
    const by = Object.fromEntries(deals.map((d) => [d.briefId, d]));
    expect(by[sent]).toMatchObject({ status: 'invoiced', gapTotalCents: 42000, paypalInvoiceId: expect.stringMatching(/^INV2-/) });
    expect(by[asked]).toMatchObject({ status: 'needs_approval', gapTotalCents: 90000, paypalInvoiceId: null });
    expect(by[rejected]).toMatchObject({ status: 'rejected' });
  });

  it('GET /api/ledger rows carry rule, result, PayPal invoice id, status, expiry and renewal date', async () => {
    const id = await demoDm();
    await runAutopilot(db, pp.api, id);
    const v = await versionOf(id);
    const rows = (await listLedger(db, s.creatorId)).filter((r) => r.briefId === id);
    const keys = ['eventId', 'kind', 'createdAt', 'briefId', 'deal', 'versionId', 'versionNo', 'scope', 'rule', 'result', 'message', 'paypalInvoiceId', 'invoiceNumber', 'paypalTxnId', 'amountCents', 'label', 'status', 'expiry', 'renewalDate', 'demo'];
    for (const r of rows) expect(Object.keys(r).sort()).toEqual([...keys].sort());
    const r2 = rows.find((r) => r.rule === 'R2')!;
    expect(r2).toMatchObject({ kind: 'rule', result: 'pass', deal: 'Northwind Coffee · Morning Pour', versionNo: 2, scope: 'Social, Print, US, 6 mo', paypalInvoiceId: v.invoice!.paypalInvoiceId, status: 'sent' });
    expect(r2.message).toBe('$420.00 is within your $500.00 per-deal cap.');
    expect(rows.find((r) => r.kind === 'invoice.sent')).toMatchObject({ result: 'pass', paypalInvoiceId: v.invoice!.paypalInvoiceId, invoiceNumber: v.invoice!.invoiceNumber, expiry: null, renewalDate: null });
    expect(rows.filter((r) => r.kind === 'rule').map((r) => r.rule).sort()).toEqual(['R1', 'R2', 'R3', 'R4', 'R5']);
  });
});
