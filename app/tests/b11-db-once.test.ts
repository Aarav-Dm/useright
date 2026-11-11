// Click review finding 1 (docs/reviews/b11-build-click.md): Next bundles pages and route handlers apart, so each loads its own
// copy of lib/server. Two copies here stand in for the two bundles. On PGlite two databases meant a page never saw a payment.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';

it('a page bundle and a route bundle share one database', { timeout: 120_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ur-db-once-'));
  const saved = { pg: process.env.PGLITE_DIR, url: process.env.DATABASE_URL };
  process.env.PGLITE_DIR = join(dir, 'pg');
  delete process.env.DATABASE_URL;
  try {
    vi.resetModules();
    const route = await import('../lib/server');
    vi.resetModules();
    const page = await import('../lib/server');
    expect(page).not.toBe(route);
    const [a, b] = [(await route.deps()).db, (await page.deps()).db];
    expect(b).toBe(a);
    await a.close();
  } finally {
    delete (globalThis as { __useRightDb?: unknown }).__useRightDb;
    if (saved.pg === undefined) delete process.env.PGLITE_DIR; else process.env.PGLITE_DIR = saved.pg;
    if (saved.url !== undefined) process.env.DATABASE_URL = saved.url;
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});
