#!/usr/bin/env node
import { initDb } from '../db/index.js';
import { upgradeArt } from './upgrade.js';
import { findByBarcode, searchItunes } from './sources.js';

/**
 * `npm run art [-- --force]`
 *
 * Fetches higher-resolution covers than the 600px Discogs ceiling, from Cover
 * Art Archive (by barcode, exact) and iTunes (by search, verified). A record
 * keeps its Discogs art unless a candidate is both verified and larger.
 */
async function main(): Promise<void> {
  const dbPath = process.env.DB_PATH ?? 'data/collection.db';
  const coversDir = process.env.COVERS_DIR ?? 'covers';
  const force = process.argv.includes('--force');
  // --retry re-examines only what has no upgraded art, which is the cheap way
  // to pick up matcher improvements without refetching what already worked.
  const retry = process.argv.includes('--retry');

  const db = initDb(dbPath);

  const fetchImage = async (url: string): Promise<Buffer | null> => {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'DiscogsCollectionApp/0.1' } });
      if (!res.ok) return null;
      return Buffer.from(await res.arrayBuffer());
    } catch {
      return null;
    }
  };

  const mode = force ? ' (forced)' : retry ? ' (retrying records without upgraded art)' : '';
  console.log(`Upgrading cover art${mode} — this is rate-limited, expect a few minutes.`);

  const result = await upgradeArt(
    db,
    { findByBarcode, searchItunes, fetchImage },
    {
      coversDir,
      force,
      retry,
      onProgress: (done, total, label) => {
        process.stdout.write(`\r  ${done}/${total}  ${label.slice(0, 44)}`.padEnd(64));
      },
    },
  );

  process.stdout.write('\r'.padEnd(66) + '\r');
  console.log(`  ${result.upgraded} upgraded`, result.bySource);
  console.log(`  ${result.kept} kept the Discogs art (no confident or larger match)`);
  if (result.failed) console.log(`  ${result.failed} download(s) failed; they retry next run`);

  if (result.rejections.length) {
    console.log('\n  Not upgraded, and why:');
    for (const r of result.rejections.slice(0, 15)) {
      console.log(`    ${r.title.slice(0, 40).padEnd(42)} ${r.reason}`);
    }
    if (result.rejections.length > 15) {
      console.log(`    …and ${result.rejections.length - 15} more`);
    }
  }
  db.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
