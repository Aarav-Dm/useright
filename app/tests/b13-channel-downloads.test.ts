// B13: Deliverable files per channel (audit-product.md row 10).
// A paid billboard, out-of-home or TV licence must unlock the highest-resolution stored file (print file),
// never a smaller 800px web file. Web and social licences unlock the web file. Unpaid and revoked licences get nothing.
// Tested through the real Next.js route handlers on PGlite with mocked PayPal and stored assets.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { POST as dlIssuePOST } from '@/app/api/pay/[token]/download/route';
import { GET as downloadGET } from '@/app/download/[token]/route';
import { openPglite, type Db } from '../db/client';
import { initialize } from '../db/init';
import { creatorCard } from '../lib/briefs';
import { grantIfPaid } from '../lib/grant';
import { payView } from '../lib/pay';
import { ensureAssetFiles, originalPhotoPath } from '../lib/placeholder-files';
import { manifestPhotoFor } from '../lib/portfolio';
import { price, type Channel, type Scope } from '../lib/pricing';
import { setRouteDepsForTests } from '../lib/server';
import { readAsset } from '../lib/storage';
import { hashToken, newToken } from '../lib/tokens';
import { invoiceNumberFor } from '../lib/versions';
import { mockInvoiceApi } from './helpers/mock-paypal';

let db: Db;
let dir: string;
let m: ReturnType<typeof mockInvoiceApi>;
let ipSeq = 0;

const ctx = (token: string) => ({ params: Promise.resolve({ token }) });
const req = (path: string, method = 'GET') =>
  new Request(`http://app.test${path}`, {
    method,
    headers: {
      host: 'app.test',
      origin: 'http://app.test',
      'x-forwarded-for': `198.51.100.${++ipSeq % 250}`,
    },
  });

beforeAll(async () => {
  db = await openPglite();
  dir = await mkdtemp(join(tmpdir(), 'ur-b13-dl-'));
  await initialize(db, dir);
  await ensureAssetFiles(db, dir);
  m = mockInvoiceApi();
  setRouteDepsForTests({ db, uploadsDir: dir, invoices: m.api });
});

afterAll(async () => {
  setRouteDepsForTests(null);
  await db?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

beforeEach(() => m.reset());

async function createDeal(channelOrChannels: Channel | Channel[], opts: { paid?: boolean } = {}) {
  const channels = Array.isArray(channelOrChannels) ? channelOrChannels : [channelOrChannels];
  const channelLabel = channels.join('-');
  const [creator] = await db.query<{ id: string }>(`select id from creators limit 1`);
  const [client] = await db.query<{ id: string; email: string }>(
    `insert into clients (creator_id, name, email) values ($1, $2, $3) returning id, email`,
    [creator!.id, `Buyer ${channelLabel}`, `buyer-${channelLabel}-${randomUUID().slice(0, 6)}@example.com`]);
  const [asset] = await db.query<{ id: string; title: string; key_web: string; key_print: string; key_original: string }>(
    `select id, title, key_web, key_print, key_original from assets where title = 'Morning Pour'`);

  const scope: Scope = { channels, territory: 'US', durationMonths: 6, exclusive: false };
  const card = await creatorCard(db, creator!.id);
  const p = price(scope, card);
  const briefId = randomUUID();
  await db.query(
    `insert into briefs (id, creator_id, client_id, asset_id, source, raw, state) values ($1, $2, $3, $4, 'paste', 'need photo for ' || $5, 'extracted')`,
    [briefId, creator!.id, client!.id, asset!.id, channelLabel]);

  const versionId = randomUUID();
  await db.query(
    `insert into licence_versions (id, brief_id, creator_id, client_id, asset_id, version_no, status, scope, total_cents, rate_card)
     values ($1, $2, $3, $4, $5, 1, 'pending', $6, $7, $8)`,
    [versionId, briefId, creator!.id, client!.id, asset!.id, JSON.stringify(scope), p.totalCents, JSON.stringify(card)]);

  const invNumber = invoiceNumberFor(versionId);
  const paypalInvId = await m.api.create({
    invoiceNumber: invNumber,
    recipientEmail: client!.email,
    itemName: channelLabel,
    itemDescription: `Photo licence for ${channelLabel}`,
    amountCents: p.totalCents,
    note: 'test',
  });
  await m.api.send(paypalInvId);

  const invoiceId = randomUUID();
  const payToken = newToken();
  await db.query(
    `insert into invoices (id, version_id, creator_id, invoice_number, paypal_invoice_id, state, pay_token_hash, payer_url, recipient_email)
     values ($1, $2, $3, $4, $5, 'sent', $6, 'https://paypal.test/pay', $7)`,
    [invoiceId, versionId, creator!.id, invNumber, paypalInvId, hashToken(payToken), client!.email]);

  if (opts.paid !== false) {
    m.pay(paypalInvId);
    const g = await grantIfPaid({ db, pp: m.pp, uploadsDir: dir }, versionId, 'test');
    expect(g.granted).toBe(true);
  }

  return { payToken, versionId, asset: asset! };
}

describe('channel deliverable mapping through real download routes', () => {
  it('social channel delivers the web file (~800px), not print', async () => {
    const { payToken, asset } = await createDeal('social');
    const view = await payView(db, payToken);
    expect(view!.fileLabel).toBe('Web file');

    const issueRes = await dlIssuePOST(req(`/api/pay/${payToken}/download`, 'POST'), ctx(payToken));
    expect(issueRes.status).toBe(200);
    const { url } = (await issueRes.json()) as { url: string };
    const dlToken = url.split('/').pop()!;

    const dlRes = await downloadGET(req(`/download/${dlToken}`), ctx(dlToken));
    expect(dlRes.status).toBe(200);
    expect(dlRes.headers.get('content-disposition')).toMatch(/-web\.jpg"$/);
    const downloaded = Buffer.from(await dlRes.arrayBuffer());
    const webBytes = (await readAsset(dir, asset.key_web))!;
    const printBytes = (await readAsset(dir, asset.key_print))!;
    expect(downloaded.equals(webBytes)).toBe(true);
    expect(downloaded.equals(printBytes)).toBe(false);
  });

  it('web channel delivers the web file (~800px), not print', async () => {
    const { payToken, asset } = await createDeal('web');
    const view = await payView(db, payToken);
    expect(view!.fileLabel).toBe('Web file');

    const issueRes = await dlIssuePOST(req(`/api/pay/${payToken}/download`, 'POST'), ctx(payToken));
    expect(issueRes.status).toBe(200);
    const { url } = (await issueRes.json()) as { url: string };
    const dlToken = url.split('/').pop()!;

    const dlRes = await downloadGET(req(`/download/${dlToken}`), ctx(dlToken));
    expect(dlRes.status).toBe(200);
    expect(dlRes.headers.get('content-disposition')).toMatch(/-web\.jpg"$/);
    const downloaded = Buffer.from(await dlRes.arrayBuffer());
    const webBytes = (await readAsset(dir, asset.key_web))!;
    expect(downloaded.equals(webBytes)).toBe(true);
  });

  it('print channel delivers the print-resolution file (3000x2000 for Morning Pour)', async () => {
    const { payToken, asset } = await createDeal('print');
    const view = await payView(db, payToken);
    expect(view!.fileLabel).toBe('Print-resolution file');

    const issueRes = await dlIssuePOST(req(`/api/pay/${payToken}/download`, 'POST'), ctx(payToken));
    expect(issueRes.status).toBe(200);
    const { url } = (await issueRes.json()) as { url: string };
    const dlToken = url.split('/').pop()!;

    const dlRes = await downloadGET(req(`/download/${dlToken}`), ctx(dlToken));
    expect(dlRes.status).toBe(200);
    expect(dlRes.headers.get('content-disposition')).toMatch(/-print\.jpg"$/);
    const downloaded = Buffer.from(await dlRes.arrayBuffer());
    const printBytes = (await readAsset(dir, asset.key_print))!;
    const webBytes = (await readAsset(dir, asset.key_web))!;
    expect(downloaded.equals(printBytes)).toBe(true);
    expect(downloaded.equals(webBytes)).toBe(false);
    // Verifies it is the exact 3000x2000 original stock photograph
    const originalDiskBytes = readFileSync(originalPhotoPath(manifestPhotoFor('Morning Pour')!.num));
    expect(downloaded.equals(originalDiskBytes)).toBe(true);
  });

  it('billboard channel delivers the print-resolution file (largest stored), not web file', async () => {
    const { payToken, asset } = await createDeal('billboard');
    const view = await payView(db, payToken);
    expect(view!.fileLabel).toBe('Print-resolution file');

    const issueRes = await dlIssuePOST(req(`/api/pay/${payToken}/download`, 'POST'), ctx(payToken));
    expect(issueRes.status).toBe(200);
    const { url } = (await issueRes.json()) as { url: string };
    const dlToken = url.split('/').pop()!;

    const dlRes = await downloadGET(req(`/download/${dlToken}`), ctx(dlToken));
    expect(dlRes.status).toBe(200);
    expect(dlRes.headers.get('content-disposition')).toMatch(/-print\.jpg"$/);
    const downloaded = Buffer.from(await dlRes.arrayBuffer());
    const printBytes = (await readAsset(dir, asset.key_print))!;
    const webBytes = (await readAsset(dir, asset.key_web))!;
    expect(downloaded.equals(printBytes)).toBe(true);
    expect(downloaded.equals(webBytes)).toBe(false);
  });

  it('OOH (out-of-home) channel delivers the print-resolution file', async () => {
    const { payToken, asset } = await createDeal('OOH');
    const view = await payView(db, payToken);
    expect(view!.fileLabel).toBe('Print-resolution file');

    const issueRes = await dlIssuePOST(req(`/api/pay/${payToken}/download`, 'POST'), ctx(payToken));
    expect(issueRes.status).toBe(200);
    const { url } = (await issueRes.json()) as { url: string };
    const dlToken = url.split('/').pop()!;

    const dlRes = await downloadGET(req(`/download/${dlToken}`), ctx(dlToken));
    expect(dlRes.status).toBe(200);
    expect(dlRes.headers.get('content-disposition')).toMatch(/-print\.jpg"$/);
    const downloaded = Buffer.from(await dlRes.arrayBuffer());
    const printBytes = (await readAsset(dir, asset.key_print))!;
    expect(downloaded.equals(printBytes)).toBe(true);
  });

  it('TV channel delivers the print-resolution file', async () => {
    const { payToken, asset } = await createDeal('TV');
    const view = await payView(db, payToken);
    expect(view!.fileLabel).toBe('Print-resolution file');

    const issueRes = await dlIssuePOST(req(`/api/pay/${payToken}/download`, 'POST'), ctx(payToken));
    expect(issueRes.status).toBe(200);
    const { url } = (await issueRes.json()) as { url: string };
    const dlToken = url.split('/').pop()!;

    const dlRes = await downloadGET(req(`/download/${dlToken}`), ctx(dlToken));
    expect(dlRes.status).toBe(200);
    expect(dlRes.headers.get('content-disposition')).toMatch(/-print\.jpg"$/);
    const downloaded = Buffer.from(await dlRes.arrayBuffer());
    const printBytes = (await readAsset(dir, asset.key_print))!;
    expect(downloaded.equals(printBytes)).toBe(true);
  });

  it('several channels with a large-format channel ([social, billboard] and demo shape [social, print, billboard]) delivers print-resolution file', async () => {
    for (const channels of [
      ['social', 'billboard'] as Channel[],
      ['social', 'print', 'billboard'] as Channel[],
    ]) {
      const { payToken, asset } = await createDeal(channels);
      const view = await payView(db, payToken);
      expect(view!.fileLabel).toBe('Print-resolution file');

      const issueRes = await dlIssuePOST(req(`/api/pay/${payToken}/download`, 'POST'), ctx(payToken));
      expect(issueRes.status).toBe(200);
      const { url } = (await issueRes.json()) as { url: string };
      const dlToken = url.split('/').pop()!;

      const dlRes = await downloadGET(req(`/download/${dlToken}`), ctx(dlToken));
      expect(dlRes.status).toBe(200);
      expect(dlRes.headers.get('content-disposition')).toMatch(/-print\.jpg"$/);
      const downloaded = Buffer.from(await dlRes.arrayBuffer());
      const printBytes = (await readAsset(dir, asset.key_print))!;
      const webBytes = (await readAsset(dir, asset.key_web))!;
      expect(downloaded.equals(printBytes)).toBe(true);
      expect(downloaded.equals(webBytes)).toBe(false);
    }
  });
});

describe('negative security checks: unpaid or revoked licence gets nothing', () => {
  it('unpaid licence refuses download issuance with 409 locked', async () => {
    const { payToken } = await createDeal('billboard', { paid: false });
    const view = await payView(db, payToken);
    expect(view!.status).toBe('unpaid');

    const issueRes = await dlIssuePOST(req(`/api/pay/${payToken}/download`, 'POST'), ctx(payToken));
    expect(issueRes.status).toBe(409);
    const body = (await issueRes.json()) as { error: string };
    expect(body.error).toBe('Payment not verified, file locked.');
  });

  it('revoked licence refuses new download issuance and voids prior download links', async () => {
    const { payToken, versionId } = await createDeal('billboard', { paid: true });

    // Issue a download token while active
    const issueRes1 = await dlIssuePOST(req(`/api/pay/${payToken}/download`, 'POST'), ctx(payToken));
    expect(issueRes1.status).toBe(200);
    const { url } = (await issueRes1.json()) as { url: string };
    const dlToken = url.split('/').pop()!;

    // Now revoke licence (e.g. refund/reversal)
    await db.query(`update licence_versions set status = 'refunded' where id = $1`, [versionId]);

    // Attempting to issue a new download link is refused
    const issueRes2 = await dlIssuePOST(req(`/api/pay/${payToken}/download`, 'POST'), ctx(payToken));
    expect(issueRes2.status).toBe(409);
    expect(((await issueRes2.json()) as { error: string }).error).toBe('Payment not verified, file locked.');

    // Attempting to consume the previously issued download link fails with 410 gone
    const dlRes = await downloadGET(req(`/download/${dlToken}`), ctx(dlToken));
    expect(dlRes.status).toBe(410);
    expect(((await dlRes.json()) as { error: string }).error).toMatch(/no longer active/i);
  });
});
