// Applies db/migrations/*.sql in filename order, each in its own transaction, once.
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Db } from './client';

// Resolved from the working directory (app/) so bundlers don't try to treat the folder as an asset.
export const MIGRATIONS_DIR = process.env.MIGRATIONS_DIR ?? join(process.cwd(), 'db', 'migrations');

/** Returns the names applied by this run ([] when already up to date). */
export async function migrate(db: Db, dir: string = MIGRATIONS_DIR): Promise<string[]> {
  await db.query(
    `create table if not exists schema_migrations (
       name text primary key,
       applied_at timestamptz not null default now()
     )`,
  );
  const files = (await readdir(/*turbopackIgnore: true*/ dir)).filter((f) => f.endsWith('.sql')).sort();
  const applied: string[] = [];
  for (const name of files) {
    const sql = await readFile(/*turbopackIgnore: true*/ join(/*turbopackIgnore: true*/ dir, name), 'utf8');
    const ran = await db.transaction(async (tx) => {
      // Serialise concurrent runners; the loser re-checks and skips.
      await tx.query(`select pg_advisory_xact_lock(hashtext('schema_migrations'))`, []);
      const done = await tx.query(`select 1 from schema_migrations where name = $1`, [name]);
      if (done.length > 0) return false;
      await tx.query(sql);
      await tx.query(`insert into schema_migrations (name) values ($1)`, [name]);
      return true;
    });
    if (ran) applied.push(name);
  }
  return applied;
}
