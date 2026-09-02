import { initDb } from '../db/index.js';
import { createApp } from './app.js';
import { readSchedule, SyncRunner } from '../sync/runner.js';

const dbPath = process.env.DB_PATH ?? 'data/collection.db';
const coversDir = process.env.COVERS_DIR ?? 'covers';
const webDir = process.env.WEB_DIR ?? 'web/dist';
const port = Number(process.env.PORT ?? 8080);
// Default to all interfaces so the NAS container is reachable on the LAN.
const host = process.env.HOST ?? '0.0.0.0';

const db = initDb(dbPath);
// No token means the app still runs, read-only against whatever the CLI last
// imported; the sync routes then say exactly what is missing.
const runner = process.env.DISCOGS_PERSONAL_ACCESS_TOKEN
  ? new SyncRunner(db, { coversDir })
  : null;
const app = createApp(db, { coversDir, webDir, runner });

const server = app.listen(port, host, () => {
  const { releases } = { releases: (db.prepare('SELECT COUNT(*) AS n FROM release').get() as { n: number }).n };
  console.log(`crate listening on http://${host}:${port}`);
  console.log(`  database ${dbPath} — ${releases} releases`);
  console.log(`  covers   ${coversDir}`);
  if (!process.env.ANTHROPIC_API_KEY && !process.env.OPENAI_API_KEY) {
    console.log('  chat     disabled (set ANTHROPIC_API_KEY or OPENAI_API_KEY)');
  } else {
    console.log(`  chat     ${process.env.CHAT_BACKEND ?? 'anthropic'} via ${process.env.MCP_URL ?? 'local tools only'}`);
  }
  if (runner) {
    runner.startScheduler();
    console.log(`  sync     ${readSchedule(db)} (read-only; edits happen on Discogs)`);
  } else {
    console.log('  sync     disabled (set DISCOGS_PERSONAL_ACCESS_TOKEN)');
  }
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
  });
}
