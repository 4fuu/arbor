/**
 * The SQLite schema for notes (docs/memory.md).
 *
 * Notes are the long-term memory: one copy of each, shared by every window.
 * The store keeps its own database beside the journal's, and records every
 * write in the journal as a `note_revision` event, so the journal stays the one
 * record of what happened while the store stays the one copy of the content.
 *
 * Layout:
 *
 * - `notes` - one row per note: its current state. A delete leaves the row and
 *   marks it `deleted`, so every ref to it keeps resolving.
 * - `note_revisions` - one row per revision, append-only, in the one global
 *   write order `wseq`. The body of every revision that ever was stays here.
 * - `note_usage` - what windows cite, use as evidence and read, decayed by age
 *   when it is scored.
 * - `note_refs` - the refs every revision names, with the note id when the ref
 *   is a note: the backlinks one lookup reads, and the evidence links the
 *   credit walk follows.
 * - `note_epochs` - one row per snapshot epoch, with the write order it was
 *   built at.
 * - `note_epoch_items` - the active notes one epoch froze, with the summaries
 *   it froze them at, so a window's prefix never changes under it.
 * - `notes_fts` - trigram index for exact substrings over title, summary and
 *   body.
 * - `notes_words` - word index for BM25 over the same three columns, segmented
 *   (docs/journal.md#search).
 */

import type { DatabaseSync } from "node:sqlite";
import type { Segmenter } from "@4fu/arbor-interfaces";
import { indexText, resolveSegmenter } from "@4fu/arbor-lexical";

/** Bumped when a change makes an existing database unusable. */
export const SCHEMA_VERSION = 2;

/** The FTS5 table note search reads. */
export const FTS_TABLE = "notes_fts";

/** The word index note search reads. */
export const WORD_TABLE = "notes_words";

/** The trigram index: exact substrings, for Chinese and mixed text. */
const TRIGRAM_INDEX = `CREATE VIRTUAL TABLE IF NOT EXISTS ${FTS_TABLE}
   USING fts5(title, summary, body, tokenize = 'trigram')`;

/**
 * The word index: one column per searched field, each holding that field's
 * segments, one per line. The columns are what the BM25 weights rank by.
 */
const WORD_INDEX = `CREATE VIRTUAL TABLE IF NOT EXISTS ${WORD_TABLE}
   USING fts5(title, summary, body, tokenize = 'unicode61')`;

const STATEMENTS: readonly string[] = [
  `PRAGMA journal_mode = WAL`,
  `PRAGMA foreign_keys = ON`,
  `PRAGMA busy_timeout = 5000`,

  `CREATE TABLE IF NOT EXISTS meta (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL
   )`,

  // The note's current state. The revisions are the history; this row is what
  // a list, a search and the active set read.
  `CREATE TABLE IF NOT EXISTS notes (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     created INTEGER NOT NULL,
     updated INTEGER NOT NULL,
     revision INTEGER NOT NULL,
     title TEXT NOT NULL,
     summary TEXT NOT NULL,
     body TEXT NOT NULL,
     status TEXT NOT NULL,
     window TEXT,
     anchor TEXT,
     event TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS notes_status ON notes (status, id)`,

  // One row per revision, append-only. `wseq` is the one global write order
  // the epoch's delta is measured from; one note has one row per revision.
  `CREATE TABLE IF NOT EXISTS note_revisions (
     wseq INTEGER PRIMARY KEY AUTOINCREMENT,
     note INTEGER NOT NULL,
     revision INTEGER NOT NULL,
     title TEXT NOT NULL,
     summary TEXT NOT NULL,
     body TEXT NOT NULL,
     deleted INTEGER NOT NULL DEFAULT 0,
     time INTEGER NOT NULL,
     window TEXT,
     event TEXT,
     anchor TEXT,
     refs TEXT,
     UNIQUE (note, revision)
   )`,

  // What windows cite, use as evidence and read. One event is recorded once,
  // so the unique index leaves the reads - which name no event - alone.
  `CREATE TABLE IF NOT EXISTS note_usage (
     note INTEGER NOT NULL,
     kind TEXT NOT NULL,
     weight REAL NOT NULL,
     window TEXT,
     event TEXT,
     time INTEGER NOT NULL
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS note_usage_event
     ON note_usage (note, kind, event) WHERE event IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS note_usage_time ON note_usage (time)`,

  // The refs every revision names: what it cites and what it holds as
  // evidence. `to_note` is set when the ref is a note, which is what makes the
  // evidence links between notes - the ones the credit walk follows.
  `CREATE TABLE IF NOT EXISTS note_refs (
     note INTEGER NOT NULL,
     revision INTEGER NOT NULL,
     kind TEXT NOT NULL,
     ref TEXT NOT NULL,
     to_note INTEGER,
     weight REAL NOT NULL,
     time INTEGER NOT NULL,
     PRIMARY KEY (note, revision, kind, ref)
   )`,
  `CREATE INDEX IF NOT EXISTS note_refs_ref ON note_refs (ref, weight DESC)`,

  `CREATE TABLE IF NOT EXISTS note_epochs (
     epoch INTEGER PRIMARY KEY AUTOINCREMENT,
     time INTEGER NOT NULL,
     wseq INTEGER NOT NULL,
     budget_count INTEGER NOT NULL,
     budget_tokens INTEGER NOT NULL
   )`,

  // The active notes one epoch froze, with the summaries it froze them at.
  `CREATE TABLE IF NOT EXISTS note_epoch_items (
     epoch INTEGER NOT NULL,
     note INTEGER NOT NULL,
     revision INTEGER NOT NULL,
     title TEXT NOT NULL,
     summary TEXT NOT NULL,
     tokens INTEGER NOT NULL,
     time INTEGER NOT NULL,
     PRIMARY KEY (epoch, note)
   )`,

  TRIGRAM_INDEX,
  WORD_INDEX,
];

interface NoteIndexRow {
  id: number;
  title: string;
  summary: string;
  body: string;
}

/**
 * Version 2 added the word index (docs/journal.md#search): a segmented word
 * index with BM25 beside the trigram index, which is what lets a multi-word
 * query find a note that holds the words apart from each other. Every note,
 * every ref and the trigram index stay, so a version-1 database opens where it
 * left off: the notes it already holds are segmented into the new index in the
 * same step that records the version, and a delete leaves a note out of it.
 */
function migrateToVersion2(db: DatabaseSync, segmenter: Segmenter): void {
  // One transaction: the index and the version that says it is there land
  // together, so a database that stops half way through is still the version it
  // was and migrates again, whole, instead of half-indexing twice.
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(WORD_INDEX);
    const insert = db.prepare(
      `INSERT INTO ${WORD_TABLE} (rowid, title, summary, body) VALUES (?, ?, ?, ?)`,
    );
    const rows = db
      .prepare("SELECT id, title, summary, body FROM notes WHERE status <> 'deleted'")
      .all() as unknown as NoteIndexRow[];
    for (const row of rows) {
      insert.run(
        Number(row.id),
        indexText(row.title, segmenter),
        indexText(row.summary, segmenter),
        indexText(row.body, segmenter),
      );
    }
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)").run(String(SCHEMA_VERSION));
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // The transaction is already gone; the original error is what matters.
    }
    throw error;
  }
}

/** Create the schema when it is missing, migrate an older one, and record the version. */
export function createSchema(db: DatabaseSync, segmenter: Segmenter = resolveSegmenter()): void {
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
      `notes schema ${version} is newer than this build (${SCHEMA_VERSION}); upgrade arbor, or migrate the database`,
    );
  }
  if (Number(version) === SCHEMA_VERSION - 1) migrateToVersion2(db, segmenter);
  for (const statement of STATEMENTS) db.exec(statement);
  if (version === null || Number(version) !== SCHEMA_VERSION) {
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)").run(String(SCHEMA_VERSION));
  }
}

export function readMeta(db: DatabaseSync, key: string): string | null {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row === undefined ? null : row.value;
}
