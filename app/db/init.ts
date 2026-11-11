// Fresh setup in one step (batch-6 review F8): migrate, seed, the batch-7 demo deals, and the placeholder files the
// seeded assets point at, so a new checkout can download a licensed file. Idempotent: existing rows and files are left alone.
import type { Db } from './client';
import { migrate } from './migrate';
import { seed, type SeedResult } from './seed';
import { seedDemo, type DemoResult } from './seed-demo';
import { ensureAssetFiles } from '../lib/placeholder-files';

export async function initialize(db: Db, uploadsDir: string, migrationsDir?: string): Promise<{ migrations: string[]; seed: SeedResult; demo: DemoResult; filesWritten: number }> {
  const migrations = await migrate(db, migrationsDir);
  const s = await seed(db);
  const demo = await seedDemo(db);
  const filesWritten = await ensureAssetFiles(db, uploadsDir);
  return { migrations, seed: s, demo, filesWritten };
}
