-- Discogs collection schema.
-- release.primary_group is DERIVED from the taxonomy tables; never edit it
-- directly. Call reassignAll() after any taxonomy or collection change.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS taxonomy_group (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  -- Tie-break PRECEDENCE for assignment, ordered specific to general — not a
  -- display order. Menus sort by name; changing this re-files records.
  sort_order  INTEGER NOT NULL DEFAULT 0,
  hidden      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS taxonomy_style (
  style     TEXT PRIMARY KEY,
  group_id  INTEGER NOT NULL REFERENCES taxonomy_group(id) ON DELETE CASCADE
);

-- Maps a coarse Discogs genre to a group. Used as the tier-3 tie-break and as
-- the tier-4 fallback for releases carrying no styles at all.
CREATE TABLE IF NOT EXISTS taxonomy_genre (
  genre     TEXT PRIMARY KEY,
  group_id  INTEGER NOT NULL REFERENCES taxonomy_group(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS release (
  id             INTEGER PRIMARY KEY,
  master_id      INTEGER,
  title          TEXT NOT NULL,
  year           INTEGER,
  primary_group  TEXT,
  assign_method  TEXT,
  cover_path     TEXT,
  thumb_path     TEXT,
  -- Higher-resolution art sourced outside Discogs, whose images cap at 600px.
  -- Null means no confident match was found and cover_path still applies.
  hi_path        TEXT,
  art_source     TEXT,
  art_checked_at TEXT,
  raw_json       TEXT NOT NULL
);

-- One row per physical copy owned. A release can be owned more than once —
-- the collection contains two copies of Bar-Kays "Money Talks" — so instances
-- live here rather than on `release`. Browsing shows distinct releases; the
-- copy count comes from this table.
CREATE TABLE IF NOT EXISTS collection_item (
  instance_id  INTEGER PRIMARY KEY,
  release_id   INTEGER NOT NULL REFERENCES release(id) ON DELETE CASCADE,
  folder_id    INTEGER,
  date_added   TEXT
);

CREATE INDEX IF NOT EXISTS idx_item_release ON collection_item(release_id);

CREATE TABLE IF NOT EXISTS artist (
  id    INTEGER PRIMARY KEY,
  name  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS release_artist (
  release_id  INTEGER NOT NULL REFERENCES release(id) ON DELETE CASCADE,
  artist_id   INTEGER NOT NULL REFERENCES artist(id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,
  join_str    TEXT,
  PRIMARY KEY (release_id, artist_id, seq)
);

CREATE TABLE IF NOT EXISTS label (
  id    INTEGER PRIMARY KEY,
  name  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS release_label (
  release_id  INTEGER NOT NULL REFERENCES release(id) ON DELETE CASCADE,
  label_id    INTEGER NOT NULL REFERENCES label(id) ON DELETE CASCADE,
  catno       TEXT,
  PRIMARY KEY (release_id, label_id, catno)
);

CREATE TABLE IF NOT EXISTS release_genre (
  release_id  INTEGER NOT NULL REFERENCES release(id) ON DELETE CASCADE,
  genre       TEXT NOT NULL,
  PRIMARY KEY (release_id, genre)
);

CREATE TABLE IF NOT EXISTS release_style (
  release_id  INTEGER NOT NULL REFERENCES release(id) ON DELETE CASCADE,
  style       TEXT NOT NULL,
  PRIMARY KEY (release_id, style)
);

CREATE TABLE IF NOT EXISTS release_format (
  release_id   INTEGER NOT NULL REFERENCES release(id) ON DELETE CASCADE,
  seq          INTEGER NOT NULL,
  name         TEXT NOT NULL,
  qty          INTEGER NOT NULL DEFAULT 1,
  descriptions TEXT,
  PRIMARY KEY (release_id, seq)
);

CREATE TABLE IF NOT EXISTS track (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  release_id     INTEGER NOT NULL REFERENCES release(id) ON DELETE CASCADE,
  seq            INTEGER NOT NULL,
  position_raw   TEXT,
  disc           INTEGER NOT NULL DEFAULT 1,
  side           TEXT,
  index_on_side  INTEGER,
  title          TEXT NOT NULL,
  duration_sec   INTEGER
);

CREATE TABLE IF NOT EXISTS similar (
  release_id  INTEGER NOT NULL REFERENCES release(id) ON DELETE CASCADE,
  other_id    INTEGER NOT NULL REFERENCES release(id) ON DELETE CASCADE,
  score       REAL NOT NULL,
  reason      TEXT,
  same_artist INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (release_id, other_id)
);

-- Tier 1: hand-set, wins over every rule.
CREATE TABLE IF NOT EXISTS release_override (
  release_id  INTEGER PRIMARY KEY REFERENCES release(id) ON DELETE CASCADE,
  group_id    INTEGER NOT NULL REFERENCES taxonomy_group(id) ON DELETE CASCADE,
  note        TEXT
);

CREATE TABLE IF NOT EXISTS setting (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_run (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at   TEXT NOT NULL,
  finished_at  TEXT,
  ok_count     INTEGER NOT NULL DEFAULT 0,
  failed_ids   TEXT NOT NULL DEFAULT '[]'
);

CREATE INDEX IF NOT EXISTS idx_track_release   ON track(release_id);
CREATE INDEX IF NOT EXISTS idx_release_group   ON release(primary_group);
CREATE INDEX IF NOT EXISTS idx_rstyle_style    ON release_style(style);
CREATE INDEX IF NOT EXISTS idx_similar_release ON similar(release_id, same_artist, score DESC);

-- Track search. Denormalized artist/album so one query can rank a song hit
-- and show which record it lives on without a join.
CREATE VIRTUAL TABLE IF NOT EXISTS track_fts USING fts5(
  title,
  artist,
  album,
  track_id UNINDEXED,
  release_id UNINDEXED,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE VIRTUAL TABLE IF NOT EXISTS release_fts USING fts5(
  title,
  artist,
  release_id UNINDEXED,
  tokenize = 'unicode61 remove_diacritics 2'
);
