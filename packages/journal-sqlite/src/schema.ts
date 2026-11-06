/**
 * The SQLite schema for the journal (docs/journal.md).
 *
 * The journal is append-only: nothing is edited, nothing is deleted, nothing
 * merges. The one exception is a redaction, which erases content in place and
 * records, in its own event, that it did.
 *
 * Layout:
 *
 * - `events` - one row per event. `seq` is the one global order, assigned at
 *   append and only growing; the ref is `r` + `seq`. `time` is for display.
 * - `event_targets` - what an event touches, one row per target, indexed by
 *   target for dispatch candidates, steering and notices.
 * - `event_refs` - the refs an event names.
 * - `event_blobs` - the media an event holds, by id; the bytes live in the
 *   blob store beside the journal.
 * - `links` - the links the host records between refs.
 * - `watermarks` - the newest event on a target a window has seen.
 * - `redactions` - which event redacted which, and why.
 * - `blobs` - media stored once by content.
 * - `events_fts` - trigram index for exact substrings.
 * - `events_words` - word index for BM25.
 */

import type { DatabaseSync } from "node:sqlite";

/** Bumped when a change makes an existing database unusable. */
export const SCHEMA_VERSION = 2;

/** A bare cite is weaker than a link the host declared. */
export const IMPLICIT_CITE_WEIGHT = 0.5;

export const TRIGRAM_TABLE = "events_fts";
export const WORD_TABLE = "events_words";

const STATEMENTS: readonly string[] = [
  `PRAGMA journal_mode = WAL`,
  `PRAGMA foreign_keys = ON`,
  `PRAGMA busy_timeout = 5000`,

  `CREATE TABLE IF NOT EXISTS meta (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS events (
     seq INTEGER PRIMARY KEY AUTOINCREMENT,
     window TEXT,
     time INTEGER NOT NULL,
     kind TEXT NOT NULL,
     external TEXT,
     body TEXT,
     redacted TEXT
   )`,

  // A redelivered outside message is stored once.
  `CREATE UNIQUE INDEX IF NOT EXISTS events_external ON events (external) WHERE external IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS events_window ON events (window, seq)`,
  `CREATE INDEX IF NOT EXISTS events_kind ON events (kind, seq)`,

  `CREATE TABLE IF NOT EXISTS event_targets (
     seq INTEGER NOT NULL,
     target TEXT NOT NULL,
     PRIMARY KEY (seq, target)
   )`,
  `CREATE INDEX IF NOT EXISTS event_targets_target ON event_targets (target, seq)`,

  `CREATE TABLE IF NOT EXISTS event_refs (
     seq INTEGER NOT NULL,
     ref TEXT NOT NULL,
     PRIMARY KEY (seq, ref)
   )`,
  `CREATE INDEX IF NOT EXISTS event_refs_ref ON event_refs (ref, seq)`,

  `CREATE TABLE IF NOT EXISTS event_blobs (
     seq INTEGER NOT NULL,
     blob TEXT NOT NULL,
     PRIMARY KEY (seq, blob)
   )`,

  `CREATE TABLE IF NOT EXISTS links (
     seq INTEGER NOT NULL,
     from_ref TEXT NOT NULL,
     to_ref TEXT NOT NULL,
     kind TEXT NOT NULL,
     weight REAL NOT NULL,
     time INTEGER NOT NULL,
     PRIMARY KEY (seq, to_ref, kind)
   )`,
  `CREATE INDEX IF NOT EXISTS links_to ON links (to_ref, weight DESC, seq DESC)`,
  `CREATE INDEX IF NOT EXISTS links_from ON links (from_ref, seq DESC)`,

  `CREATE TABLE IF NOT EXISTS watermarks (
     window TEXT NOT NULL,
     target TEXT NOT NULL,
     seq INTEGER NOT NULL,
     PRIMARY KEY (window, target)
   )`,

  `CREATE TABLE IF NOT EXISTS redactions (
     covers INTEGER PRIMARY KEY,
     by INTEGER NOT NULL,
     reason TEXT NOT NULL,
     time INTEGER NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS blobs (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     sha256 TEXT NOT NULL UNIQUE,
     size INTEGER NOT NULL,
     mime TEXT,
     path TEXT NOT NULL,
     time INTEGER NOT NULL
   )`,

  // Exact substrings, for Chinese and mixed text.
  `CREATE VIRTUAL TABLE IF NOT EXISTS ${TRIGRAM_TABLE} USING fts5(body, tokenize = 'trigram')`,
  // Words, for BM25.
  `CREATE VIRTUAL TABLE IF NOT EXISTS ${WORD_TABLE} USING fts5(body, tokenize = 'unicode61')`,
];

/**
 * Version 2 dropped the `snapshot` column from `events`: the workspace
 * snapshots it named are gone with the plain-directory workspace
 * (docs/workspaces.md). Every event, every ref and every index that does not
 * name the column stays, so a version-1 database opens where it left off
 * instead of being rebuilt.
 */
function migrateToVersion2(db: DatabaseSync): void {
  const columns = db.prepare("PRAGMA table_info(events)").all() as { name: string }[];
  if (!columns.some((column) => column.name === "snapshot")) return;
  // An index that names the column has to go before the column does.
  const indexes = db.prepare("PRAGMA index_list(events)").all() as { name: string }[];
  for (const index of indexes) {
    const keys = db.prepare(`PRAGMA index_info(${JSON.stringify(index.name)})`).all() as {
      name: string | null;
    }[];
    if (!keys.some((key) => key.name === "snapshot")) continue;
    db.exec(`DROP INDEX ${JSON.stringify(index.name)}`);
  }
  db.exec("ALTER TABLE events DROP COLUMN snapshot");
}

/** Create the schema when it is missing, migrate an older one, and record the version. */
export function createSchema(db: DatabaseSync): void {
  // The version lives in the one table that has to exist before anything else.
  db.exec(
    `CREATE TABLE IF NOT EXISTS meta (
       key TEXT PRIMARY KEY,
       value TEXT NOT NULL
     )`,
  );
  const version = readMeta(db, "schema_version");
  if (version !== null && Number(version) > SCHEMA_VERSION) {
    throw new Error(
      `journal schema ${version} is newer than this build (${SCHEMA_VERSION}); upgrade arbor, or migrate the database`,
    );
  }
  if (Number(version) === SCHEMA_VERSION - 1) migrateToVersion2(db);
  for (const statement of STATEMENTS) db.exec(statement);
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)").run(String(SCHEMA_VERSION));
}

export function readMeta(db: DatabaseSync, key: string): string | null {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row === undefined ? null : row.value;
}
