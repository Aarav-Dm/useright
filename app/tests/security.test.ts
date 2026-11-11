// review security review (docs/reviews/b345-review.md) as triaged by review: P1-P5. P6 lives in dashboard.test.ts.
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GET as briefGET } from '@/app/api/briefs/[id]/route';
import { GET as imageGET } from '@/app/api/briefs/[id]/image/route';
import { POST as verifyLinkPOST } from '@/app/api/briefs/[id]/verify-link/route';
import { GET as dealsGET } from '@/app/api/deals/route';
import { GET as optionsGET } from '@/app/api/options/route';
import { GET as settingsGET } from '@/app/api/settings/route';
import { GET as askGET } from '@/app/api/ask/route';
import { GET as ledgerGET } from '@/app/api/ledger/route';
import { POST as decidePOST } from '@/app/api/briefs/[id]/decide/route';
import { openPglite, type Db } from '../db/client';
import { migrate } from '../db/migrate';
import { seed, type SeedResult } from '../db/seed';
import { createAdapter, fixtureProvider } from '../lib/ai/extract';
import { clientIp } from '../lib/auth';
import { editBrief, getBriefView, loadBrief, type AiFor } from '../lib/briefs';
import { quoteSupports, runChecks } from '../lib/checks';
import { intake, IP_LIMIT_PER_HOUR, issueVerifyLink, verifyEmail, type IntakeDeps } from '../lib/intake';
import { describeReason } from '../lib/reasons';
import * as T from './fixtures/texts';

let db: Db;
let s: SeedResult;
let deps: IntakeDeps;
let uploadsDir: string;
const aiFor: AiFor = (fixture) => createAdapter(fixtureProvider(fixture ?? 'paste'));
const creator = { creator: true, sessionSlug: 'imani' };
const anon = (ip?: string) => ({ creator: false, sessionSlug: 'imani', ...(ip ? { ip } : {}) });

beforeAll(async () => {
  db = await openPglite();
  await migrate(db);
  s = await seed(db);
  uploadsDir = await mkdtemp(join(tmpdir(), 'ur-sec-'));
  deps = { db, aiFor, uploadsDir, env: { AI_PROVIDER: 'fixture', NODE_ENV: 'development' } as unknown as NodeJS.ProcessEnv };
});
afterAll(async () => {
  await db?.close();
  if (uploadsDir) await rm(uploadsDir, { recursive: true, force: true });
});

describe('P1: the verify link never goes to the public requester', () => {
  it('public intake response has no link in any env; the creator can issue one; new client stays allowed=false', async () => {
    for (const NODE_ENV of ['development', 'test', 'production']) {
      const d = { ...deps, env: { AI_PROVIDER: 'fixture', NODE_ENV } as unknown as NodeJS.ProcessEnv };
      const r = await intake(d, { source: 'portfolio', assetId: s.assetIds[1]!, email: `p1-${NODE_ENV}@cafe.example`, text: T.PASTE }, anon(`10.1.0.${NODE_ENV.length}`));
      expect(r.ok).toBe(true);
      expect(JSON.stringify(r)).not.toMatch(/verify|token/i);
    }
    const form = await intake(deps, { source: 'form', creatorSlug: 'imani', email: 'p1form@cafe.example', text: T.PASTE }, anon('10.1.1.1'));
    expect(form.ok && form.clientId).toBeNull();
    expect(JSON.stringify(form)).not.toMatch(/verify/i);

    const link = await issueVerifyLink(db, s.creatorId, form.ok ? form.briefId : '');
    expect(link).toMatchObject({ ok: true, email: 'p1form@cafe.example' });
    if (!link.ok) return;
    const v = await verifyEmail(deps, link.url.split('/').pop()!);
    expect(v.ok).toBe(true);
    const [c] = await db.query(`select allowed from clients where lower(email) = 'p1form@cafe.example'`);
    expect(c).toEqual({ allowed: false });
  });

  it('issuing a new link voids the older one; another creator gets 404; nothing pending gets 409', async () => {
    const r = await intake(deps, { source: 'portfolio', assetId: s.assetIds[1]!, email: 'rotate@cafe.example', text: T.PASTE }, anon('10.1.2.1'));
    if (!r.ok) throw new Error(r.error);
    const first = await issueVerifyLink(db, s.creatorId, r.briefId);
    const second = await issueVerifyLink(db, s.creatorId, r.briefId);
    if (!first.ok || !second.ok) throw new Error('issue failed');
    expect(await verifyEmail(deps, first.url.split('/').pop()!)).toMatchObject({ ok: false, status: 410 });
    expect(await verifyEmail(deps, second.url.split('/').pop()!)).toMatchObject({ ok: true });
    expect(await issueVerifyLink(db, s.creatorId, r.briefId)).toMatchObject({ ok: false, status: 409 });
    expect(await issueVerifyLink(db, '00000000-0000-4000-8000-000000000000', r.briefId)).toMatchObject({ ok: false, status: 404 });
  });
});

describe('P2 (blocker): the quote must support its option', () => {
  const t = { lines: [{ speaker: 'client' as const, text: 'We love the colours in this one. Please put it in our spring catalog.' }] };
  const v1 = { channels: ['social' as const], territory: 'US' as const, durationMonths: 6 as const, exclusive: false };
  it('"we love the colours" quoted for print -> quote_unrelated, dropped, needs_creator', () => {
    const r = runChecks({ transcript: t, extraction: { uses: [{ optionId: 'print', quote: 'We love the colours in this one.' }] }, current: v1 });
    expect(r.status).toBe('needs_creator');
    expect(r.reasons).toEqual(['quote_unrelated:print']);
    expect(r.dropped).toEqual([{ optionId: 'print', quote: 'We love the colours in this one.', reason: 'quote_unrelated:print' }]);
    expect(describeReason('quote_unrelated:print')).toBe('The AI listed "print" but the sentence it quoted does not mention it, so it was dropped.');
  });
  it('the same option with a sentence that names it is kept', () => {
    const r = runChecks({ transcript: t, extraction: { uses: [{ optionId: 'print', quote: 'Please put it in our spring catalog.' }] }, current: v1 });
    expect(r).toMatchObject({ status: 'ready', reasons: [] });
  });
  it.each([
    ['social', 'We will share it in an Instagram reel.'], ['web', 'It goes on our landing page.'], ['OOH', 'Subway ads in the fall.'],
    ['TV', 'A short commercial spot.'], ['NA', 'Stores in Mexico as well.'], ['WORLD', 'Our APAC team wants it.'],
    ['12mo', 'An annual licence please.'], ['exclusive', 'We need exclusivity on this one.'], ['billboard', 'Two billboards downtown.'],
  ])('%s anchored by "%s"', (id, sentence) => {
    expect(quoteSupports(id, sentence.toLowerCase())).toBe(true);
    expect(quoteSupports(id, 'we love the colours')).toBe(false);
  });
  it('US and 6mo need no anchor', () => {
    expect(quoteSupports('US', 'we love the colours')).toBe(true);
    expect(quoteSupports('6mo', 'we love the colours')).toBe(true);
  });
  it('a creator edit that pairs an option with an unrelated sentence is rejected', async () => {
    const id = (await intake(deps, { source: 'paste', clientId: s.clientId, assetId: s.assetIds[0]!, text: T.PASTE }, creator));
    if (!id.ok) throw new Error(id.error);
    const r = await editBrief(db, s.creatorId, id.briefId, { uses: [{ optionId: 'print', quote: "We'd like to license the Harbor Light photo for our social media in the US for six months." }] });
    expect(r).toMatchObject({ ok: false, status: 400 });
  });
});

describe('P3: uploads', () => {
  it('stored as <briefId>.<ext> under the uploads dir (not public/, never a client name); magic bytes and 5 MB still checked', async () => {
    const png = await readFile(join(import.meta.dirname, 'fixtures', 'demo-dm.png'));
    const r = await intake(deps, { source: 'screenshot', clientId: s.clientId, assetId: s.assetIds[0]!, fixture: 'demo-dm', image: { mime: 'image/png', base64: png.toString('base64') } }, creator);
    if (!r.ok) throw new Error(r.error);
    const brief = (await loadBrief(db, r.briefId))!;
    expect(brief.upload_path).toBe(join(uploadsDir, `${r.briefId}.png`));
    const publicDir = join(process.cwd(), 'public');
    expect(brief.upload_path!.toLowerCase().startsWith(publicDir.toLowerCase())).toBe(false);
    expect(await readdir(uploadsDir)).toContain(`${r.briefId}.png`);
    expect((await getBriefView(db, r.briefId))!.brief).not.toHaveProperty('upload_path');
    const fake = await intake(deps, { source: 'screenshot', clientId: s.clientId, assetId: s.assetIds[0]!, image: { mime: 'image/png', base64: Buffer.from('GIF89a not a png').toString('base64') } }, creator);
    expect(fake).toMatchObject({ ok: false, status: 400 });
    const big = Buffer.alloc(5 * 1024 * 1024 + 1);
    png.copy(big);
    expect(await intake(deps, { source: 'screenshot', clientId: s.clientId, assetId: s.assetIds[0]!, image: { mime: 'image/png', base64: big.toString('base64') } }, creator))
      .toMatchObject({ ok: false, status: 400 });
  });
});

describe('P4: 5 public intakes per hour per IP', () => {
  it(`the ${IP_LIMIT_PER_HOUR + 1}th from one address is refused; another address and the creator still get in`, async () => {
    const later = { ...deps, now: () => new Date(Date.now() + 6 * 60 * 60 * 1000) };
    const req = (i: number) => ({ source: 'portfolio', assetId: s.assetIds[1]!, email: `ip${i}@cafe.example`, text: T.PASTE });
    for (let i = 0; i < IP_LIMIT_PER_HOUR; i++) expect((await intake(later, req(i), anon('203.0.113.7'))).ok).toBe(true);
    expect(await intake(later, req(99), anon('203.0.113.7'))).toMatchObject({ ok: false, status: 429 });
    expect(await intake(later, { source: 'form', creatorSlug: 'imani', email: 'ipf@cafe.example', text: T.PASTE }, anon('203.0.113.7'))).toMatchObject({ ok: false, status: 429 });
    expect((await intake(later, req(100), anon('198.51.100.2'))).ok).toBe(true);
    expect((await intake(later, { source: 'paste', clientId: s.clientId, assetId: s.assetIds[0]!, text: T.PASTE }, { ...creator, ip: '203.0.113.7' })).ok).toBe(true);
    const events = await db.query<{ detail: Record<string, unknown> }>(`select detail from events where kind = 'intake.created' and detail ? 'ipHash' limit 1`);
    expect(JSON.stringify(events)).not.toContain('203.0.113.7'); // only the hash is stored
  });
  it('clientIp takes the first X-Forwarded-For hop, else X-Real-IP, else "unknown"', () => {
    expect(clientIp(new Headers({ 'x-forwarded-for': '203.0.113.7, 10.0.0.1' }))).toBe('203.0.113.7');
    expect(clientIp(new Headers({ 'x-real-ip': '2001:db8::1' }))).toBe('2001:db8::1');
    expect(clientIp(new Headers({ 'x-forwarded-for': '<script>' }))).toBe('unknown');
    expect(clientIp(new Headers())).toBe('unknown');
  });
});

describe('P5: every creator GET goes through requireCreator', () => {
  const ctx = { params: Promise.resolve({ id: '00000000-0000-4000-8000-000000000000' }) };
  const get = (path: string) => new Request(`http://app.test${path}`);
  it.each([
    ['GET /api/briefs/:id', () => briefGET(get('/api/briefs/x'), ctx)],
    ['GET /api/briefs/:id/image', () => imageGET(get('/api/briefs/x/image'), ctx)],
    ['GET /api/deals', () => dealsGET(get('/api/deals'))],
    ['GET /api/settings', () => settingsGET(get('/api/settings'))],
    ['GET /api/options', () => optionsGET(get('/api/options'))],
    ['POST /api/briefs/:id/verify-link', () => verifyLinkPOST(new Request('http://app.test/x', { method: 'POST' }), ctx)],
    ['GET /api/ask', () => askGET(get('/api/ask'))],
    ['GET /api/ledger', () => ledgerGET(get('/api/ledger'))],
    ['POST /api/briefs/:id/decide', () => decidePOST(new Request('http://app.test/x', { method: 'POST' }), ctx)],
  ])('%s without a session -> 401', async (_name, call) => {
    expect((await call()).status).toBe(401);
  });
});
