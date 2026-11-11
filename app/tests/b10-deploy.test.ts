// B10 10.1 and 10.4: the deploy config and the tick wiring, checked without an account. Nothing here shows the real host
// accepts them; README.md lists that run.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { POST as tickPOST } from '@/app/api/cron/tick/route';
import { GET as healthGET } from '@/app/healthz/route';
import { openPglite, type Db } from '../db/client';
import { initialize } from '../db/init';
import { setRouteDepsForTests } from '../lib/server';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { mockInvoiceApi } from './helpers/mock-paypal';

const repo = join(process.cwd(), '..');
const render = readFileSync(join(repo, 'render.yaml'), 'utf8');
const workflow = readFileSync(join(repo, '.github/workflows/daily-tick.yml'), 'utf8');
const keysDoc = readFileSync(join(repo, 'README.md'), 'utf8');

const SECRET_NAMES = ['GEMINI_API_KEY', 'DATABASE_URL', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'MY_CLIENT_ID', 'MY_PAYPAL_SECRET', 'PAYPAL_WEBHOOK_ID', 'APP_SECRET', 'CREATOR_TOKEN', 'CRON_SECRET'];

describe('render.yaml', () => {
  const entries = [...render.matchAll(/- key: (\w+)\r?\n\s+(sync: false|value: [^\r\n]+)/g)].map((m) => ({ key: m[1]!, how: m[2]! }));

  it('asks for every secret by name and commits no value', () => {
    for (const name of SECRET_NAMES) expect(entries.find((e) => e.key === name)?.how, name).toBe('sync: false');
    for (const name of ['PUBLIC_BASE_URL', 'APP_ORIGIN']) expect(entries.find((e) => e.key === name)?.how, name).toBe('sync: false');
    expect(entries.filter((e) => e.how !== 'sync: false').map((e) => e.key).sort()).toEqual(['AI_PROVIDER', 'DEMO_MODE', 'NODE_VERSION']);
  });

  it('runs the app from app/, with the health check and a real model', () => {
    expect(render).toContain('rootDir: app');
    expect(render).toContain('healthCheckPath: /healthz');
    expect(render).toContain('--include=dev');
    expect(entries.find((e) => e.key === 'AI_PROVIDER')?.how).toBe('value: gemini');
  });

  it('deploys from the default branch, where the scheduled workflow must also live', () => {
    expect(render).not.toMatch(/^\s*branch:/m); // the Blueprint's connected branch, which KEYS-NEEDED says is the default one
    expect(render).toContain('default branch');
    expect(keysDoc).not.toContain('batch-8');
    expect(keysDoc).toMatch(/default branch/);
    expect(keysDoc).toMatch(/GitHub runs a schedule only from the default branch/);
    expect(keysDoc).toMatch(/Run workflow[^\n]*hosted URL[^\n]*green/i);
  });

  it('the acceptance run probes a real object anonymously', () => {
    expect(keysDoc).toMatch(/\/storage\/v1\/object\/public\/useright-private\//);
    expect(keysDoc).toMatch(/anonymous/i);
  });

  it('every name in it is listed in README.md', () => {
    for (const name of [...SECRET_NAMES, 'PUBLIC_BASE_URL', 'APP_ORIGIN']) expect(keysDoc, name).toContain(name);
  });
});

describe('daily tick', () => {
  it('the workflow posts with the secret header and holds no value', () => {
    expect(workflow).toMatch(/-X POST "\$TICK_URL" -H "x-cron-secret: \$CRON_SECRET"/);
    expect(workflow).toContain('${{ secrets.CRON_SECRET }}');
    expect(workflow).toContain('${{ secrets.TICK_URL }}');
    expect(workflow).toMatch(/cron: '\d+ \d+ \* \* \*'/);
    expect(workflow).toContain('20261215');
  });

  describe('against the real route', () => {
    let db: Db;
    let dir: string;
    const saved = process.env.CRON_SECRET;
    const post = (headers: Record<string, string> = {}) => tickPOST(new Request('http://app.test/api/cron/tick', { method: 'POST', headers }));

    beforeAll(async () => {
      db = await openPglite();
      dir = await mkdtemp(join(tmpdir(), 'ur-b10d-'));
      await initialize(db, dir);
      setRouteDepsForTests({ db, uploadsDir: dir, invoices: mockInvoiceApi().api });
      process.env.CRON_SECRET = 'test-only-cron-secret';
    }, 120_000);
    afterAll(async () => {
      setRouteDepsForTests(null);
      if (saved === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = saved;
      await db?.close();
      if (dir) await rm(dir, { recursive: true, force: true });
    });

    it('the same request the workflow sends runs the tick, twice with no second effect', async () => {
      const one = await post({ 'x-cron-secret': 'test-only-cron-secret' });
      expect(one.status).toBe(200);
      const two = await post({ 'x-cron-secret': 'test-only-cron-secret' });
      expect(two.status).toBe(200);
      expect(await two.json()).toMatchObject({ renewals: { created: 0, sent: 0 }, expired: 0 });
    });

    it('no header or a wrong one is refused; unset is 503', async () => {
      expect((await post()).status).toBe(401);
      expect((await post({ 'x-cron-secret': 'wrong' })).status).toBe(401);
      delete process.env.CRON_SECRET;
      expect((await post({ 'x-cron-secret': 'test-only-cron-secret' })).status).toBe(503);
      process.env.CRON_SECRET = 'test-only-cron-secret';
    });

    it('/healthz answers for the uptime monitor', async () => {
      expect((await healthGET()).status).toBe(200);
    });
  });
});
