// Batch 7 (7A + review fixes): the redesigned deal room over the demo-seeded deals (docs/ui/deal-room.md).
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderToString } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DealRoomView, type DealRoomActions } from '@/components/creator/deal-room';
import { openPglite, type Db } from '../db/client';
import { initialize } from '../db/init';
import { getBriefView, type BriefView } from '../lib/briefs';

let db: Db;
let dir: string;
let briefs: Record<string, string>;
const noop: DealRoomActions = { onEdit: () => {}, onConfirm: () => {}, onDecide: () => {}, onCopy: () => {}, onError: () => {} };
const overJson = <X,>(x: X): X => JSON.parse(JSON.stringify(x));
const textOf = (html: string) => html.replace(/<!--.*?-->/g, '').replace(/<[^>]+>/g, ' ').replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const html = (view: BriefView) => renderToString(<DealRoomView view={view} options={null} busy={false} actions={noop} />);
const viewOf = async (key: string) => overJson((await getBriefView(db, briefs[key]!))!) as BriefView;
const room = async (key: string) => {
  const view = await viewOf(key);
  const h = html(view);
  return { view, html: h, text: textOf(h) };
};

beforeAll(async () => {
  db = await openPglite();
  dir = await mkdtemp(join(tmpdir(), 'ur-b7-room-'));
  briefs = (await initialize(db, dir)).demo.briefs;
});
afterAll(async () => {
  await db?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe('deal room (batch 7)', () => {
  it('links each priced use to the exact client sentence behind it, and strikes out the model price', async () => {
    const { html: h } = await room('ready');
    // social, US and 6mo all come from one sentence: one highlighted anchor, three numbered references to it.
    expect(h.match(/<mark[^>]*id="evidence-1"/g)).toHaveLength(1);
    for (const [n, label] of [[1, 'Social'], [2, 'United States'], [3, '6 months']] as const) {
      expect(h).toContain(`aria-label="Source sentence ${n} for ${label}"`);
    }
    expect(h.match(/href="#evidence-1"/g)).toHaveLength(3);
    expect(h).not.toMatch(/href="#evidence-[23]"/);
    expect(h).toMatch(/<s[^>]*>\$250\.00<\/s>/);
  });

  it('review 4: a sentence the client repeats in the same line gets one anchor, not two', async () => {
    const view = await viewOf('ready');
    const line = view.transcript!.lines[0]!;
    const kept = view.checks!.kept[0]!;
    const sentence = line.text.slice(line.text.indexOf('We would'));
    view.transcript!.lines[0] = { ...line, text: `${line.text} ${sentence}` };
    const h = html(view);
    expect(kept.lineIndex).toBe(0);
    expect(h.match(/id="evidence-1"/g)).toHaveLength(1);
    expect(h.match(/<mark[^>]*tabindex="-1"/g)).toHaveLength(1); // transcript highlights only (scope marks have no tabindex)
  });

  it('shows only the stages the rows prove: the $900 quote stops at Rules, nothing is sent or paid', async () => {
    const { text } = await room('needsApproval');
    expect(text).toContain('Rules : stopped 2 rules stopped');
    expect(text).toContain('Invoice : not reached Not sent');
    expect(text).toContain('Paid : not reached Not paid');
    expect(text).toContain('R2 stopped $900.00 exceeds your $500.00 per-deal cap.');
    expect(text).toContain('R4 stopped Billboard needs your approval.');
    expect(text).toContain('R1 passed The client is on your allowed list.');
    expect(text).toContain('3 passed, 2 stopped.');
    expect(text).toContain('combined price $1,200.00 - $300.00 already paid = $900.00 due');
    expect(text).toContain('Review the next step');
  });

  it('review 9: evidence, price and rules come before the approval form', async () => {
    const { text } = await room('needsApproval');
    const at = (s: string) => text.indexOf(s);
    expect(at('The client’s words')).toBeGreaterThan(-1);
    expect(at('Type the total to approve')).toBeGreaterThan(at('Amount due'));
    expect(at('Type the total to approve')).toBeGreaterThan(at('R5 passed'));
    expect(text).toContain('Approve and send $900.00 invoice');
  });

  it('review 1 / review D1: a seeded paid deal never reads as PayPal proof and offers no PayPal actions', async () => {
    const { view, text } = await room('paid');
    expect(view.version!.invoice!.demo).toBe(true);
    expect(text).toContain('Seeded as paid');
    expect(text).toContain('Demo data: this invoice and its payment were seeded for the walkthrough.');
    expect(text).not.toMatch(/verified with PayPal/i);
    expect(text).not.toContain('File unlocked');
    expect(text).not.toContain('Re-check PayPal');
    expect(text).not.toContain('PayPal invoice id');
  });

  it('review 8 / review D1: a seeded invoiced deal hides Re-check, payer-link request, and cancellation', async () => {
    const { text } = await room('invoiced');
    expect(text).toContain('Seeded as sent. No client will pay it.');
    expect(text).not.toContain('Re-check PayPal');
    expect(text).not.toContain('Get the payer link from PayPal');
    expect(text).not.toContain('Cancel invoice and re-quote');
    expect(text).not.toContain('cancel it first');
  });

  it('a live (non-demo) paid deal still says verified with PayPal', async () => {
    const view = await viewOf('paid');
    view.version!.invoice!.demo = false;
    const text = textOf(html(view));
    expect(text).toContain('Paid and verified with PayPal.');
    expect(text).toContain('Paid : done File unlocked');
    expect(text).toContain('Re-check PayPal');
  });

  it('refunded and withdrawn deals read as terminal, with no approve control', async () => {
    const refunded = await room('refunded');
    expect(refunded.text).toContain('Seeded as refunded');
    expect(refunded.text).toContain('Paid : failed Seeded as refunded (demo)');
    expect(refunded.text).not.toMatch(/refunded or reversed in PayPal/);
    const withdrawn = await room('withdrawn');
    expect(withdrawn.text).toContain('Invoice cancelled');
    expect(withdrawn.text).not.toContain('Approve');
  });

  it('opens setup for an unknown sender so the creator can pick the client; a known one starts closed', async () => {
    const unknown = await room('needsYou');
    expect(unknown.text).toContain('Unknown sender');
    expect(unknown.html).toContain('id="setup-client"');
    expect((await room('invoiced')).html).not.toContain('id="setup-client"');
  });
});
