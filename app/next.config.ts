import type { NextConfig } from 'next';

const noReferrer = [{ key: 'Referrer-Policy', value: 'no-referrer' }, { key: 'X-Robots-Tag', value: 'noindex' }];

const nextConfig: NextConfig = {
  // PGlite ships WASM; keep it out of the server bundle.
  // The client page asks for these image qualities; Next 16 defaults to [75] and coerces the rest.
  // Security review finding 3: without localPatterns the optimizer would fetch and cache /download/<token>. next/image is
  // used only for the portfolio copies; the pay preview, screenshots and samples use plain <img> or fetch.
  images: { qualities: [70, 75, 80, 85], localPatterns: [{ pathname: '/portfolio/**' }] },
  serverExternalPackages: ['@electric-sql/pglite', '@paypal/agent-toolkit'],
  // Batch-6 fix 22: pay links, download links and receipt ids never leave through Referer.
  async headers() {
    return ['/pay/:path*', '/download/:path*', '/r/:path*', '/api/pay/:path*'].map((source) => ({ source, headers: noReferrer }));
  },
};

export default nextConfig;
