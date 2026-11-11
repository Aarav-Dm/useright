import postgres from 'postgres';
import { expect, it, vi } from 'vitest';
import { openPostgres } from '../db/client';

vi.mock('postgres', async (load) => {
  const actual = await load<{ default: typeof postgres }>();
  return { ...actual, default: vi.fn(actual.default) };
});

it('installs JSONB handlers that encode once and parse objects on reads', async () => {
  // postgres.js connects lazily; this tests its installed handlers without a database server.
  const db = await openPostgres('postgres://test:test@127.0.0.1:1/test');
  try {
    const sql = vi.mocked(postgres).mock.results[0]!.value as ReturnType<typeof postgres>;
    const serialize = sql.options.serializers[3802]!;
    const parse = sql.options.parsers[3802]!;
    const scope = { channels: ['social'], territory: 'US' };
    const encoded = JSON.stringify(scope);
    expect(serialize(encoded)).toBe(encoded);
    expect(serialize(scope)).toBe(encoded);
    expect(parse(serialize(scope))).toEqual(scope);
    expect(parse(serialize(encoded))).toEqual(scope);
  } finally {
    await db.close();
  }
});
