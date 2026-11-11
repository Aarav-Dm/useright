// B11 items 2 and 5: who sent the invoice, and the renewal deal's own story. Read model on PGlite with PayPal mocked.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { LoginScreen } from '@/app/login/login-screen';
import ReceiptPage from '@/app/r/[id]/page';
import { DealRoomView } from '@/components/creator/deal-room';
import { SAMPLES } from '@/components/creator/request-samples';
import { openPglite, type Db } from '../db/client';
import { initialize } from '../db/init';
import { createAdapter, fixtureProvider } from '../lib/ai/extract';
import { getBriefView, type AiFor } from '../lib/briefs';
import { advanceToNextRenewal } from '../lib/clock';
import { grantIfPaid } from '../lib/grant';
import { intake, type IntakeDeps } from '../lib/intake';
import { listLedger } from '../lib/ledger';
import { latestReceiptId, receiptView } from '../lib/receipts';
import { runTick } from '../lib/renewal';
import { approve, runAutopilot } from '../lib/send';
import { setRouteDepsForTests } from '../lib/server';
import * as T from './fixtures/texts';
import { mockInvoiceApi } from './helpers/mock-paypal';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => {}, refresh: () => {} }), usePathname: () => '/deals', useSearchParams: () => new URLSearchParams() }));

const DEMO = { DEMO_MODE: '1' };
const actions = { onEdit: () => {}, onConfirm: () => {}, onDecide: () => {}, onCopy: () => {}, onError: () => {} };
const aiFor: AiFor = (fixture) => createAdapter(fixtureProvider(fixture ?? 'paste'));
let db: Db;
let dir: string;
let m: ReturnType<typeof mockInvoiceApi>;
let deps: IntakeDeps;
let creatorId: string;
let northwind: string;
let morningPour: string;
const savedDemo = process.env.DEMO_MODE;

beforeAll(async () => {
  db = await openPglite();
  dir = await mkdtemp(join(tmpdir(), 'ur-b11v-'));
  await initialize(db, dir);
  m = mockInvoiceApi();
  deps = { db, aiFor, uploadsDir: dir, env: { AI_PROVIDER: 'fixture', NODE_ENV: 'test' } as unknown as NodeJS.ProcessEnv };
  creatorId = (await db.query<{ id: string }>(`select id from creators limit 1`))[0]!.id;
  northwind = (await db.query<{ id: string }>(`select id from clients where email = 'buying@northwind.example'`))[0]!.id;
  morningPour = (await db.query<{ id: string }>(`select id from assets where title = 'Morning Pour'`))[0]!.id;
});
afterAll(async () => {
  if (savedDemo === undefined) delete process.env.DEMO_MODE; else process.env.DEMO_MODE = savedDemo;
  await db?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

const room = async (id: string) => {
  const view = (await getBriefView(db, id))!;
  return { view, html: renderToStaticMarkup(<DealRoomView view={view} options={null} busy={false} actions={actions} />) };
};
async function add(text: string, fixture: string) {
  const r = await intake(deps, { source: 'paste', clientId: northwind, assetId: morningPour, text, fixture }, { creator: true, sessionSlug: 'imani' });
  if (!r.ok) throw new Error(r.error);
  return r.briefId;
}

describe('items 4 and 7: the first screen', () => {
  it('in demo mode says what UseRight does, with the quote and the public page; otherwise neither', () => {
    const demo = renderToStaticMarkup(<LoginScreen demo />);
    expect(demo).toContain('specifically prohibited website use and any printed marketing materials');
    expect(demo).toContain('UseRight invoices the gap');
    expect(demo).toContain('href="/c/imani"');
    const live = renderToStaticMarkup(<LoginScreen demo={false} />);
    expect(live).not.toContain('prohibited website use');
    expect(live).not.toContain('/c/imani');
  });
});

describe('item 2: who sent it', () => {
  it('autopilot send: the deal says the agent sent it and ticks Autopilot', async () => {
    const id = await add(SAMPLES.find((s) => s.key === 'print')!.text!, 'demo-dm');
    expect((await getBriefView(db, id))!.sentBy).toBeNull();
    expect(await runAutopilot(db, m.api, id)).toMatchObject({ action: 'sent' });
    const { view, html } = await room(id);
    expect(view.sentBy).toBe('agent');
    expect(html).toContain('The agent sent this with no click from you.');
    expect(html).toContain('Autopilot');
    expect(html).not.toContain('You approve (or autopilot)');
  });

  it('typed approval: says you, never the agent', async () => {
    const id = await add(T.BILLBOARD, 'billboard');
    await runAutopilot(db, m.api, id);
    expect((await getBriefView(db, id))!.sentBy).toBeNull();
    expect(await approve(db, m.api, creatorId, { briefId: id }, '900.00')).toMatchObject({ ok: true });
    const { view, html } = await room(id);
    expect(view.sentBy).toBe('you');
    expect(html).toContain('You approved');
    expect(html).not.toContain('The agent sent this with no click from you.');
  });

  it('a normal check before payment reads as not paid yet, not as a failure (click review 7)', async () => {
    const id = await add(SAMPLES.find((s) => s.key === 'print')!.text!, 'demo-dm');
    const sent = await runAutopilot(db, m.api, id);
    if (sent.action !== 'sent') throw new Error(sent.action);
    await grantIfPaid({ db, pp: m.pp, uploadsDir: dir }, sent.versionId, 'test');
    const rows = (await listLedger(db, creatorId)).filter((r) => r.kind === 'grant' && r.versionId === sent.versionId);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]!.label).toBe('Checked, not paid yet');
    expect(rows[0]!.result).toBe('fail'); // display text only
  });

  it('a seeded invoice claims nobody', async () => {
    const [d] = await db.query<{ brief_id: string }>(`select v.brief_id from invoices i join licence_versions v on v.id = i.version_id where i.paypal_invoice_id like 'INV2-DEMO-%' and i.state = 'sent' limit 1`);
    expect((await getBriefView(db, d!.brief_id))!.sentBy).toBeNull();
  });
});

describe('the receipt reads in one time zone', () => {
  it('Term and Issued both use the creator\'s zone, whatever the server\'s is', async () => {
    const id = await add(SAMPLES.find((s) => s.key === 'print')!.text!, 'demo-dm');
    const sent = await runAutopilot(db, m.api, id);
    if (sent.action !== 'sent') throw new Error(sent.action);
    const [inv] = await db.query<{ paypal_invoice_id: string }>(`select paypal_invoice_id from invoices where version_id = $1`, [sent.versionId]);
    m.pay(inv!.paypal_invoice_id);
    // Midnight in Kolkata is the previous evening in UTC and New York, so a server-zone date would read Oct 28.
    await db.query(`update creator_settings set timezone = 'Asia/Kolkata' where creator_id = $1`, [creatorId]);
    setRouteDepsForTests({ db, aiFor, uploadsDir: dir });
    try {
      expect((await grantIfPaid({ db, pp: m.pp, uploadsDir: dir }, sent.versionId, 'test')).granted).toBe(true);
      const rid = (await latestReceiptId(db, sent.versionId))!;
      const html = renderToStaticMarkup(await ReceiptPage({ params: Promise.resolve({ id: rid }) }));
      expect(html).toContain('Oct 29, 2026 to ');
      const issued = (await receiptView(db, rid))!.body.issuedAt;
      expect(html).toContain(`<dd>${new Date(issued).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'Asia/Kolkata' })}</dd>`);
    } finally {
      setRouteDepsForTests(null);
      await db.query(`update creator_settings set timezone = 'America/New_York' where creator_id = $1`, [creatorId]);
    }
  });
});

describe('item 5: the renewal deal', () => {
  it('shows the licence it renews, nothing new, and no client reading', async () => {
    process.env.DEMO_MODE = '1';
    expect(await advanceToNextRenewal(db, creatorId, DEMO)).toMatchObject({ ok: true, moved: true });
    await runTick({ db, api: m.api, env: DEMO });
    const [r] = await db.query<{ id: string }>(`select id from briefs where source = 'renewal' and client_id = (select id from clients where name = 'Pinecrest Hotels') order by seq desc limit 1`);
    const { view, html } = await room(r!.id);
    expect(view.status).toBe('invoiced');
    expect(view.sentBy).toBe('agent');
    expect(view.renewalParent).toMatchObject({ versionNo: 1, scope: { channels: ['social'], territory: 'US', durationMonths: 6 } });
    expect(view.gapPreview!.totalCents).toBe(30000); // the price path is untouched
    expect(html).not.toContain('No licence yet');
    expect(html).not.toContain('>new<');
    expect(html).not.toContain('Not recorded');
    expect(html).not.toContain('Not run yet');
    expect(html.split('Not needed: renewal of the same scope').length - 1).toBe(2);
    expect(html).toContain('Opened by the agent');
    // Click review 8 and 10: one date style on the screen, and no real-time date beside a moved demo clock.
    expect(view.brief.raw).toMatch(/which ends [A-Z][a-z]{2} \d{1,2}, \d{4}\./);
    expect(html).not.toMatch(/Sent [A-Z][a-z]{2} \d/);
    expect(html).not.toContain('received ');
  });
});
