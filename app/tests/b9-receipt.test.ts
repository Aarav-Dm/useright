// B9 9.5: /r/:id is the check. It shows scope, file hash, PayPal transaction id and status, says "Proof of licence",
// never "legally binding", and a seeded receipt never reads as PayPal evidence.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderToString } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import ReceiptPage from '@/app/r/[id]/page';
import { openPglite, type Db } from '../db/client';
import { initialize } from '../db/init';
import { receiptView } from '../lib/receipts';
import { setRouteDepsForTests } from '../lib/server';

let db: Db;
let dir: string;
const page = async (id: string) => renderToString(await ReceiptPage({ params: Promise.resolve({ id }) }));
/** Commas and ampersands are escaped in the rendered page. */
const html = (s: string) => s.replace(/&/g, '&amp;');

beforeAll(async () => {
  db = await openPglite();
  dir = await mkdtemp(join(tmpdir(), 'ur-b9-receipt-'));
  await initialize(db, dir);
  setRouteDepsForTests({ db, uploadsDir: dir });
});
afterAll(async () => {
  setRouteDepsForTests(null);
  await db?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

const firstActive = async (txn: string) => (await db.query<{ public_id: string }>(
  `select r.public_id from receipts r join payments p on p.version_id = r.version_id join licence_versions v on v.id = r.version_id
    where r.status = 'active' and v.status = 'active' and p.paypal_txn_id like $1 limit 1`, [txn]))[0]!.public_id;

describe('B9 9.5: the public receipt', () => {
  it('shows scope, file hash, transaction id and status, in the agreed words', async () => {
    const id = await firstActive('SEED-DEMO-%');
    const view = (await receiptView(db, id))!;
    const out = await page(id);
    expect(out).toContain('Proof of licence');
    expect(out).toContain(html(view.body.scope.words));
    expect(out).toContain(view.body.asset.sha256);
    expect(out).toContain(view.body.paypalTransactionId);
    expect(out).toContain('Status');
    expect(out).not.toContain('Status now');
    expect(out).toContain('Collaborator share');
    expect(out).toContain('None recorded');
    expect(out).toContain('col-span-2">File SHA-256');
    expect(out).toContain('Active');
    expect(out).toContain('not legal advice');
    expect(out).not.toMatch(/legally binding|certificate/i);
  });

  it('a seeded receipt says it is a demo record', async () => {
    expect(await page(await firstActive('SEED-DEMO-%'))).toContain('Demo record, not a PayPal payment');
    expect(await page(await firstActive('SEED-V1'))).toContain('Demo record, not a PayPal payment');
  });

  it('a receipt with a real PayPal transaction id has no demo line', async () => {
    const id = await firstActive('SEED-DEMO-%');
    await db.query(`update receipts set body = jsonb_set(body, '{paypalTransactionId}', '"5TY00000000000000"') where public_id = $1`, [id]);
    const out = await page(id);
    expect(out).toContain('5TY00000000000000');
    expect(out).not.toContain('Demo record');
    expect(out).toContain('Proof of licence');
    expect(out).not.toContain('Demo · ');
  });

  it('renders PayPal payer only when it differs from the licensee email (review finding 5)', async () => {
    const id = await firstActive('SEED-V1');
    await db.query(`update receipts set body = jsonb_set(jsonb_set(body, '{licensee,email}', '"client@example.com"'), '{licensee,payerEmail}', '"client@example.com"') where public_id = $1`, [id]);
    let out = await page(id);
    expect(out).not.toContain('PayPal payer');

    await db.query(`update receipts set body = jsonb_set(body, '{licensee,payerEmail}', '"agency-payer@example.com"') where public_id = $1`, [id]);
    out = await page(id);
    expect(out).toContain('PayPal payer');
    expect(out).toContain('a***********@example.com');
  });

  it('only a grant receipt says Proof of licence (security review finding 6)', async () => {
    const id = await firstActive('SEED-V1'); // the test above gave the SEED-DEMO receipt a real transaction id
    expect(await page(id)).toContain('Demo · Proof of licence');
    for (const kind of ['revocation', 'expiry']) {
      await db.query(`update receipts set body = jsonb_set(body, '{kind}', $2::jsonb) where public_id = $1`, [id, JSON.stringify(kind)]);
      const out = await page(id);
      expect(out).toContain('Demo · Licence record');
      expect(out).not.toContain('Proof of licence');
    }
  });
});
