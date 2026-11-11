// Batch-4 review fix (review): deals with no price yet render in the deals list and the deal room,
// with their status, their reasons and "No price yet". One test per state, plus a ready control.
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderToString } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DealRoomView, type DealRoomActions } from '@/components/creator/deal-room';
import { DealsTable, NO_PRICE } from '@/components/creator/deals-table';
import { openPglite, type Db } from '../db/client';
import { migrate } from '../db/migrate';
import { seed, type SeedResult } from '../db/seed';
import { createAdapter, fixtureProvider } from '../lib/ai/extract';
import { confirmTranscript, editBrief, getBriefView, type AiFor, type BriefView } from '../lib/briefs';
import { listDeals, type DealRow } from '../lib/deals';
import { STATUS_LABEL } from '../lib/format';
import { intake, type IntakeDeps } from '../lib/intake';
import { describeReason } from '../lib/reasons';
import { runAutopilot } from '../lib/send';
import * as T from './fixtures/texts';
import { mockInvoiceApi } from './helpers/mock-paypal';

let db: Db;
let s: SeedResult;
let deps: IntakeDeps;
let uploadsDir: string;
const aiFor: AiFor = (fixture) => createAdapter(fixtureProvider(fixture ?? 'paste'));
const creator = { creator: true, sessionSlug: 'imani' };
const ids: Record<string, string> = {};
const noop: DealRoomActions = { onEdit: () => {}, onConfirm: () => {}, onDecide: () => {}, onCopy: () => {}, onError: () => {} };

/** What the browser receives: JSON, so dates are strings. */
const overJson = <X,>(x: X): X => JSON.parse(JSON.stringify(x));
/** Rendered HTML as plain text, entities decoded. Inline tags join text like a browser; other tags break words. */
const textOf = (html: string) =>
  html
    .replace(/<!--.*?-->/g, '')
    .replace(/<\/?(?:span|mark|s|code|b|strong|em)\b[^>]*>/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');

async function screenshot(fixture: string) {
  const png = await readFile(join(import.meta.dirname, 'fixtures', 'demo-dm.png'));
  const r = await intake(deps, { source: 'screenshot', clientId: s.clientId, assetId: s.assetIds[0]!, fixture, image: { mime: 'image/png', base64: png.toString('base64') } }, creator);
  if (!r.ok) throw new Error(r.error);
  return r.briefId;
}
async function paste(fixture: string, text: string) {
  const r = await intake(deps, { source: 'paste', clientId: s.clientId, assetId: s.assetIds[0]!, text, fixture }, creator);
  if (!r.ok) throw new Error(r.error);
  return r.briefId;
}

beforeAll(async () => {
  db = await openPglite();
  await migrate(db);
  s = await seed(db);
  uploadsDir = await mkdtemp(join(tmpdir(), 'ur-states-'));
  deps = { db, aiFor, uploadsDir, env: { AI_PROVIDER: 'fixture', NODE_ENV: 'test' } as NodeJS.ProcessEnv };

  const port = await intake(deps, { source: 'portfolio', assetId: s.assetIds[1]!, email: 'wait@cafe.example', text: T.PASTE }, { creator: false, sessionSlug: 'imani' });
  if (!port.ok) throw new Error(port.error);
  ids.awaiting_verification = port.briefId;
  ids.awaiting_transcript = await screenshot('demo-dm');
  ids.transcript_empty = await screenshot('transcribe-fails');
  // Extracted state but its extraction row is gone (e.g. a failed write): must not crash.
  ids.no_extraction = await paste('paste', T.UNKNOWN_SENDER.replace('Northwind here! ', ''));
  await db.query(`delete from extractions where brief_id = $1`, [ids.no_extraction]);
  ids.ai_invalid = await paste('invalid-json', 'Can we use the Morning Pour photo on our website please?');
  ids.clarify = await paste('clarify', T.CLARIFY);
  ids.ready = await screenshot('demo-dm');
  await confirmTranscript(db, aiFor, ids.ready, T.DEMO_DM);
});
afterAll(async () => {
  await db?.close();
  if (uploadsDir) await rm(uploadsDir, { recursive: true, force: true });
});

const CASES: { key: string; status: string; reasons: string[] }[] = [
  { key: 'awaiting_verification', status: 'awaiting_verification', reasons: ['awaiting_verification'] },
  { key: 'awaiting_transcript', status: 'awaiting_transcript', reasons: ['awaiting_transcript'] },
  { key: 'transcript_empty', status: 'awaiting_transcript', reasons: ['transcript_empty'] },
  { key: 'no_extraction', status: 'needs_creator', reasons: ['no_extraction'] },
  { key: 'ai_invalid', status: 'needs_creator', reasons: ['ai_invalid'] },
  { key: 'clarify', status: 'clarify', reasons: ['clarify:model_question', 'clarify:no_uses'] },
];

describe.each(CASES)('no-price state: $key', ({ key, status, reasons }) => {
  let view: BriefView;
  let row: DealRow;
  beforeAll(async () => {
    view = overJson((await getBriefView(db, ids[key]!))!);
    row = overJson((await listDeals(db, s.creatorId)).find((d) => d.briefId === ids[key])!);
  });

  it('read model: status, reasons, no gap', () => {
    expect(view).toMatchObject({ status, reasons, gapPreview: null, cardSource: null });
    for (const r of reasons) expect(describeReason(r)).not.toMatch(/^Unrecognised/);
  });

  it('deals list row: same status and reasons, null total', () => {
    expect(row).toMatchObject({ status, reasons, gapTotalCents: null });
  });

  it('deals table renders the row with its status, reason and "No price yet"', () => {
    const text = textOf(renderToString(<DealsTable deals={[row]} />));
    expect(text).toContain(STATUS_LABEL[status]!);
    expect(text).toContain(describeReason(reasons[0]!));
    expect(text).toContain(NO_PRICE);
  });

  it('deal room renders with its status, every reason and "No price yet"', () => {
    const text = textOf(renderToString(<DealRoomView view={view} options={null} busy={false} actions={noop} />));
    expect(text).toContain(STATUS_LABEL[status]!);
    for (const r of reasons) expect(text).toContain(describeReason(r));
    expect(text).toContain('No price yet.');
  });
});

describe('state-specific deal room details', () => {
  it('clarify shows the drafted question with Copy', async () => {
    const text = textOf(renderToString(<DealRoomView view={overJson((await getBriefView(db, ids.clarify!))!)} options={null} busy={false} actions={noop} />));
    expect(text).toContain('Which channels will the new campaign run on, and for how long?');
    expect(text).toContain('Copy question');
    expect(text).not.toContain('Approve');
  });
  it('needs_creator with no price shows Reject but no Approve (nothing to approve yet)', async () => {
    const text = textOf(renderToString(<DealRoomView view={overJson((await getBriefView(db, ids.ai_invalid!))!)} options={null} busy={false} actions={noop} />));
    expect(text).not.toContain('Approve');
    expect(text).toContain('Reject');
  });
  it('empty transcript offers "Add a line" so the creator can type it in', async () => {
    const text = textOf(renderToString(<DealRoomView view={overJson((await getBriefView(db, ids.transcript_empty!))!)} options={null} busy={false} actions={noop} />));
    expect(text).toContain('Add a line');
    expect(text).toContain('It is priced once you confirm the transcript.');
  });
  it('awaiting verification hides the confirm controls', async () => {
    const text = textOf(renderToString(<DealRoomView view={overJson((await getBriefView(db, ids.awaiting_verification!))!)} options={null} busy={false} actions={noop} />));
    expect(text).toContain('has not confirmed their email');
    expect(text).not.toContain('Confirm transcript');
  });
});

describe('ready control', () => {
  it('renders a price, not "No price yet", in both screens', async () => {
    const view = overJson((await getBriefView(db, ids.ready!))!);
    expect(view).toMatchObject({ status: 'ready', reasons: [] });
    const room = textOf(renderToString(<DealRoomView view={view} options={null} busy={false} actions={noop} />));
    expect(room).toContain('$420.00');
    expect(room).not.toContain('No price yet');
    const rows = overJson(await listDeals(db, s.creatorId));
    const table = textOf(renderToString(<DealsTable deals={rows} />));
    expect(table).toContain('$420.00');
    expect(table.match(new RegExp(NO_PRICE, 'g'))).toHaveLength(CASES.length);
  });
});


describe('Current -> Requested comparison (review fix, review)', () => {
  it('read model carries current, combined, added options and the sum', async () => {
    const g = (await getBriefView(db, ids.ready!))!.gapPreview!;
    expect(g).toMatchObject({
      current: { channels: ['social'], territory: 'US', durationMonths: 6, exclusive: false },
      combined: { channels: ['social', 'print'], territory: 'US', durationMonths: 6, exclusive: false },
      newOptionIds: ['print'],
      combinedCents: 72000,
      paidCents: 30000,
      totalCents: 42000,
    });
    expect(g.combinedCents - g.paidCents).toBe(g.totalCents);
  });

  it('demo DM renders "Social, US, 6 mo" -> "Social + Print, US, 6 mo" with Print marked and the labelled sum', async () => {
    const html = renderToString(<DealRoomView view={overJson((await getBriefView(db, ids.ready!))!)} options={null} busy={false} actions={noop} />);
    const text = textOf(html);
    expect(text).toContain('Current Social, US, 6 mo');
    expect(text).toContain('Requested Social + Print, US, 6 mo');
    expect(html).toMatch(/<mark[^>]*>Print<\/mark>/);
    expect(html).not.toMatch(/<mark[^>]*>Social<\/mark>/);
    expect(text).toContain('combined price $720.00 - $300.00 already paid = $420.00 due');
  });

  it('v1 shows "No licence yet", every requested option marked, no paid credit', async () => {
    const id = await paste('paste', T.PASTE);
    await db.query(`update briefs set asset_id = $1 where id = $2`, [s.assetIds[1], id]); // Harbor Light: no licence
    const view = overJson((await getBriefView(db, id))!);
    expect(view.gapPreview).toMatchObject({ current: null, paidCents: 0, combinedCents: 30000, totalCents: 30000 });
    const html = renderToString(<DealRoomView view={view} options={null} busy={false} actions={noop} />);
    const text = textOf(html);
    expect(text).toContain('Current No licence yet');
    expect(text).toContain('Requested Social, US, 6 mo');
    expect(html).toMatch(/<mark[^>]*>Social<\/mark>/);
    expect(text).toContain('price $300.00 = $300.00 due');
    expect(text).not.toContain('already paid');
  });

  it('a territory and term upgrade marks the new territory and term', async () => {
    // review P2: each use needs a sentence that names it, so the client adds one.
    const naLine = 'We would also like North America for 12 months.';
    await confirmTranscript(db, aiFor, ids.ready!, { lines: [...T.DEMO_DM.lines, { speaker: 'client', text: naLine }] });
    const r = await editBrief(db, s.creatorId, ids.ready!, {
      uses: [{ optionId: 'print', quote: T.DEMO_DM_PRINT_SENTENCE }, { optionId: 'NA', quote: naLine }, { optionId: '12mo', quote: naLine }],
    });
    if (!r.ok) throw new Error(r.error);
    const html = renderToString(<DealRoomView view={overJson(r.view)} options={null} busy={false} actions={noop} />);
    expect(textOf(html)).toContain('Requested Social + Print, North America, 12 mo');
    for (const label of ['Print', 'North America', '12 mo']) expect(html).toMatch(new RegExp(`<mark[^>]*>${label}</mark>`));
    // social 15000 + print 42000 + NA 10000 + 12mo 30000 = 97000, minus 30000 paid
    expect(textOf(html)).toContain('combined price $970.00 - $300.00 already paid = $670.00 due');
  });
});

describe('creator-reviewed notes render (review fix, review)', () => {
  it('a creator edit shows Ready plus the reviewed findings as notes, not as blocking reasons', async () => {
    const id = await paste('tripwire-miss', T.TRIPWIRE_MISS);
    const r = await editBrief(db, s.creatorId, id, { uses: [{ optionId: 'web', quote: 'Please add the photo to our website too.' }] });
    if (!r.ok) throw new Error(r.error);
    const text = textOf(renderToString(<DealRoomView view={overJson(r.view)} options={null} busy={false} actions={noop} />));
    expect(text).toContain(STATUS_LABEL.ready!);
    expect(text).toContain('Noted (you reviewed these)');
    expect(text).toContain(describeReason('tripwire:worldwide'));
    expect(text).not.toContain('Why this needs you');
    expect(text).not.toContain('Approve');
  });
});

describe('deal room send lifecycle (batch-5 fix 12)', () => {
  it('invoiced shows the PayPal id, payer link and cancel; failed shows the error and Retry; needs_approval shows the typed-total form', async () => {
    const pp = mockInvoiceApi();
    const id = await screenshot('demo-dm');
    await confirmTranscript(db, aiFor, id, T.DEMO_DM);
    await runAutopilot(db, pp.api, id);
    const invoiced = overJson((await getBriefView(db, id))!);
    const html = textOf(renderToString(<DealRoomView view={invoiced} options={null} busy={false} actions={noop} />));
    expect(html).toContain(STATUS_LABEL.invoiced!);
    expect(html).toContain(invoiced.version!.invoice!.paypalInvoiceId!);
    expect(html).toContain('Payer link');
    expect(html).toContain('Cancel invoice and re-quote');

    const failedView = { ...invoiced, status: 'failed' as const, reasons: ['send_failed'], version: { ...invoiced.version!, sendState: 'failed' as const, sendError: 'PayPal refused the invoice (INTERNAL_SERVER_ERROR).' } };
    const failed = textOf(renderToString(<DealRoomView view={failedView} options={null} busy={false} actions={noop} />));
    expect(failed).toContain('PayPal refused the invoice (INTERNAL_SERVER_ERROR).');
    expect(failed).toContain('Retry');

    const billboard = await intake(deps, { source: 'paste', clientId: s.clientId, assetId: s.assetIds[0]!, text: T.BILLBOARD, fixture: 'billboard' }, creator);
    if (!billboard.ok) throw new Error(billboard.error);
    await runAutopilot(db, pp.api, billboard.briefId);
    const ask = textOf(renderToString(<DealRoomView view={overJson((await getBriefView(db, billboard.briefId))!)} options={null} busy={false} actions={noop} />));
    expect(ask).toContain('$900.00 exceeds your $500.00 per-deal cap.');
    expect(ask).toContain('Billboard needs your approval.');
    expect(ask).toContain('Type the total to approve');
  });
});
