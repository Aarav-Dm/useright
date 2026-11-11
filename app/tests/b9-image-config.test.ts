// Security review finding 3: the image route must not fetch a download link, because Next caches the result past the
// link's limits. Only the public portfolio copies go through next/image.
import { hasLocalMatch } from 'next/dist/shared/lib/match-local-pattern';
import { describe, expect, it } from 'vitest';
import config from '../next.config';
import manifest from '../public/portfolio/imani/photos.json';

describe('images.localPatterns', () => {
  const allowed = (url: string) => hasLocalMatch(config.images?.localPatterns, url);

  it('refuses download, pay and API paths', () => {
    for (const url of ['/download/abc', '/pay/abc', '/api/pay/abc/preview', '/api/briefs/abc/image', '/samples/demo-dm.png']) expect(allowed(url)).toBe(false);
  });

  it('allows every photo the client page shows', () => {
    expect(manifest.photos.length).toBe(24);
    for (const p of manifest.photos) expect(allowed(`/portfolio/imani/${p.filename}`)).toBe(true);
  });
});
