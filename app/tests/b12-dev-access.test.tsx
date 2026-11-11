import { afterEach, describe, expect, it, vi } from 'vitest';
import Intake from '@/app/dev/intake/page';
import Brief from '@/app/dev/briefs/[id]/page';

const state = vi.hoisted(() => ({ cookie: undefined as string | undefined }));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => state.cookie ? { value: state.cookie } : undefined }) }));
vi.mock('next/navigation', () => ({
  notFound: () => { throw new Error('404'); },
  redirect: (path: string) => { throw new Error(`redirect:${path}`); },
}));
const pages = [() => Intake(), () => Brief({ params: Promise.resolve({ id: 'test' }) })];
afterEach(() => { vi.unstubAllEnvs(); state.cookie = undefined; });

describe('B12 Part A: production dev pages', () => {
  it('returns 404 before render/redirect unless the creator session is valid; local development still works', async () => {
    vi.stubEnv('CREATOR_TOKEN', 'test-b12-token');
    vi.stubEnv('NODE_ENV', 'production');
    for (const cookie of [undefined, 'wrong']) {
      state.cookie = cookie;
      for (const page of pages) await expect(page()).rejects.toThrow('404');
    }
    state.cookie = 'test-b12-token';
    expect(await Intake()).toBeTruthy();
    await expect(pages[1]!()).rejects.toThrow('redirect:/deals/test');
    vi.stubEnv('CREATOR_TOKEN', '');
    for (const page of pages) await expect(page()).rejects.toThrow('404');
    vi.stubEnv('NODE_ENV', 'development');
    state.cookie = undefined;
    expect(await Intake()).toBeTruthy();
    await expect(pages[1]!()).rejects.toThrow('redirect:/deals/test');
  });
});
