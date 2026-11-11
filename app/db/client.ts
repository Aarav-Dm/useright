// One query() adapter (batch-2 §5). PGlite in tests and local dev; postgres.js against Supabase
// once DATABASE_URL exists. Callers only see Queryable / Db.
//
// query(text) with no params may hold several statements (used for migration files).
// query(text, params) runs one parameterized statement.

import type { Sql, TransactionSql } from 'postgres';

export type Row = Record<string, unknown>;

export interface Queryable {
  query<T extends Row = Row>(text: string, params?: readonly unknown[]): Promise<T[]>;
}

export interface Db extends Queryable {
  /** Runs fn in one transaction on one connection; commits on return, rolls back on throw. */
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

type PgliteLike = {
  query<T>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
  exec(text: string): Promise<Array<{ rows: unknown[] }>>;
};

function pgliteQueryable(pg: PgliteLike): Queryable {
  return {
    async query<T extends Row = Row>(text: string, params?: readonly unknown[]) {
      if (!params || params.length === 0) {
        const results = await pg.exec(text);
        return (results.at(-1)?.rows ?? []) as T[];
      }
      return (await pg.query<T>(text, [...params])).rows;
    },
  };
}

/** PGlite database. `dataDir` omitted = in-memory (tests). */
export async function openPglite(dataDir?: string): Promise<Db> {
  const { PGlite } = await import('@electric-sql/pglite');
  const pg = dataDir ? new PGlite(dataDir) : new PGlite();
  await pg.waitReady;
  return {
    ...pgliteQueryable(pg),
    transaction: (fn) => pg.transaction((tx) => fn(pgliteQueryable(tx))),
    close: () => pg.close(),
  };
}

/**
 * postgres.js against a Postgres URL (Supabase). `searchPath` is applied to every pooled connection as a startup
 * parameter (B5 review 3); a `set search_path` statement would only reach one connection.
 */
export async function openPostgres(url: string, opts: { searchPath?: string; max?: number } = {}): Promise<Db> {
  const { default: postgres } = await import('postgres');
  // prepare:false keeps it working through Supabase's transaction-mode pooler (port 6543).
  const sql = postgres(url, {
    prepare: false, max: opts.max ?? 5, onnotice: () => {},
    // Writers already encode JSON for PGlite; do not encode those strings a second time.
    types: {
      jsonb: {
        to: 3802, from: [3802],
        serialize: (value: unknown) => typeof value === 'string' ? value : JSON.stringify(value),
        parse: JSON.parse,
      },
    },
    ...(opts.searchPath ? { connection: { search_path: opts.searchPath } } : {}),
  });
  const queryable = (s: Sql | TransactionSql): Queryable => ({
    async query<T extends Row = Row>(text: string, params?: readonly unknown[]) {
      const rows = await s.unsafe(text, params ? ([...params] as never[]) : undefined);
      return [...rows] as unknown as T[];
    },
  });
  return {
    ...queryable(sql),
    transaction: async <T>(fn: (tx: Queryable) => Promise<T>) => (await sql.begin((tx) => fn(queryable(tx)))) as T,
    close: () => sql.end(),
  };
}

/** DATABASE_URL -> postgres.js; otherwise PGlite at PGLITE_DIR (default ./.pglite). */
export async function openDb(env: NodeJS.ProcessEnv = process.env): Promise<Db> {
  if (env.DATABASE_URL) return openPostgres(env.DATABASE_URL);
  return openPglite(env.PGLITE_DIR ?? './.pglite');
}
