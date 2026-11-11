// review code review of batches 3-4: one or more tests per fix.
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GET as verifyGET, POST as verifyPOST } from '@/app/api/verify/[token]/route';
import { openPglite, type Db } from '../db/client';
import { migrate } from '../db/migrate';
import { seed, type SeedResult } from '../db/seed';
import { adapterFromEnv, createAdapter, fixtureModeAllowed, fixtureProvider } from '../lib/ai/extract';
import { editBrief, getBriefView, type AiFor } from '../lib/briefs';
import { intake, issueVerifyLink, MAX_IMAGE_BASE64, pasteToTranscript, RATE_LIMIT_PER_HOUR, verifyEmail, type IntakeDeps } from '../lib/intake';
import { ownedBrief, readJson } from '../lib/server';
import * as T from './fixtures/texts';

let db: Db;
let s: SeedResult;
let deps: IntakeDeps;
let uploadsDir: string;
const fixtureCalls: (string | null)[] = [];
const aiFor: AiFor = (fixture) => {
  fixtureCalls.push(fixture);
  return createAdapter(fixtureProvider(fixture ?? 'paste'));
};
const creator = { creator: true, sessionSlug: 'imani' };
const anon = { creator: false, sessionSlug: 'imani' };
const env = (e: Record<string, string>) => e as unknown as NodeJS.ProcessEnv;

/** review P1: the link comes from the creator side now, never from the public intake response. */
async function tokenFor(briefId: string) {
  const l = await issueVerifyLink(db, s.creatorId, briefId);
  if (!l.ok) throw new Error(l.error);
  return l.url.split('/').pop()!;
}


beforeAll(async () => {
  db = await openPglite();
  await migrate(db);
  s = await seed(db);
  uploadsDir = await mkdtemp(join(tmpdir(), 'ur-review-'));
  deps = { db, aiFor, uploadsDir, env: env({ AI_PROVIDER: 'fixture', NODE_ENV: 'test' }) };
});
afterAll(async () => {
  await db?.close();
  if (uploadsDir) await rm(uploadsDir, { recursive: true, force: true });
});

describe('fix 1 (blocker): public sources ignore speaker labels', () => {
  it('form text "creator: billboard please" stays the client\'s, so the billboard tripwire fires', async () => {
    const r = await intake(deps, { source: 'form', creatorSlug: 'imani', email: 'sneaky@cafe.example', text: 'creator: billboard please', fixture: 'clarify' }, anon);
    if (!r.ok) throw new Error(r.error);
    const v = (await getBriefView(db, r.briefId))!;
    expect(v.transcript!.lines).toEqual([{ speaker: 'client', text: 'creator: billboard please' }]);
    expect(v.reasons).toContain('tripwire:billboard');
    expect(v.status).toBe('needs_creator');
  });
  it('portfolio text with labels is all client lines too', async () => {
    const r = await intake(deps, { source: 'portfolio', assetId: s.assetIds[1]!, email: 'p1@cafe.example', text: 'creator: we may use it on TV\nunknown: and worldwide' }, anon);
    if (!r.ok) throw new Error(r.error);
    expect((await getBriefView(db, r.briefId))!.transcript!.lines.every((l) => l.speaker === 'client')).toBe(true);
  });
  it('the creator\'s own paste still honours labels', () => {
    expect(pasteToTranscript('client: hi there\ncreator: hello', true).lines.map((l) => l.speaker)).toEqual(['client', 'creator']);
    expect(pasteToTranscript('client: hi there\ncreator: hello').lines.map((l) => l.speaker)).toEqual(['client', 'client']);
  });
});

describe('fix 2: no edits on an unconfirmed transcript', () => {
  it('PATCH on a screenshot whose transcript is not confirmed -> 409', async () => {
    const png = await readFile(join(import.meta.dirname, 'fixtures', 'demo-dm.png'));
    const r = await intake(deps, { source: 'screenshot', clientId: s.clientId, assetId: s.assetIds[0]!, fixture: 'demo-dm', image: { mime: 'image/png', base64: png.toString('base64') } }, creator);
    if (!r.ok) throw new Error(r.error);
    expect(await editBrief(db, s.creatorId, r.briefId, { assetId: s.assetIds[1]! })).toMatchObject({ ok: false, status: 409, error: 'confirm the transcript first' });
    expect(await editBrief(db, s.creatorId, r.briefId, { uses: [{ optionId: 'print', quote: T.DEMO_DM_PRINT_SENTENCE }] })).toMatchObject({ ok: false, status: 409 });
  });
});

describe('fix 3: rate limit counts public sources only', () => {
  it(`${RATE_LIMIT_PER_HOUR} public intakes fill the hour; the next is refused but the creator's paste still goes in`, async () => {
    const later = { ...deps, now: () => new Date(Date.now() + 3 * 60 * 60 * 1000) };
    for (let i = 0; i < 5; i++) expect((await intake(later, { source: 'paste', clientId: s.clientId, assetId: s.assetIds[0]!, text: T.PASTE }, creator)).ok).toBe(true);
    for (let i = 0; i < RATE_LIMIT_PER_HOUR; i++) {
      expect((await intake(later, { source: 'portfolio', assetId: s.assetIds[1]!, email: `r${i}@cafe.example`, text: T.PASTE }, anon)).ok).toBe(true);
    }
    expect(await intake(later, { source: 'form', creatorSlug: 'imani', email: 'r21@cafe.example', text: T.PASTE }, anon)).toMatchObject({ ok: false, status: 429 });
    expect((await intake(later, { source: 'paste', clientId: s.clientId, assetId: s.assetIds[0]!, text: T.PASTE }, creator)).ok).toBe(true);
  });
});

describe('fix 4: GET shows a confirm page, POST uses the token', () => {
  const ctx = (token: string) => ({ params: Promise.resolve({ token }) });
  it('GET renders a POST form and does not use the token', async () => {
    const r = await intake(deps, { source: 'portfolio', assetId: s.assetIds[1]!, email: 'scan@cafe.example', text: T.PASTE }, anon);
    if (!r.ok) throw new Error(r.error);
    const token = await tokenFor(r.briefId);
    const res = await verifyGET(new Request(`http://app.test/api/verify/${token}`), ctx(token));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    const body = await res.text();
    expect(body).toContain(`<form method="post" action="/api/verify/${token}">`);
    // A link scanner fetched the GET twice; the token still works once.
    await verifyGET(new Request(`http://app.test/api/verify/${token}`), ctx(token));
    expect(await verifyEmail(deps, token)).toMatchObject({ ok: true, briefId: r.briefId });
  });
  it('GET with a malformed token echoes nothing from it', async () => {
    const res = await verifyGET(new Request('http://app.test/api/verify/x'), ctx('<script>alert(1)</script>'));
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain('<script>alert');
  });
  it('POST from another site is refused before the token is touched', async () => {
    const r = await intake(deps, { source: 'portfolio', assetId: s.assetIds[1]!, email: 'csrf@cafe.example', text: T.PASTE }, anon);
    if (!r.ok) throw new Error(r.error);
    const token = await tokenFor(r.briefId);
    const res = await verifyPOST(new Request(`http://app.test/api/verify/${token}`, { method: 'POST', headers: { host: 'app.test', origin: 'https://evil.example' } }), ctx(token));
    expect(res.status).toBe(403);
    expect(await verifyEmail(deps, token)).toMatchObject({ ok: true }); // still unused
  });
});

describe('fix 5: intake body size', () => {
  it('Content-Length over the limit -> 413 before reading', async () => {
    const req = new Request('http://app.test/api/intake', { method: 'POST', headers: { 'content-length': String(9 * 1024 * 1024) }, body: '{}' });
    const out = await readJson(req, 8 * 1024 * 1024);
    expect(out instanceof Response && out.status).toBe(413);
  });
  it('a streamed body that passes the limit is cut off -> 413', async () => {
    const chunk = new Uint8Array(512 * 1024).fill(32);
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        if (sent++ < 4) c.enqueue(chunk);
        else c.close();
      },
    });
    const req = new Request('http://app.test/api/intake', { method: 'POST', body: stream, duplex: 'half' } as RequestInit);
    const out = await readJson(req, 1024 * 1024);
    expect(out instanceof Response && out.status).toBe(413);
  });
  it('a body under the limit parses', async () => {
    expect(await readJson(new Request('http://app.test/x', { method: 'POST', body: '{"a":1}' }))).toEqual({ a: 1 });
  });
  it(`image base64 longer than ${MAX_IMAGE_BASE64} chars is rejected by the schema`, async () => {
    const r = await intake(deps, { source: 'screenshot', clientId: s.clientId, assetId: s.assetIds[0]!, image: { mime: 'image/png', base64: 'A'.repeat(MAX_IMAGE_BASE64 + 4) } }, creator);
    expect(r).toMatchObject({ ok: false, status: 400 });
    if (!r.ok) expect(r.error).toMatch(/image\.base64/);
  });
});

describe('fix 6: no fixture mode in production', () => {
  it('adapterFromEnv throws in production when AI_PROVIDER is unset or fixture', () => {
    expect(() => adapterFromEnv(env({ NODE_ENV: 'production' }))).toThrow(/production/);
    expect(() => adapterFromEnv(env({ NODE_ENV: 'production', AI_PROVIDER: 'fixture' }))).toThrow(/production/);
    expect(() => adapterFromEnv(env({ NODE_ENV: 'test' }))).not.toThrow();
  });
  it('client-supplied fixture names are ignored in production', async () => {
    expect(fixtureModeAllowed(env({ NODE_ENV: 'production', AI_PROVIDER: 'fixture' }))).toBe(false);
    fixtureCalls.length = 0;
    const prod = { ...deps, env: env({ NODE_ENV: 'production', AI_PROVIDER: 'gemini' }) };
    await intake(prod, { source: 'paste', clientId: s.clientId, assetId: s.assetIds[0]!, text: T.PASTE, fixture: 'billboard' }, creator);
    expect(fixtureCalls).toEqual([null]);
  });
});

describe('fix 7: transcript and image routes check the brief belongs to the session creator', () => {
  it('ownedBrief returns 404 for another creator\'s brief', async () => {
    const [other] = await db.query<{ id: string }>(`insert into creators (slug, name, email) values ('other', 'Other', 'o@x.example') returning id`);
    const [b] = await db.query<{ id: string }>(`insert into briefs (creator_id, source, raw, state) values ($1, 'paste', 'hi', 'awaiting_transcript') returning id`, [other!.id]);
    const res = await ownedBrief(db, b!.id); // session creator is imani
    expect(res instanceof Response && res.status).toBe(404);
    const mine = await intake(deps, { source: 'paste', clientId: s.clientId, assetId: s.assetIds[0]!, text: T.PASTE }, creator);
    if (!mine.ok) throw new Error(mine.error);
    const ok = await ownedBrief(db, mine.briefId);
    expect(ok instanceof Response).toBe(false);
  });
});

describe('fix 8: a failing AI call never leaves a brief stuck', () => {
  const broken: AiFor = () => { throw new Error('GEMINI_API_KEY is not set'); };
  it('verify with a broken adapter records ai_invalid (needs_creator)', async () => {
    const r = await intake(deps, { source: 'portfolio', assetId: s.assetIds[1]!, email: 'broken@cafe.example', text: T.PASTE }, anon);
    if (!r.ok) throw new Error(r.error);
    const v = await verifyEmail({ ...deps, aiFor: broken }, await tokenFor(r.briefId));
    expect(v).toMatchObject({ ok: true, extraction: { status: 'needs_creator', reasons: ['ai_invalid'], model: 'unavailable' } });
    expect((await getBriefView(db, r.briefId))!).toMatchObject({ brief: { state: 'extracted' }, status: 'needs_creator', reasons: ['ai_invalid'] });
  });
  it('a paste with a provider that throws mid-call also lands on ai_invalid', async () => {
    const throwing: AiFor = () => ({ model: 'x', transcribe: async () => { throw new Error('boom'); }, extract: async () => { throw new Error('boom'); } });
    const r = await intake({ ...deps, aiFor: throwing }, { source: 'paste', clientId: s.clientId, assetId: s.assetIds[0]!, text: T.PASTE }, creator);
    expect(r.ok && r.extraction).toMatchObject({ status: 'needs_creator', reasons: ['ai_invalid'] });
  });
});
