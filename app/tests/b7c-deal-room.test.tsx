// Batch 7C phase 2: deal room additions over the demo-seeded deals (what happens next, why this price, agent
// timeline from the ledger, highlighted how-it-works step, client preview link, term tips).
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderToString } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DealRoomView, type DealRoomActions } from '@/components/creator/deal-room';
import { openPglite, type Db } from '../db/client';
import { initialize } from '../db/init';
import { getBriefView, type BriefView } from '../lib/briefs';
import { listLedger, type LedgerRow } from '../lib/ledger';

let db: Db;
let dir: string;
let briefs: Record<string, string>;
let ledger: LedgerRow[];
const noop: DealRoomActions = { onEdit: () => {}, onConfirm: () => {}, onDecide: () => {}, onCopy: () => {}, onError: () => {} };
const overJson = <X,>(x: X): X => JSON.parse(JSON.stringify(x));
const textOf = (html: string) => html.replace(/<!--.*?-->/g, '').replace(/<[^>]+>/g, ' ').replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/\s+/g, ' ');
async function room(key: string) {
  const view = overJson((await getBriefView(db, briefs[key]!))!) as BriefView;
  const rows = overJson(ledger.filter((r) => r.briefId === briefs[key]));
  const html = renderToString(<DealRoomView view={view} options={null} busy={false} actions={noop} timeline={rows} publicPath="/c/imani" />);
  return { html, text: textOf(html) };
}

beforeAll(async () => {
  db = await openPglite();
  dir = await mkdtemp(join(tmpdir(), 'ur-b7c-room-'));
  const r = await initialize(db, dir);
  briefs = r.demo.briefs;
  ledger = await listLedger(db, r.seed.creatorId);
});
afterAll(async () => {
  await db?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe('deal room additions', () => {
  it('the $900 quote: what happens next, the highlighted step, why this price and the rule timeline', async () => {
    const { html, text } = await room('needsApproval');
    expect(text).toContain('What happens next A rule stopped the quote, so nothing was sent. Type the exact total in Ask me to send it, or reject it. If PayPal cannot take it (under $1.00, no client email), fix the deal instead. This needs you.');
    // B12 E5: one progress line (the observed rail); the step crumb is gone and the gap equation is at the top.
    expect(html).not.toContain('aria-label="How it works"');
    expect(text).toContain('Social, US, 6 mo → Social, Billboard, US, 6 mo: $1,200.00 − $300.00 = $900.00');
    expect(text.match(/frozen with quote v2/g)).toHaveLength(1);
    expect(text).toContain('Why this price');
    expect(text).toContain('Billboard $900.00 new');
    // review B7C-2 finding 7: the credit names the earlier licence, not a version number that changes once v2 is paid.
    expect(text).toContain('Already paid -$300.00 already paid on the earlier licence, taken off');
    expect(text).toContain('The client wrote: “We want to put the Morning Pour photo on a billboard on I-95 for the next six months.”');
    expect(text).toContain('Total $900.00 = $1,200.00 for the full scope minus $300.00 already paid.');
    expect(text).toContain('What the agent did');
    // review final N2: the timeline uses the bell's past-tense words after the original "R2 stopped".
    expect(text).toContain('R2 stopped, held for your OK: $900.00 exceeds your $500.00 per-deal cap.');
    expect(html).toContain('href="/c/imani"');
    expect(html).toContain('aria-label="What is rules r1 to r5?"');
  });

  it('a seeded paid deal reads as demo in every addition', async () => {
    const { text } = await room('paid');
    expect(text).toContain('What happens next Seeded as paid for the walkthrough. This is not a PayPal payment.');
    expect(text).toContain('Seeded as paid for the walkthrough.');
    expect(text).not.toMatch(/PayPal confirmed the payment/);
    expect(text).not.toContain('their pay page');
  });

  it('without a timeline prop the section is left out (other screens keep rendering as before)', async () => {
    const view = overJson((await getBriefView(db, briefs.ready!))!) as BriefView;
    const text = textOf(renderToString(<DealRoomView view={view} options={null} busy={false} actions={noop} />));
    expect(text).not.toContain('What the agent did');
    expect(text).toContain('Why this price');
  });
});
