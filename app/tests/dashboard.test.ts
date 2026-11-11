import { readFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openPglite, type Db } from '../db/client';
import { migrate } from '../db/migrate';
import { seed, type SeedResult } from '../db/seed';
import { createAdapter, fixtureProvider } from '../lib/ai/extract';
import { requireCreator, sameOrigin, sessionCookie } from '../lib/auth';
import { confirmTranscript, decideStub, editBrief, getBriefView, type AiFor } from '../lib/briefs';
import { listDeals } from '../lib/deals';
import { intake, type IntakeDeps } from '../lib/intake';
import { describeReason, REASON_SENTENCES } from '../lib/reasons';
import { runChecks } from '../lib/checks';
import type { Scope } from '../lib/pricing';
import { getSettings, putSettings, type Settings } from '../lib/settings';
import * as T from './fixtures/texts';

let db: Db;
let s: SeedResult;
let deps: IntakeDeps;
let uploadsDir: string;
let morningPour: string;
let harborLight: string;
const aiFor: AiFor = (fixture) => createAdapter(fixtureProvider(fixture ?? 'paste'));
const creator = { creator: true, sessionSlug: 'imani' };
const ids: Record<string, string> = {};

async function paste(fixture: string, text: string, assetId: string, clientId?: string) {
  const r = await intake(deps, { source: 'paste', clientId: clientId ?? s.clientId, assetId, text, fixture }, creator);
  if (!r.ok) throw new Error(r.error);
  return r.briefId;
}

beforeAll(async () => {
  db = await openPglite();
  await migrate(db);
  s = await seed(db);
  [morningPour, harborLight] = s.assetIds as [string, string];
  uploadsDir = await mkdtemp(join(tmpdir(), 'ur-b4-'));
  deps = { db, aiFor, uploadsDir, env: { AI_PROVIDER: 'fixture', NODE_ENV: 'test' } as NodeJS.ProcessEnv };

  // Demo DM: screenshot -> confirm -> ready, v2 against Northwind's v1.
  const png = await readFile(join(import.meta.dirname, 'fixtures', 'demo-dm.png'));
  const shot = await intake(deps, { source: 'screenshot', clientId: s.clientId, assetId: morningPour, fixture: 'demo-dm', image: { mime: 'image/png', base64: png.toString('base64') } }, creator);
  if (!shot.ok) throw new Error(shot.error);
  await confirmTranscript(db, aiFor, shot.briefId, T.DEMO_DM);
  ids.demo = shot.briefId;
  // A screenshot left unconfirmed.
  const draft = await intake(deps, { source: 'screenshot', clientId: s.clientId, assetId: morningPour, fixture: 'demo-dm', image: { mime: 'image/png', base64: png.toString('base64') } }, creator);
  if (!draft.ok) throw new Error(draft.error);
  ids.draft = draft.briefId;
  ids.paste = await paste('paste', T.PASTE, harborLight); // ready v1 30000
  ids.negation = await paste('negation', T.NEGATION, morningPour); // needs_creator, nothing priced
  ids.clarify = await paste('clarify', T.CLARIFY, morningPour);
  ids.unknown = await paste('unknown-sender', T.UNKNOWN_SENDER, morningPour, 'unknown');
  const port = await intake(deps, { source: 'portfolio', assetId: harborLight, email: 'new@cafe.example', text: T.PASTE }, { creator: false, sessionSlug: 'imani' });
  if (!port.ok) throw new Error(port.error);
  ids.portfolio = port.briefId;
});
afterAll(async () => {
  await db?.close();
  if (uploadsDir) await rm(uploadsDir, { recursive: true, force: true });
});

describe('deals list (§2, fix 1)', () => {
  it('one row per brief, newest first, with status and gap total', async () => {
    const deals = await listDeals(db, s.creatorId);
    expect(deals).toHaveLength(7);
    expect(deals.map((d) => d.briefId)).toEqual([ids.portfolio, ids.unknown, ids.clarify, ids.negation, ids.paste, ids.draft, ids.demo]);
    const by = Object.fromEntries(deals.map((d) => [d.briefId, d]));
    expect(by[ids.demo!]).toMatchObject({ status: 'ready', gapTotalCents: 42000, client: { name: 'Northwind Coffee' }, asset: { title: 'Morning Pour' }, source: 'screenshot' });
    expect(by[ids.draft!]).toMatchObject({ status: 'awaiting_transcript', gapTotalCents: null });
    expect(by[ids.paste!]).toMatchObject({ status: 'ready', gapTotalCents: 30000 });
    expect(by[ids.negation!]).toMatchObject({ status: 'needs_creator' });
    expect(by[ids.clarify!]).toMatchObject({ status: 'clarify', gapTotalCents: null });
    expect(by[ids.unknown!]).toMatchObject({ status: 'needs_creator', client: null });
    expect(by[ids.portfolio!]).toMatchObject({ status: 'awaiting_verification', gapTotalCents: null, client: null });
  });
});

describe('deal room data (§3)', () => {
  it('demo DM: print sentence highlighted, licence card, frozen card source, total 42000', async () => {
    const v = (await getBriefView(db, ids.demo!))!;
    const print = v.checks!.kept.find((k) => k.optionId === 'print')!;
    expect(v.transcript!.lines[print.lineIndex]!.text).toContain(T.DEMO_DM_PRINT_SENTENCE);
    expect(v.licence).toMatchObject({ versionId: s.v1Id, versionNo: 1, paidCents: 30000, scope: { channels: ['social'] } });
    expect(v.cardSource).toBe('rate card (frozen v1)');
    expect(v.gapPreview!.lines.reduce((a, l) => a + l.cents, 0)).toBe(42000);
    expect(v.gapPreview!.lines.at(-1)).toEqual({ optionId: 'credit:paid', cents: -30000 });
  });
  it('model price is shown but never in the total', async () => {
    const id = await paste('suggests-price', T.SUGGESTS_PRICE, harborLight);
    const v = (await getBriefView(db, id))!;
    expect(v.extraction!.suggested_price_cents).toBe(5000);
    expect(v.cardSource).toBe('rate card (current)');
    expect(v.gapPreview!.totalCents).toBe(25000);
  });
});

const validSettings = async (): Promise<Settings> => {
  const { clients: _c, ...rest } = await getSettings(db, s.creatorId);
  return rest;
};

describe('frozen card vs current card (§5)', () => {
  it('a rate card change leaves the v2 preview alone and moves the v1 preview', async () => {
    const before = await validSettings();
    const r = await putSettings(db, s.creatorId, { ...before, rateCard: { ...before.rateCard, print: 99000, social: 20000 } });
    expect(r.ok).toBe(true);
    expect((await getBriefView(db, ids.demo!))!.gapPreview!.totalCents).toBe(42000); // frozen v1 card
    expect((await getBriefView(db, ids.paste!))!.gapPreview!.totalCents).toBe(35000); // 20000 + 0 + 15000
    const [v1] = await db.query<{ rate_card: { print: number } }>(`select rate_card from licence_versions where id = $1`, [s.v1Id]);
    expect(v1!.rate_card.print).toBe(42000);
    await putSettings(db, s.creatorId, before); // restore for later tests
  });
});

describe('creator edits (fix 2)', () => {
  it('adding an option without a valid client sentence is rejected', async () => {
    const r = await editBrief(db, s.creatorId, ids.demo!, { uses: [{ optionId: 'TV', quote: 'Put it on TV please.' }] });
    expect(r).toMatchObject({ ok: false, status: 400 });
    const half = await editBrief(db, s.creatorId, ids.demo!, { uses: [{ optionId: 'web', quote: 'printed menus and in-store posters' }] });
    expect(half).toMatchObject({ ok: false, status: 400 });
    const unknown = await editBrief(db, s.creatorId, ids.demo!, { uses: [{ optionId: 'radio', quote: T.DEMO_DM_PRINT_SENTENCE }] });
    expect(unknown).toMatchObject({ ok: false, status: 400 });
  });
  it('removing a use writes a creator_edit extraction and re-runs checks with no AI call', async () => {
    const r = await editBrief(db, s.creatorId, ids.demo!, { uses: [{ optionId: 'print', quote: T.DEMO_DM_PRINT_SENTENCE }] });
    if (!r.ok) throw new Error(r.error);
    expect(r.view.extraction).toMatchObject({ model: 'creator_edit', status: 'ready' });
    expect(r.view.checks!.kept.map((k) => k.optionId)).toEqual(['print']);
    expect(r.view.gapPreview!.totalCents).toBe(42000); // US carried over from v1
  });
  it('changing the asset re-runs the preview against that asset (no licence -> v1 needs a duration)', async () => {
    const r = await editBrief(db, s.creatorId, ids.demo!, { assetId: harborLight });
    if (!r.ok) throw new Error(r.error);
    expect(r.view.licence).toBeNull();
    // Only "print" is kept (previous test), so a v1 on this asset has no territory or duration and nothing
    // can be priced. A photo-only PATCH is not a review of the text, so the print/poster tripwires still block.
    expect(r.view.checks).toMatchObject({
      status: 'needs_creator',
      reasons: ['scope_unstated:territory', 'scope_unstated:duration', 'tripwire:print', 'tripwire:poster'],
    });
    expect(r.view.notes).toEqual([]);
    expect(r.view.gapPreview).toBeNull();
    const back = await editBrief(db, s.creatorId, ids.demo!, { assetId: morningPour });
    expect(back.ok && back.view.gapPreview?.totalCents).toBe(42000);
  });
  it('setting the client on an unknown-sender brief clears unknown_sender', async () => {
    const r = await editBrief(db, s.creatorId, ids.unknown!, { clientId: s.clientId });
    if (!r.ok) throw new Error(r.error);
    expect(r.view.client?.name).toBe('Northwind Coffee');
    expect(r.view.checks!.reasons).not.toContain('unknown_sender');
  });
  it('briefs awaiting verification or of another creator cannot be edited', async () => {
    expect(await editBrief(db, s.creatorId, ids.portfolio!, { assetId: harborLight })).toMatchObject({ ok: false, status: 409 });
    expect(await editBrief(db, '00000000-0000-0000-0000-000000000000', ids.demo!, { assetId: harborLight })).toMatchObject({ ok: false, status: 404 });
  });
});

describe('decide stub (fix 3)', () => {
  it('records an events row and nothing else', async () => {
    const before = await db.query<{ n: number }>(`select count(*)::int as n from licence_versions`);
    const ev = await decideStub(db, s.creatorId, ids.negation!, 'approve', 4200);
    expect(ev).not.toBeNull();
    const [row] = await db.query<{ kind: string; detail: unknown }>(`select kind, detail from events where id = $1`, [ev!.id]);
    expect(row).toEqual({ kind: 'decide_stub', detail: { briefId: ids.negation, action: 'approve', typedTotalCents: 4200 } });
    expect(await db.query(`select count(*)::int as n from licence_versions`)).toEqual(before);
  });
});

describe('settings PUT validation (fix 4)', () => {
  const bad = async (patch: (s: Settings) => unknown) => putSettings(db, s.creatorId, patch(await validSettings()));
  it.each([
    ['negative cents', (x: Settings) => ({ ...x, rateCard: { ...x.rateCard, web: -1 } })],
    ['non-integer cents', (x: Settings) => ({ ...x, rateCard: { ...x.rateCard, web: 10.5 } })],
    ['missing rate card key', (x: Settings) => { const { TV: _t, ...rc } = x.rateCard; return { ...x, rateCard: rc }; }],
    ['extra rate card key', (x: Settings) => ({ ...x, rateCard: { ...x.rateCard, radio: 100 } })],
    ['unknown channel', (x: Settings) => ({ ...x, autoChannels: [...x.autoChannels, 'radio'] })],
    ['channel in both lists', (x: Settings) => ({ ...x, askChannels: [...x.askChannels, 'social'] })],
    ['bad time zone', (x: Settings) => ({ ...x, timezone: 'Mars/Olympus' })],
    ['negative cap', (x: Settings) => ({ ...x, perDealCapCents: -100 })],
    ['unknown client id', (x: Settings) => ({ ...x, allowedClientIds: ['00000000-0000-4000-8000-000000000000'] })],
  ])('rejects %s', async (_name, patch) => {
    expect(await bad(patch)).toMatchObject({ ok: false, status: 400 });
  });
  it('accepts a valid body and toggles clients.allowed', async () => {
    const x = await validSettings();
    const r = await putSettings(db, s.creatorId, { ...x, allowedClientIds: [], timezone: 'Europe/London' });
    expect(r.ok && r.settings).toMatchObject({ allowedClientIds: [], timezone: 'Europe/London' });
    const [c] = await db.query(`select allowed from clients where id = $1`, [s.clientId]);
    expect(c).toEqual({ allowed: false });
    await putSettings(db, s.creatorId, x);
  });
});

describe('reason sentences (§5, fix 6)', () => {
  it('every reason prefix emitted in lib/ has a sentence', async () => {
    const src = (await Promise.all(['checks.ts', 'briefs.ts', 'intake.ts'].map((f) => readFile(join(import.meta.dirname, '..', 'lib', f), 'utf8')))).join('\n');
    const emitted = new Set<string>();
    for (const m of src.matchAll(/(?:add|push)\(\s*[`']([a-z_]+)(?::|[`'])/g)) emitted.add(m[1]!);
    for (const line of src.split('\n').filter((l) => /\breasons\b/.test(l))) {
      // Array literals only; `Foo['bar']` is a type index, not a reason.
      for (const m of line.matchAll(/(?<![\w\]])\[\s*'([a-z_]+)'/g)) emitted.add(m[1]!);
    }
    for (const m of src.matchAll(/reason:\s*`([a-z_]+):/g)) emitted.add(m[1]!);
    // Batch 5 adds policy/send codes (emitted from policy.ts and the version state); every emitted one needs a sentence.
    const keys = Object.keys(REASON_SENTENCES);
    expect([...emitted].filter((c) => !keys.includes(c))).toEqual([]);
    for (const k of ['tripwire', 'negation', 'quote_missing', 'unknown_sender', 'ai_invalid', 'scope_unstated', 'clarify']) expect(emitted.has(k)).toBe(true);
  });
  it('every reason stored by the fixture runs reads as a sentence', async () => {
    const rows = await db.query<{ reasons: string[] }>(`select reasons from extractions`);
    const codes = [...new Set(rows.flatMap((r) => r.reasons))];
    expect(codes.length).toBeGreaterThan(3);
    for (const code of codes) expect(describeReason(code)).not.toMatch(/^Unrecognised/);
  });
  it('fills the suffix', () => {
    expect(describeReason('tripwire:billboard')).toBe('The client mentioned "billboard", but no requested use covers it.');
    expect(describeReason('scope_unstated:duration')).toBe('This is a first licence and the client did not say the duration.');
    expect(describeReason('clarify:no_channel')).toMatch(/no channel/);
    expect(describeReason('made_up')).toBe('Unrecognised check: made_up');
  });
});

describe('auth + CSRF (fix 5)', () => {
  const env = { CREATOR_TOKEN: 'tok-123', NODE_ENV: 'test' } as NodeJS.ProcessEnv;
  const req = (method: string, headers: Record<string, string>) => new Request('http://app.test/api/settings', { method, headers });
  it('no session -> 401; cookie or bearer -> ok on GET', () => {
    expect(requireCreator(req('GET', {}), env)).toMatchObject({ ok: false, status: 401 });
    expect(requireCreator(req('GET', { cookie: 'ur_creator=wrong' }), env)).toMatchObject({ ok: false, status: 401 });
    expect(requireCreator(req('GET', { cookie: 'a=1; ur_creator=tok-123' }), env)).toMatchObject({ ok: true });
    expect(requireCreator(req('GET', { authorization: 'Bearer tok-123' }), env)).toMatchObject({ ok: true });
  });
  it('mutation with a valid cookie but foreign or missing Origin -> 403', () => {
    const cookie = 'ur_creator=tok-123';
    expect(requireCreator(req('PUT', { cookie, host: 'app.test', origin: 'https://evil.example' }), env)).toMatchObject({ ok: false, status: 403 });
    expect(requireCreator(req('POST', { cookie, host: 'app.test' }), env)).toMatchObject({ ok: false, status: 403 });
    expect(requireCreator(req('POST', { cookie, host: 'app.test', origin: 'null' }), env)).toMatchObject({ ok: false, status: 403 });
    expect(requireCreator(req('PATCH', { cookie, host: 'app.test', origin: 'http://app.test' }), env)).toMatchObject({ ok: true });
    // review P5: Referer is not trusted; a mutation without Origin is refused.
    expect(requireCreator(req('POST', { cookie, host: 'app.test', referer: 'http://app.test/deals' }), env)).toMatchObject({ ok: false, status: 403 });
  });
  it('with APP_ORIGIN set, Origin must equal it; Host is not consulted', () => {
    const prod = { ...env, APP_ORIGIN: 'https://useright.example' } as NodeJS.ProcessEnv;
    const cookie = 'ur_creator=tok-123';
    expect(requireCreator(req('POST', { cookie, host: 'useright.example', origin: 'https://useright.example' }), prod)).toMatchObject({ ok: true });
    // A spoofed Host that matches a foreign Origin no longer passes.
    expect(requireCreator(req('POST', { cookie, host: 'evil.example', origin: 'https://evil.example' }), prod)).toMatchObject({ ok: false, status: 403 });
    expect(requireCreator(req('POST', { cookie, host: 'useright.example', origin: 'http://useright.example' }), prod)).toMatchObject({ ok: false, status: 403 });
  });
  it('no CREATOR_TOKEN configured -> nobody is the creator', () => {
    expect(requireCreator(req('GET', { authorization: 'Bearer ' }), { NODE_ENV: 'test' } as NodeJS.ProcessEnv)).toMatchObject({ ok: false, status: 401 });
    expect(sameOrigin(req('GET', {}))).toBe(true);
  });
  it('session cookie is HttpOnly and SameSite=Strict', () => {
    expect(sessionCookie('tok-123', true)).toMatch(/^ur_creator=tok-123; Path=\/; HttpOnly; SameSite=Strict; Max-Age=\d+; Secure$/);
  });
});


describe('creator edits clear tripwires (review fix, review)', () => {
  it('billboard deal: the creator removes the billboard use -> ready, billboard tripwire becomes a note', async () => {
    const id = await paste('billboard-and-web', T.BILLBOARD_AND_WEB, morningPour);
    const before = (await getBriefView(db, id))!;
    expect(before).toMatchObject({ status: 'ready', notes: [] });
    expect(before.checks!.kept.map((k) => k.optionId)).toEqual(['web', 'billboard']);

    // The same use list run as an AI extraction would block on the uncovered billboard word.
    const transcript = before.transcript!;
    expect(runChecks({ transcript, extraction: { uses: [{ optionId: 'web', quote: 'Please add our website as well.' }] }, current: before.licence!.scope }))
      .toMatchObject({ status: 'needs_creator', reasons: ['tripwire:billboard'] });

    const r = await editBrief(db, s.creatorId, id, { uses: [{ optionId: 'web', quote: 'Please add our website as well.' }] });
    if (!r.ok) throw new Error(r.error);
    expect(r.view).toMatchObject({ status: 'ready', reasons: [], notes: ['tripwire:billboard'] });
    expect(r.view.extraction!.model).toBe('creator_edit');
    expect(r.view.gapPreview).toMatchObject({ newOptionIds: ['web'], totalCents: 10000 });
    expect((await listDeals(db, s.creatorId)).find((d) => d.briefId === id)).toMatchObject({ status: 'ready', reasons: [], gapTotalCents: 10000 });
  });

  it('a deal the AI stopped on a tripwire becomes ready once the creator confirms the uses', async () => {
    const id = await paste('tripwire-miss', T.TRIPWIRE_MISS, morningPour);
    expect((await getBriefView(db, id))!).toMatchObject({ status: 'needs_creator', reasons: ['tripwire:worldwide'] });
    const r = await editBrief(db, s.creatorId, id, { uses: [{ optionId: 'web', quote: 'Please add the photo to our website too.' }] });
    expect(r.ok && r.view).toMatchObject({ status: 'ready', reasons: [], notes: ['tripwire:worldwide'] });
  });

  it('negation becomes a note after a creator edit', async () => {
    const id = await paste('negation', T.NEGATION, morningPour);
    expect((await getBriefView(db, id))!.reasons).toEqual(['tripwire:print', 'negation']);
    const r = await editBrief(db, s.creatorId, id, { uses: [{ optionId: 'web', quote: 'Please add web use for our site.' }] });
    expect(r.ok && r.view).toMatchObject({ status: 'ready', reasons: [], notes: ['tripwire:print', 'negation'] });
  });

  it('quote_missing, unknown_option and scope_unstated still block a reviewed run', () => {
    const t = { lines: [{ speaker: 'client' as const, text: 'We want the photo on our website.' }] };
    const run = (uses: { optionId: string; quote: string }[], current: Scope | null) =>
      runChecks({ transcript: t, extraction: { uses }, current, reviewedByCreator: true });
    const v1 = { channels: ['social'], territory: 'US', durationMonths: 6, exclusive: false } as Scope;
    expect(run([{ optionId: 'web', quote: 'We want the photo in print ads.' }], v1).reasons).toEqual(['quote_missing:web']);
    expect(run([{ optionId: 'radio', quote: 'We want the photo on our website.' }], v1).reasons).toEqual(['unknown_option:radio']);
    expect(run([{ optionId: 'web', quote: 'We want the photo on our website.' }], null).reasons).toEqual(['scope_unstated:territory', 'scope_unstated:duration']);
  });

  it('an AI extraction (not a creator edit) still blocks on tripwires and negation', async () => {
    const id = await paste('negation', T.NEGATION, morningPour);
    expect((await getBriefView(db, id))!).toMatchObject({ status: 'needs_creator', notes: [] });
  });
});

describe('only a PATCH that sends uses counts as review (review ruling on review fix)', () => {
  it('client-only and photo-only PATCHes keep the tripwire blocking; sending uses clears it', async () => {
    const id = await paste('tripwire-miss', T.TRIPWIRE_MISS, morningPour);
    expect((await getBriefView(db, id))!).toMatchObject({ status: 'needs_creator', reasons: ['tripwire:worldwide'] });

    const clientOnly = await editBrief(db, s.creatorId, id, { clientId: s.clientId });
    expect(clientOnly.ok && clientOnly.view).toMatchObject({ status: 'needs_creator', reasons: ['tripwire:worldwide'], notes: [] });
    expect(clientOnly.ok && clientOnly.view.extraction!.model).toBe('creator_edit');

    const photoOnly = await editBrief(db, s.creatorId, id, { assetId: morningPour });
    expect(photoOnly.ok && photoOnly.view).toMatchObject({ status: 'needs_creator', reasons: ['tripwire:worldwide'], notes: [] });

    const withUses = await editBrief(db, s.creatorId, id, { uses: [{ optionId: 'web', quote: 'Please add the photo to our website too.' }] });
    expect(withUses.ok && withUses.view).toMatchObject({ status: 'ready', reasons: [], notes: ['tripwire:worldwide'] });
  });
});
