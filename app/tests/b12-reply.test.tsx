// @vitest-environment jsdom
// Batch 12 Part B items 1 and 2: the reply draft, built by code from the stored deal (no model call), on PGlite with PayPal mocked.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DealRoomView } from '@/components/creator/deal-room';
import { SAMPLES } from '@/components/creator/request-samples';
import { openPglite, type Db } from '../db/client';
import { initialize } from '../db/init';
import { createAdapter, fixtureProvider } from '../lib/ai/extract';
import { getBriefView, type AiFor } from '../lib/briefs';
import { runChecks } from '../lib/checks';
import { optionLabel, usd } from '../lib/format';
import { intake, type IntakeDeps } from '../lib/intake';
import { replyDraft } from '../lib/reply-draft';
import { runAutopilot } from '../lib/send';
import { mockInvoiceApi } from './helpers/mock-paypal';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => {}, refresh: () => {} }), usePathname: () => '/deals', useSearchParams: () => new URLSearchParams() }));

const actions = { onEdit: () => {}, onConfirm: () => {}, onDecide: () => {}, onCopy: () => {}, onError: () => {} };
const aiFor: AiFor = (fixture) => createAdapter(fixtureProvider(fixture ?? 'paste'));
let db: Db;
let dir: string;
let m: ReturnType<typeof mockInvoiceApi>;
let deps: IntakeDeps;
let northwind: string;
let morningPour: string;

beforeAll(async () => {
  db = await openPglite();
  dir = await mkdtemp(join(tmpdir(), 'ur-b12r-'));
  await initialize(db, dir);
  m = mockInvoiceApi();
  deps = { db, aiFor, uploadsDir: dir, env: { AI_PROVIDER: 'fixture', NODE_ENV: 'test' } as unknown as NodeJS.ProcessEnv };
  northwind = (await db.query<{ id: string }>(`select id from clients where email = 'buying@northwind.example'`))[0]!.id;
  morningPour = (await db.query<{ id: string }>(`select id from assets where title = 'Morning Pour'`))[0]!.id;
});
afterAll(async () => {
  await db?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

async function add(key: string) {
  const s = SAMPLES.find((x) => x.key === key)!;
  // The sample's own photo: Morning Pour already has a seeded Northwind licence, whose price would show on the licence card.
  const [a] = await db.query<{ id: string }>(`select id from assets where title = $1`, [s.assetTitle ?? 'Morning Pour']);
  const r = await intake(deps, { source: 'paste', clientId: northwind, assetId: key === 'paid' ? a!.id : morningPour, text: s.text!, fixture: s.fixture }, { creator: true, sessionSlug: 'imani' });
  if (!r.ok) throw new Error(r.error);
  return r.briefId;
}
const html = (view: Awaited<ReturnType<typeof getBriefView>>) => renderToStaticMarkup(<DealRoomView view={view!} options={null} busy={false} actions={actions} />);

describe('item 1: reply draft', () => {
  it('never copies an old payment URL from client evidence, even before sending', async () => {
    const v = (await getBriefView(db, await add('print')))!;
    for (const url of ['https://app.test/pay/old-token', '/pay/old-token', 'paypal.me/old-client', 'www.paypal.com/invoice/old']) {
      const sentence = `Use the photo in print; our old payment link is ${url}.`;
      const view = { ...v, checks: { ...v.checks!, kept: [{ ...v.checks!.kept[0]!, sentence }] } };
      const draft = replyDraft(view)!;
      expect(draft).not.toContain(url);
      expect(draft).toContain('From my rate card:');
      expect(view.checks.kept[0]!.sentence).toBe(sentence);
    }
  });

  it('does not claim a real PayPal confirmation on the seeded paid deal', async () => {
    const [seeded] = await db.query<{ brief_id: string }>(`select v.brief_id from licence_versions v join invoices i on i.version_id = v.id where v.status = 'active' and i.paypal_invoice_id like 'INV2-DEMO-%' and v.brief_id is not null limit 1`);
    const view = (await getBriefView(db, seeded!.brief_id))!;
    expect(view.status).toBe('paid');
    expect(view.version!.invoice!.demo).toBe(true);
    expect(replyDraft(view)).toBeNull();
    expect(html(view)).not.toContain('PayPal confirmed your payment.');
  });

  it('quotes the client sentences it relied on, lists the rate-card lines and total, and adds the pay link once sent', async () => {
    const id = await add('print');
    const before = (await getBriefView(db, id))!;
    const draft = replyDraft(before)!;
    for (const k of before.checks!.kept) expect(draft).toContain(`"${k.sentence}"`);
    for (const l of before.gapPreview!.lines) expect(draft).toContain(`- ${optionLabel(l.optionId)}: ${usd(l.cents)}`);
    expect(draft).toContain(`Total: ${usd(before.gapPreview!.totalCents)}`);
    expect(draft).not.toContain('/pay/');

    const sent = await runAutopilot(db, m.api, id);
    if (sent.action !== 'sent') throw new Error(sent.action);
    const after = (await getBriefView(db, id))!;
    expect(after.status).toBe('invoiced');
    expect(replyDraft(after)).toContain(after.version!.invoice!.payUrl!);
    expect(replyDraft(after)).toContain(`Total: ${usd(after.version!.totalCents)}`);
    const room = html(after);
    expect(room).toContain('Reply draft');
    expect(room).toContain('Copy reply');
    expect(room).toContain('The app sends nothing');
    expect(room).toContain('break-words');
    expect(room).toContain('leading-relaxed');
    expect(room).not.toContain('(below the price and rules)');
    expect(room).not.toContain('(below)');
  });

  it('has no draft before a price exists, or for a renewal with no client message', async () => {
    const v = (await getBriefView(db, await add('print')))!;
    expect(replyDraft({ ...v, gapPreview: null })).toBeNull();
    expect(replyDraft({ ...v, brief: { ...v.brief, source: 'renewal' } })).toBeNull();
  });
});

describe('item 2: the paid-ads stop keeps the sale open with no figure', () => {
  it('does not repeat a client amount in the paid-ads draft or alter its evidence', async () => {
    const v = (await getBriefView(db, await add('paid')))!;
    const sentence = 'We want social media in the US for six months as paid ads, for $500.';
    const checks = runChecks({ transcript: { lines: [{ speaker: 'client', text: sentence }] }, extraction: {
      uses: ['social', 'US', '6mo'].map((optionId) => ({ optionId, quote: sentence })),
    }, current: null });
    expect(checks.status).toBe('needs_creator');
    expect(checks.kept).toHaveLength(3);
    const view = { ...v, reasons: checks.reasons, checks };
    const evidence = JSON.stringify(view.checks);
    const draft = replyDraft(view)!;
    expect(draft).toContain('is not on my rate card');
    expect(draft).not.toContain('$500');
    expect(draft).not.toMatch(/\$|\d+\.\d\d/);
    expect(JSON.stringify(view.checks)).toBe(evidence);
  });

  it('says paid promotion is not on the rate card and offers the uses it can sell, with no price and no Approve', async () => {
    const id = await add('paid');
    const v = (await getBriefView(db, id))!;
    expect(v.status).toBe('needs_creator');
    const draft = replyDraft(v)!;
    expect(draft).toContain('is not on my rate card');
    expect(draft).toContain(optionLabel(v.checks!.requested!.channels[0]!));
    expect(draft).not.toMatch(/\$|\d+\.\d\d|quote it\b.*\d/);
    const room = html(v);
    expect(room).toContain('Reply draft');
    expect(room).not.toContain('$300');
    expect(room).not.toContain('Approve and send');
    expect(await db.query(`select 1 from licence_versions where brief_id = $1`, [id])).toEqual([]);
  });
});
