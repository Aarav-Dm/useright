import { expect, it } from 'vitest';
import { adapterFromEnv, geminiProvider } from '../lib/ai/extract';

it('defaults both Gemini entry points to flash-latest and preserves explicit overrides', () => {
  expect(geminiProvider('test-only-key').model).toBe('gemini-flash-latest');
  const env = { NODE_ENV: 'test' as const, AI_PROVIDER: 'gemini', GEMINI_API_KEY: 'test-only-key' };
  expect(adapterFromEnv(env).model).toBe('gemini-flash-latest');
  expect(adapterFromEnv({ ...env, AI_MODEL: 'explicit-model' }).model).toBe('explicit-model');
});
