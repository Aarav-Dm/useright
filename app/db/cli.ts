// npm run db:init | db:migrate | db:seed | db:files
import { openDb } from './client';
import { migrate } from './migrate';
import { seed } from './seed';

const command = process.argv[2];
const uploadsDir = process.env.UPLOADS_DIR ?? './.uploads';
const db = await openDb();
try {
  if (command === 'init') {
    // Batch-6 review F8: migrate + seed + placeholder files, the documented fresh-setup step.
    const { initialize } = await import('./init');
    const r = await initialize(db, uploadsDir);
    console.log(`migrations applied: ${r.migrations.length ? r.migrations.join(', ') : 'none'}; seed: ${r.seed.created ? 'created' : 'already present'}; demo deals: ${r.demo.created ? 'created' : 'already present'}; asset files written: ${r.filesWritten}`);
  } else if (command === 'migrate') {
    const applied = await migrate(db);
    console.log(applied.length ? `applied: ${applied.join(', ')}` : 'migrations: up to date');
  } else if (command === 'seed') {
    const result = await seed(db);
    console.log(result.created ? `seeded creator imani (${result.creatorId})` : 'seed: imani already present, nothing written');
    // Batch 7: the demo deals (every dashboard state); skipped once present.
    const { seedDemo } = await import('./seed-demo');
    console.log((await seedDemo(db)).created ? 'demo deals: created' : 'demo deals: already present');
    // F8: the seeded assets are only downloadable once their files exist.
    const { ensureAssetFiles } = await import('../lib/placeholder-files');
    console.log(`asset files written: ${await ensureAssetFiles(db, uploadsDir)}`);
  } else if (command === 'files') {
    // Batch 6: placeholder web/print/preview files for the seeded assets (no real photos in the repo).
    const { ensureAssetFiles } = await import('../lib/placeholder-files');
    console.log(`asset files written: ${await ensureAssetFiles(db, uploadsDir)}`);
  } else {
    console.error('usage: tsx db/cli.ts <init|migrate|seed|files>');
    process.exitCode = 2;
  }
} finally {
  await db.close();
}
