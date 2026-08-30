#!/usr/bin/env node
import { initDb } from '../db/index.js';
import { DiscogsClient } from './discogs.js';
import { runSync } from './sync.js';

/**
 * `npm run sync [-- --force]`
 *
 * Pulls the collection into SQLite and mirrors cover art. Incremental by
 * default; --force re-fetches everything, needed after a taxonomy or parser
 * change.
 */
async function main(): Promise<void> {
  const token = process.env.DISCOGS_PERSONAL_ACCESS_TOKEN;
  if (!token) {
    console.error('DISCOGS_PERSONAL_ACCESS_TOKEN is not set.');
    process.exit(1);
  }

  const dbPath = process.env.DB_PATH ?? 'data/collection.db';
  const coversDir = process.env.COVERS_DIR ?? 'covers';
  const force = process.argv.includes('--force');

  const db = initDb(dbPath);
  const client = new DiscogsClient({ token });

  let username = process.env.DISCOGS_USERNAME;
  if (!username) {
    const identity = await client.getIdentity();
    username = identity.username;
    console.log(`Authenticated as ${username} (id ${identity.id})`);
  }

  console.log(`Syncing ${username} -> ${dbPath}${force ? ' (forced)' : ''}`);

  const result = await runSync(
    db,
    {
      client,
      coversDir,
      onProgress: (done, total, label) => {
        process.stdout.write(`\r  fetching ${done}/${total}  ${label}`.padEnd(60));
      },
    },
    { username, force },
  );

  process.stdout.write('\r'.padEnd(62) + '\r');
  const releases = result.added + result.unchanged;
  console.log(
    `Done in ${(result.durationMs / 1000).toFixed(1)}s — ` +
      `${result.added} fetched, ${result.unchanged} unchanged, ${result.removed} removed`,
  );
  console.log(`  ${releases} distinct releases from ${result.items} copies owned`);
  if (result.failed.length) {
    console.warn(
      `  ${result.failed.length} release(s) failed and will retry next run: ${result.failed.join(', ')}`,
    );
  }
  db.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
