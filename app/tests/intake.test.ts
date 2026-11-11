import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openPglite, type Db } from '../db/client';
import { migrate } from '../db/migrate';
import { seed, type SeedResult } from '../db/seed';
import { createAdapter, fixtureProvider } from '../lib/ai/extract';
import { confirmTranscript, getBriefView, type AiFor } from '../lib/briefs';
import { normalise } from '../lib/checks';
import { intake, issueVerifyLink, verifyEmail, RATE_LIMIT_PER_HOUR, type IntakeDeps, type IntakeOk } from '../lib/intake';
import { unsellable } from '../lib/policy-flags';
import { DEFAULT_CARD, price } from '../lib/pricing';
import * as T from './fixtures/texts';

let db: Db;
let s: SeedResult;
let deps: IntakeDeps;
let uploadsDir: string;
let morningPour: string; // Northwind holds v1 social/US/6mo on this one
let harborLight: string; // public, no licence
let studioPortrait: string; // private
const fixtureCalls: (string | null)[] = [];
const aiFor: AiFor = (fixture) => {
  fixtureCalls.push(fixture);
  return createAdapter(fixtureProvider(fixture ?? 'paste'));
};
const creator = { creator: true, sessionSlug: 'imani' };

beforeAll(async () => {
  db = await openPglite();
  await migrate(db);
  s = await seed(db);
  [morningPour, harborLight, studioPortrait] = s.assetIds as [string, string, string];
  uploadsDir = await mkdtemp(join(tmpdir(), 'ur-uploads-'));
  deps = { db, aiFor, uploadsDir, env: { AI_PROVIDER: 'fixture', NODE_ENV: 'test' } };
});
afterAll(async () => {
  await db?.close();
  if (uploadsDir) await rm(uploadsDir, { recursive: true, force: true });
});

async function paste(fixture: string, text: string, opts: { clientId?: string; assetId?: string; deps?: IntakeDeps } = {}) {
  const r = await intake(opts.deps ?? deps, { source: 'paste', clientId: opts.clientId ?? s.clientId, assetId: opts.assetId ?? morningPour, text, fixture }, creator);
  if (!r.ok) throw new Error(r.error);
  return r;
}

/** review P1: the link comes from the creator side now, never from the public intake response. */
async function tokenFor(briefId: string) {
  const l = await issueVerifyLink(db, s.creatorId, briefId);
  if (!l.ok) throw new Error(l.error);
  return l.url.split('/').pop()!;
}
const view = async (r: IntakeOk) => (await getBriefView(db, r.briefId))!;
const countExtractions = async (briefId: string) =>
  (await db.query<{ n: number }>(`select count(*)::int as n from extractions where brief_id = $1`, [briefId]))[0]!.n;

describe('demo DM screenshot (fix 3, 13)', () => {
  it('waits for the creator to confirm the transcript, then finds the buried print request with its sentence', async () => {
    const png = await readFile(join(import.meta.dirname, 'fixtures', 'demo-dm.png'));
    const r = await intake(deps, {
      source: 'screenshot', clientId: s.clientId, assetId: morningPour, fixture: 'demo-dm',
      image: { mime: 'image/png', base64: png.toString('base64') },
    }, creator);
    if (!r.ok) throw new Error(r.error);
    expect(r).toMatchObject({ state: 'awaiting_transcript', extraction: null, clientId: s.clientId });
    expect(await countExtractions(r.briefId)).toBe(0);

    const draft = await view(r);
    expect(draft.brief.hasImage).toBe(true);
    expect(draft.transcript?.confirmed_at).toBeNull();
    expect(draft.transcript?.lines).toEqual(T.DEMO_DM.lines);

    const ex = await confirmTranscript(db, aiFor, r.briefId, T.DEMO_DM);
    expect(ex.status).toBe('ready');
    const after = await view(r);
    expect(after.transcript?.confirmed_at).not.toBeNull();
    const print = after.checks?.kept.find((k) => k.optionId === 'print');
    expect(print).toMatchObject({ lineIndex: 2, sentence: normalise(T.DEMO_DM_PRINT_SENTENCE).replace(/\.$/, '') });
    // v2 against Northwind's paid v1 at its frozen card: social+print US 6mo (72000) - 30000 paid.
    expect(after.gapPreview).toMatchObject({ against: 'licence', parentVersionId: s.v1Id, totalCents: 42000, newOptionIds: ['print'] });
  });
});

describe('extraction outcomes (§6)', () => {
  it('plain paste -> ready, v1 priced from an empty licence', async () => {
    const r = await paste('paste', T.PASTE, { assetId: harborLight });
    expect(r.extraction?.status).toBe('ready');
    const v = await view(r);
    expect(v.gapPreview).toMatchObject({ against: 'empty', totalCents: 30000, refused: false });
  });

  it('billboard request -> gap 90000 and billboard is unsellable', async () => {
    const r = await paste('billboard', T.BILLBOARD);
    const v = await view(r);
    expect(v.gapPreview?.totalCents).toBe(90000);
    expect(unsellable(v.gapPreview!.newOptionIds, { autoChannels: ['social', 'web', 'print'] })).toEqual(['billboard']);
  });

  it('"we will NOT use this in print" -> needs_creator negation', async () => {
    const r = await paste('negation', T.NEGATION);
    expect(r.extraction).toMatchObject({ status: 'needs_creator' });
    expect(r.extraction?.reasons).toEqual(['tripwire:print', 'negation']);
  });

  it('"Northwind here" from an unknown sender -> no client_id, needs_creator unknown_sender', async () => {
    const r = await paste('unknown-sender', T.UNKNOWN_SENDER, { clientId: 'unknown' });
    expect(r.clientId).toBeNull();
    const v = await view(r);
    expect(v.brief.client_id).toBeNull();
    expect(v.client).toBeNull();
    expect(v.extraction?.status).toBe('needs_creator');
    expect(v.extraction?.reasons[0]).toBe('unknown_sender');
  });

  it('hallucinated quote and unknown option are dropped, flagged and logged', async () => {
    const r = await paste('hallucinated', T.HALLUCINATED, { assetId: harborLight });
    expect(r.extraction?.status).toBe('needs_creator');
    expect(r.extraction?.reasons).toEqual(['quote_missing:print', 'unknown_option:radio']);
    const v = await view(r);
    expect(v.checks?.kept.map((k) => k.optionId)).toEqual(['web', 'US', '6mo']);
    expect(v.checks?.dropped.map((d) => d.optionId)).toEqual(['print', 'radio']);
    const ev = await db.query(`select 1 from events where kind = 'extraction.dropped' and detail->>'briefId' = $1`, [r.briefId]);
    expect(ev).toHaveLength(1);
  });

  it('invalid JSON twice -> needs_creator ai_invalid, both attempts kept', async () => {
    const r = await paste('invalid-json', 'Can we use the Morning Pour photo on our website please?');
    expect(r.extraction).toMatchObject({ status: 'needs_creator', reasons: ['ai_invalid'] });
    expect((r.extraction?.raw_model as { attempts: unknown[] }).attempts).toHaveLength(2);
    expect((await view(r)).gapPreview).toBeNull();
  });

  it('model price is stored but never reaches gap()', async () => {
    const r = await paste('suggests-price', T.SUGGESTS_PRICE, { assetId: harborLight });
    expect(r.extraction?.suggested_price_cents).toBe(5000);
    const v = await view(r);
    const expected = price({ channels: ['web'], territory: 'US', durationMonths: 6, exclusive: false }, DEFAULT_CARD);
    expect(v.gapPreview?.totalCents).toBe(expected.totalCents); // 25000
    expect(v.gapPreview?.lines.some((l) => l.cents === 5000)).toBe(false);
  });

  it('tripwire word with no matching use -> needs_creator', async () => {
    const r = await paste('tripwire-miss', T.TRIPWIRE_MISS);
    expect(r.extraction).toMatchObject({ status: 'needs_creator', reasons: ['tripwire:worldwide'] });
  });

  it('ambiguous request -> clarify with the drafted question stored', async () => {
    const r = await paste('clarify', T.CLARIFY);
    expect(r.extraction).toMatchObject({ status: 'clarify', clarifying_question: 'Which channels will the new campaign run on, and for how long?' });
  });

  it('v1 with no territory or duration stated -> needs_creator scope_unstated', async () => {
    const r = await paste('scope-unstated', T.SCOPE_UNSTATED, { assetId: harborLight });
    expect(r.extraction?.reasons).toEqual(['scope_unstated:territory', 'scope_unstated:duration']);
  });
});

describe('portfolio and form identity (A2, fix 4)', () => {
  it('unverified portfolio email -> no extraction; verifying creates a not-allowed client and extracts', async () => {
    const r = await intake(deps, { source: 'portfolio', assetId: harborLight, email: 'Buyer@Cafe.example', name: 'Cafe Buyer', text: T.PASTE, fixture: 'paste' }, { creator: false, sessionSlug: 'imani' });
    if (!r.ok) throw new Error(r.error);
    expect(r).toMatchObject({ state: 'awaiting_verification', clientId: null, extraction: null });
    expect(await countExtractions(r.briefId)).toBe(0);
    await expect(confirmTranscript(db, aiFor, r.briefId, { lines: [{ speaker: 'client', text: T.PASTE }] })).rejects.toThrow(/verification/);

    const token = await tokenFor(r.briefId);
    const v = await verifyEmail(deps, token);
    expect(v).toMatchObject({ ok: true, briefId: r.briefId });
    if (!v.ok) return;
    expect(v.extraction?.status).toBe('ready');
    const [client] = await db.query(`select name, email, allowed from clients where id = $1`, [v.clientId]);
    expect(client).toEqual({ name: 'Cafe Buyer', email: 'buyer@cafe.example', allowed: false });
    expect(await verifyEmail(deps, token)).toMatchObject({ ok: false, status: 410 });
  });

  it('verifying an existing client email reuses that client and keeps its allowed flag', async () => {
    const r = await intake(deps, { source: 'portfolio', assetId: harborLight, email: 'buying@northwind.example', text: T.PASTE, fixture: 'paste' }, { creator: false, sessionSlug: 'imani' });
    if (!r.ok) throw new Error(r.error);
    const v = await verifyEmail(deps, await tokenFor(r.briefId));
    expect(v).toMatchObject({ ok: true, clientId: s.clientId });
    const [c] = await db.query(`select allowed from clients where id = $1`, [s.clientId]);
    expect(c).toEqual({ allowed: true });
  });

  it('expired link is refused', async () => {
    const r = await intake(deps, { source: 'portfolio', assetId: harborLight, email: 'late@cafe.example', text: T.PASTE }, { creator: false, sessionSlug: 'imani' });
    if (!r.ok) throw new Error(r.error);
    const later = { ...deps, now: () => new Date(Date.now() + 31 * 60 * 1000) };
    expect(await verifyEmail(later, await tokenFor(r.briefId))).toMatchObject({ ok: false, status: 410, error: 'link expired' });
  });

  it('portfolio intake for a private asset is refused', async () => {
    const r = await intake(deps, { source: 'portfolio', assetId: studioPortrait, email: 'x@cafe.example', text: T.PASTE }, { creator: false, sessionSlug: 'imani' });
    expect(r).toMatchObject({ ok: false, status: 404 });
  });

  it('form extracts at once but has no client until the email is verified', async () => {
    const r = await intake(deps, { source: 'form', creatorSlug: 'imani', assetId: harborLight, email: 'form@cafe.example', text: T.PASTE, fixture: 'paste' }, { creator: false, sessionSlug: 'imani' });
    if (!r.ok) throw new Error(r.error);
    expect(r.clientId).toBeNull();
    expect(r.extraction).toMatchObject({ status: 'needs_creator', reasons: ['unknown_sender'] });
    const v = await verifyEmail(deps, await tokenFor(r.briefId));
    expect(v.ok && v.extraction?.status).toBe('ready');
  });

  it('the public intake response never carries a verify link, in any env (review P1)', async () => {
    const prod = { ...deps, env: { AI_PROVIDER: 'fixture', NODE_ENV: 'production' } as NodeJS.ProcessEnv };
    const r = await intake(prod, { source: 'portfolio', assetId: harborLight, email: 'p@cafe.example', text: T.PASTE }, { creator: false, sessionSlug: 'imani' });
    expect(r.ok && JSON.stringify(r)).not.toMatch(/verify/i);
    const dev = await intake(deps, { source: 'portfolio', assetId: harborLight, email: 'd@cafe.example', text: T.PASTE }, { creator: false, sessionSlug: 'imani' });
    expect(dev.ok && JSON.stringify(dev)).not.toMatch(/verify/i);
  });
});

describe('auth, validation, rate limit', () => {
  it('paste and screenshot need the creator session', async () => {
    const r = await intake(deps, { source: 'paste', clientId: s.clientId, assetId: morningPour, text: T.PASTE }, { creator: false, sessionSlug: 'imani' });
    expect(r).toMatchObject({ ok: false, status: 401 });
  });

  it('paste needs the creator to pick client and asset (fix 11)', async () => {
    const r = await intake(deps, { source: 'paste', text: T.PASTE }, creator);
    expect(r).toMatchObject({ ok: false, status: 400 });
  });

  it('rejects a screenshot whose bytes are not the declared image type', async () => {
    const r = await intake(deps, { source: 'screenshot', clientId: s.clientId, assetId: morningPour, image: { mime: 'image/png', base64: Buffer.from('hello').toString('base64') } }, creator);
    expect(r).toMatchObject({ ok: false, status: 400 });
  });

  it('fixture names are ignored outside fixture mode', async () => {
    fixtureCalls.length = 0;
    const live = { ...deps, env: { AI_PROVIDER: 'gemini', NODE_ENV: 'test' } as NodeJS.ProcessEnv };
    await intake(live, { source: 'paste', clientId: s.clientId, assetId: harborLight, text: T.PASTE, fixture: 'billboard' }, creator);
    expect(fixtureCalls).toEqual([null]);
  });

  it(`allows ${RATE_LIMIT_PER_HOUR} intakes per creator per hour; the 21st is refused`, async () => {
    const later = { ...deps, now: () => new Date(Date.now() + 2 * 60 * 60 * 1000) }; // fresh window
    const req = { source: 'portfolio', assetId: harborLight, email: 'rate@cafe.example', text: T.PASTE };
    for (let i = 0; i < RATE_LIMIT_PER_HOUR; i++) {
      expect((await intake(later, req, { creator: false, sessionSlug: 'imani' })).ok).toBe(true);
    }
    expect(await intake(later, req, { creator: false, sessionSlug: 'imani' })).toMatchObject({ ok: false, status: 429 });
  });
});


describe('review fixtures (fix 18)', () => {
  // Own hour, so the earlier tests' intakes don't count against the 20/hour limit.
  const d = () => ({ ...deps, now: () => new Date(Date.now() + 5 * 60 * 60 * 1000) });
  it('"U.S. billboard" quote still matches; gap 90000 against v1', async () => {
    const r = await paste('us-billboard', T.US_BILLBOARD, { deps: d() });
    expect(r.extraction).toMatchObject({ status: 'ready', reasons: [] });
    const v = await view(r);
    expect(v.checks?.kept.map((k) => k.optionId)).toEqual(['billboard', 'US', '6mo']);
    expect(v.gapPreview).toMatchObject({ totalCents: 90000, newOptionIds: ['billboard'] });
  });

  it('"skip print" -> needs_creator negation', async () => {
    const r = await paste('skip-print', T.SKIP_PRINT, { deps: d() });
    expect(r.extraction).toMatchObject({ status: 'needs_creator', reasons: ['tripwire:print', 'negation'] });
  });

  it('bulleted scope list: each bullet is quotable; v1 priced', async () => {
    const r = await paste('bulleted', T.BULLETED, { assetId: harborLight, deps: d() });
    expect(r.extraction).toMatchObject({ status: 'ready', reasons: [] });
    const v = await view(r);
    // Paste lines: 0 "Here is what we need:", 1-3 the bullets.
    expect(v.checks?.kept.map((k) => [k.optionId, k.lineIndex])).toEqual([['social', 1], ['web', 2], ['US', 3], ['6mo', 3]]);
    expect(v.checks?.requested).toEqual({ channels: ['social', 'web'], territory: 'US', durationMonths: 6, exclusive: false });
    expect(v.gapPreview).toMatchObject({ against: 'empty', totalCents: 15000 + 10000 + 0 + 15000 });
  });

  it('"UK and Australia" with no WORLD use -> needs_creator tripwire', async () => {
    const r = await paste('uk-australia', T.UK_AUSTRALIA, { deps: d() });
    expect(r.extraction).toMatchObject({ status: 'needs_creator', reasons: ['tripwire:UK', 'tripwire:Australia'] });
  });
});
