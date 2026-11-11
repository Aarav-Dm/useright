// Guard for the opt-in real-Postgres test files (review 5bae423 check new #2). They isolate themselves with a throwaway
// schema set through the search_path startup parameter. A transaction pooler (Supabase port 6543) may drop that
// parameter, so migrate/seed and the tests' bulk updates would hit the live public tables. Refuse to run unless every
// pooled connection we can see is really in the test schema.
import type { Db } from '../../db/client';

export function refusePooler(url: string): void {
  let port = '';
  try {
    port = new URL(url).port;
  } catch {
    throw new Error('TEST_DATABASE_URL is not a valid URL');
  }
  if (port === '6543') throw new Error('TEST_DATABASE_URL uses the transaction pooler (6543). Use a direct or session connection (5432) to a non-production project.');
}

/** Throws unless current_schema() is `schema` on `checks` separate pooled connections (run concurrently). */
export async function assertTestSchema(db: Db, schema: string, checks = 8): Promise<void> {
  const seen = await Promise.all(Array.from({ length: checks }, () =>
    db.transaction(async (tx) => {
      const [r] = await tx.query<{ s: string | null }>(`select current_schema() as s, pg_sleep(0.05)`);
      return r?.s ?? null;
    })));
  const wrong = seen.filter((s) => s !== schema);
  if (wrong.length) throw new Error(`refusing to run: current_schema() is ${JSON.stringify(wrong[0])}, not ${schema}. The search_path was not applied; nothing was written.`);
}
