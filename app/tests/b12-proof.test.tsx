// B12 D1: PayPal evidence on the deal room and the receipt, read from stored rows only. PGlite, PayPal mocked.
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
import { grantIfPaid } from '../lib/grant';
import { paymentProof } from '../lib/proof';
import { latestReceiptId } from '../lib/receipts';
import { setRouteDepsForTests } from '../lib/server';
import ReceiptPage from '@/app/r/[id]/page';
import { intake, type IntakeDeps } from '../lib/intake';
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
  dir = await mkdtemp(join(tmpdir(), 'ur-b12p-'));
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

describe('D1: payment proof', () => {
  it('shows the invoice id, each re-fetch result and a verified webhook, on the deal room and the receipt', async () => {
    const id = await add('print');
    const sent = await runAutopilot(db, m.api, id);
    if (sent.action !== 'sent') throw new Error(sent.action);
    const [inv] = await db.query<{ paypal_invoice_id: string }>(`select paypal_invoice_id from invoices where version_id = $1`, [sent.versionId]);
    expect(await paymentProof(db, sent.versionId)).toMatchObject({ paypalInvoiceId: inv!.paypal_invoice_id, lastCheck: null, webhook: null });

    await grantIfPaid({ db, pp: m.pp, uploadsDir: dir }, sent.versionId, 'test');
    expect((await paymentProof(db, sent.versionId))!.lastCheck).toMatchObject({ pass: false });

    m.pay(inv!.paypal_invoice_id);
    await db.query(`insert into webhook_events (event_id, type, resource_id) values ('WH-B12-1', 'INVOICING.INVOICE.PAID', $1)`, [inv!.paypal_invoice_id]);
    expect((await grantIfPaid({ db, pp: m.pp, uploadsDir: dir }, sent.versionId, 'test')).granted).toBe(true);
    const proof = (await paymentProof(db, sent.versionId))!;
    expect(proof.lastCheck).toMatchObject({ pass: true });
    expect(proof.lastCheck!.message).toMatch(/^Verified with PayPal: paid in full, transaction /);
    expect(proof.webhook).toMatchObject({ type: 'INVOICING.INVOICE.PAID' });

    const room = html(await getBriefView(db, id));
    expect(room).toContain(inv!.paypal_invoice_id);
    expect(room).toContain('Last PayPal re-check');
    expect(room).toContain('Verified with PayPal: paid in full');
    expect(room).toContain('INVOICING.INVOICE.PAID, signature verified by PayPal');
    expect(room).not.toContain('Webhook last received');

    setRouteDepsForTests({ db, aiFor, uploadsDir: dir });
    try {
      const rid = (await latestReceiptId(db, sent.versionId))!;
      const receipt = renderToStaticMarkup(await ReceiptPage({ params: Promise.resolve({ id: rid }) }));
      expect(receipt).toContain('PayPal re-check');
      expect(receipt).toContain('Verified with PayPal: paid in full');
      expect(receipt).toContain('signature verified by PayPal');
    } finally {
      setRouteDepsForTests(null);
    }
  });

  it('a seeded invoice has no proof, so nothing reads as PayPal evidence', async () => {
    const [d] = await db.query<{ version_id: string }>(`select version_id from invoices where paypal_invoice_id like 'INV2-DEMO-%' limit 1`);
    expect(d).toBeTruthy();
    expect(await paymentProof(db, d!.version_id)).toBeNull();
  });
});
