// Smoke test against a running server: BASE=http://localhost:3101 CREATOR_TOKEN=... npx tsx scripts/smoke.ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const base = process.env.BASE ?? 'http://localhost:3101';
const origin = new URL(base).origin;
let cookie = '';
type R = { s: number; b: any; h: Headers };
async function call(method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<R> {
  const headers: Record<string, string> = { 'content-type': 'application/json', origin, ...(cookie ? { cookie } : {}), ...extra };
  const r = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
  const text = await r.text();
  let b: any = text;
  try { b = JSON.parse(text); } catch {}
  return { s: r.status, b, h: r.headers };
}
const log = (...a: unknown[]) => console.log(...a);

log('page /deals, no session ->', (await call('GET', '/deals')).s, (await call('GET', '/deals')).h.get('location'));
log('api /deals, no session ->', (await call('GET', '/api/deals')).s);
log('login wrong token ->', (await call('POST', '/api/login', { token: 'nope' })).s);
log('login foreign origin ->', (await call('POST', '/api/login', { token: process.env.CREATOR_TOKEN }, { origin: 'https://evil.example' })).s);
const login = await call('POST', '/api/login', { token: process.env.CREATOR_TOKEN });
const setCookie = login.h.get('set-cookie') ?? '';
log('login ->', login.s, '| cookie flags:', setCookie.split(';').slice(1).map((x) => x.trim().split('=')[0]).join(','));
cookie = setCookie.split(';')[0]!;

const opts = await call('GET', '/api/options');
const northwind = opts.b.clients[0].id;
const morning = opts.b.assets.find((a: any) => a.title === 'Morning Pour').id;
const png = readFileSync(join(process.cwd(), 'tests', 'fixtures', 'demo-dm.png')).toString('base64');
const shot = await call('POST', '/api/intake', { source: 'screenshot', clientId: northwind, assetId: morning, fixture: 'demo-dm', image: { mime: 'image/png', base64: png } });
const id = shot.b.briefId;
log('intake screenshot ->', shot.s, shot.b.state);
log('intake with cookie but evil origin ->', (await call('POST', '/api/intake', { source: 'paste' }, { origin: 'https://evil.example' })).s);
const draft = await call('GET', `/api/briefs/${id}`);
log('confirm ->', (await call('POST', `/api/briefs/${id}/transcript`, { lines: draft.b.transcript.lines })).b.extraction.status);

const deals = await call('GET', '/api/deals');
log('deals ->', deals.s, deals.b.deals.map((d: any) => `${d.status}:${d.gapTotalCents}`).join(' '));
const room = await call('GET', `/api/briefs/${id}`);
log('room -> licence v', room.b.licence.versionNo, '|', room.b.cardSource, '| total', room.b.gapPreview.totalCents);
log('PATCH bad quote ->', (await call('PATCH', `/api/briefs/${id}`, { uses: [{ optionId: 'TV', quote: 'Put it on TV please.' }] })).s);
log('PATCH evil origin ->', (await call('PATCH', `/api/briefs/${id}`, { assetId: morning }, { origin: 'https://evil.example' })).s);
const keepPrint = await call('PATCH', `/api/briefs/${id}`, { uses: room.b.checks.kept.filter((k: any) => k.optionId === 'print').map((k: any) => ({ optionId: k.optionId, quote: k.quote })) });
log('PATCH remove US ->', keepPrint.s, keepPrint.b.extraction.model, keepPrint.b.gapPreview.totalCents);
log('decide ->', JSON.stringify((await call('POST', `/api/briefs/${id}/decide`, { action: 'approve', typedTotalCents: 42000 })).b));
log('decide bad body ->', (await call('POST', `/api/briefs/${id}/decide`, { action: 'send' })).s);

const st = await call('GET', '/api/settings');
const { clients: _c, ...settings } = st.b;
log('settings GET ->', st.s, Object.keys(settings.rateCard).length, 'card keys');
log('settings PUT negative ->', (await call('PUT', '/api/settings', { ...settings, rateCard: { ...settings.rateCard, web: -5 } })).s);
log('settings PUT no origin ->', (await call('PUT', '/api/settings', settings, { origin: '' })).s);
const put = await call('PUT', '/api/settings', { ...settings, rateCard: { ...settings.rateCard, social: 16000 } });
log('settings PUT ok ->', put.s, put.b.rateCard.social);
log('frozen v2 total after card change ->', (await call('GET', `/api/briefs/${id}`)).b.gapPreview.totalCents);
await call('PUT', '/api/settings', settings);

for (const p of ['/deals', `/deals/${id}`, '/settings', '/ask', '/ledger', '/portfolio', '/login', '/dev/intake']) log('page', p, (await call('GET', p)).s);

const port = await call('POST', '/api/intake', { source: 'portfolio', assetId: opts.b.assets.find((a: any) => a.title === 'Harbor Light').id, email: 'smoke@cafe.example', text: 'Can we use the Harbor Light photo on our website?' });
log('public intake response mentions verify ->', /verify/i.test(JSON.stringify(port.b)));
const issued = await call('POST', `/api/briefs/${port.b.briefId}/verify-link`, {});
log('creator verify-link ->', issued.s, issued.b.email);
const vurl = issued.b.url as string;
const vget = await call('GET', vurl);
log('verify GET ->', vget.s, typeof vget.b === 'string' && vget.b.includes('method="post"') ? 'confirm form' : 'NO FORM');
log('verify POST evil origin ->', (await call('POST', vurl, undefined, { origin: 'https://evil.example', 'content-type': 'application/x-www-form-urlencoded' })).s);
const vpost = await call('POST', vurl, undefined, { 'content-type': 'application/x-www-form-urlencoded' });
log('verify POST ->', vpost.s, typeof vpost.b === 'string' && vpost.b.includes('Email confirmed') ? 'confirmed page' : vpost.b);
log('verify POST again ->', (await call('POST', vurl, undefined, { 'content-type': 'application/x-www-form-urlencoded' })).s);
const big = await fetch(base + '/api/intake', { method: 'POST', headers: { 'content-type': 'application/json', origin, cookie }, body: 'x'.repeat(9 * 1024 * 1024) });
log('intake 9 MB body ->', big.status);
log('/dev/briefs redirect ->', (await call('GET', `/dev/briefs/${id}`)).h.get('location'));
log('logout ->', (await call('POST', '/api/logout')).h.get('set-cookie')?.includes('Max-Age=0'));
