/**
 * Migration runner script.
 * Usage: npx tsx scripts/migrate.ts [--dir <migrations-dir>]
 *
 * Reads PG_HOST, PG_PORT, PG_DATABASE, PG_USER, PG_PASSWORD from environment.
 */

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PgClient } from '../src/storage/pg-client.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let migrationsDir = resolve(__dirname, '..', 'src', 'storage', 'migrations');

  // Parse --dir flag
  const dirIdx = args.indexOf('--dir');
  if (dirIdx !== -1 && args[dirIdx + 1]) {
    migrationsDir = resolve(args[dirIdx + 1]);
  }

  console.log(`Running migrations from: ${migrationsDir}`);

  const client = new PgClient();

  try {
    const healthy = await client.ping();
    if (!healthy) {
      console.error('Cannot connect to database. Check PG_* environment variables.');
      process.exit(1);
    }

    const results = await client.runMigrations(migrationsDir);

    if (results.length === 0) {
      console.log('No new migrations to apply.');
    } else {
      console.log(`Applied ${results.length} migration(s):`);
      for (const r of results) {
        console.log(`  v${r.version}: ${r.name} (${r.appliedAt.toISOString()})`);
      }
    }
  } catch (err) {
    console.error('Migration failed:', err);
    process.exit(1);
  } finally {
    await client.shutdown();
  }
}

main();
