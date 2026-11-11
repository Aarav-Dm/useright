// Opt-in live test: LIVE_AI=1 AI_PROVIDER=gemini GEMINI_API_KEY=... npm test -- tests/live-ai.test.ts
// (or AI_PROVIDER=openai_compat with AI_BASE_URL, AI_API_KEY, AI_MODEL). Skipped otherwise.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SAMPLES } from '@/components/creator/request-samples';
import { adapterFromEnv, createAdapter, fixtureProvider, type AiAdapter } from '../lib/ai/extract';
import { gap } from '../lib/gap';
import { DEFAULT_CARD } from '../lib/pricing';
import { normalise, runChecks } from '../lib/checks';
import { pasteToTranscript } from '../lib/intake';
import type { Scope } from '../lib/pricing';
import * as T from './fixtures/texts';

const live = process.env.LIVE_AI === '1' && !!process.env.AI_PROVIDER && process.env.AI_PROVIDER !== 'fixture';
const v1: Scope = { channels: ['social'], territory: 'US', durationMonths: 6, exclusive: false };

/** B11 §4.1: the three filmed samples must come out as the script says. Rows 2 and 5 depend on this with a real model. */
async function filmedSamples(aiFor: (fixture: string) => AiAdapter) {
  const read = async (key: string, current: Scope | null) => {
    const s = SAMPLES.find((x) => x.key === key)!;
    const transcript = pasteToTranscript(s.text!, true);
    const res = await aiFor(s.fixture).extract(transcript, s.assetTitle);
    expect(res.ok, key).toBe(true);
    if (!res.ok) throw new Error(key);
    return runChecks({ transcript, extraction: res.value, current });
  };
  const print = await read('print', v1);
  expect(print.status).toBe('ready');
  expect(gap(print.requested!, v1, 30000, DEFAULT_CARD).totalCents).toBe(42000);
  const billboard = await read('billboard', v1);
  expect(billboard.status).toBe('ready');
  expect(gap(billboard.requested!, v1, 30000, DEFAULT_CARD).totalCents).toBe(90000);
  const paid = await read('paid', null);
  expect(paid.status).toBe('needs_creator');
  expect(paid.reasons).toEqual(expect.arrayContaining(['tripwire:boost', 'tripwire:paid ads']));
}

it('the filmed-sample expectations hold on the fixtures', () => filmedSamples((f) => createAdapter(fixtureProvider(f))));

describe.skipIf(!live)('LIVE_AI: real provider', () => {
  it('the three filmed samples: print ready at $420, billboard ready at $900, paid ads stopped', { timeout: 180_000 }, () => filmedSamples(() => adapterFromEnv(process.env)));

  it('paste fixture text -> social, quote-backed', { timeout: 120_000 }, async () => {
    const ai = adapterFromEnv(process.env);
    const transcript = pasteToTranscript(T.PASTE);
    const res = await ai.extract(transcript, 'Harbor Light');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const checks = runChecks({ transcript, extraction: res.value, current: null });
    expect(checks.kept.map((k) => k.optionId)).toContain('social');
    expect(checks.dropped).toEqual([]);
  });

  it('demo-dm.png -> transcribe -> confirm -> extract finds the buried print sentence (fix 14)', { timeout: 180_000 }, async () => {
    const ai = adapterFromEnv(process.env);
    const png = await readFile(join(import.meta.dirname, 'fixtures', 'demo-dm.png'));
    const t = await ai.transcribe({ mime: 'image/png', base64: png.toString('base64') });
    expect(t.ok).toBe(true);
    if (!t.ok) return;
    // "Confirm" step: the creator accepts the labels. The model must have found the client's lines.
    expect(t.value.lines.some((l) => l.speaker === 'client' && /printed menus/i.test(l.text))).toBe(true);
    const ex = await ai.extract(t.value, 'Morning Pour');
    expect(ex.ok).toBe(true);
    if (!ex.ok) return;
    const checks = runChecks({ transcript: t.value, extraction: ex.value, current: v1 });
    const print = checks.kept.find((k) => k.optionId === 'print');
    expect(print?.sentence).toBe(normalise(T.DEMO_DM_PRINT_SENTENCE).replace(/\.$/, ''));
  });
});
