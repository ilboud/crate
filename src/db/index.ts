import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { seedTaxonomy } from './seed-taxonomy.js';

export type Db = Database.Database;

const here = dirname(fileURLToPath(import.meta.url));

/** Open (creating if needed) the collection database. Pass ':memory:' in tests. */
export function openDb(path: string): Db {
  const db = new Database(path);
  db.pragma('foreign_keys = ON');
  return db;
}

export function migrate(db: Db): void {
  const sql = readFileSync(join(here, 'schema.sql'), 'utf8');
  db.exec(sql);
  addMissingColumns(db);
}

/**
 * schema.sql only creates tables that do not exist, so columns added later
 * never reach a database built by an earlier version. Add them here.
 */
function addMissingColumns(db: Db): void {
  const columns = new Set(
    (db.prepare('PRAGMA table_info(release)').all() as Array<{ name: string }>).map((c) => c.name),
  );
  for (const [name, type] of [
    ['hi_path', 'TEXT'],
    ['art_source', 'TEXT'],
    ['art_checked_at', 'TEXT'],
  ] as const) {
    if (!columns.has(name)) db.exec(`ALTER TABLE release ADD COLUMN ${name} ${type}`);
  }
}

/** Open, migrate and seed in one call — the normal entry point. */
export function initDb(path: string): Db {
  const db = openDb(path);
  migrate(db);
  seedTaxonomy(db);
  return db;
}

export function getSetting(db: Db, key: string, fallback: string): string {
  const row = db.prepare('SELECT value FROM setting WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? fallback;
}

export function setSetting(db: Db, key: string, value: string): void {
  db.prepare('INSERT OR REPLACE INTO setting (key, value) VALUES (?, ?)').run(key, value);
}
