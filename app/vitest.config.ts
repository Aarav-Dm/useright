import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./', import.meta.url)) } },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.{ts,tsx}'],
    testTimeout: 30_000,
    // Batch-6 review F11: tokens have no built-in key; tests inject this explicit, test-only secret.
    env: { APP_SECRET: 'vitest-only-app-secret-not-for-real-links' },
    // Each file migrates + seeds its own PGlite in beforeAll; with ~13 files in parallel on a loaded machine that can
    // pass vitest's 10 s default (seen: 7 files 'Hook timed out in 10000ms', then green on re-run).
    hookTimeout: 60_000,
  },
});
