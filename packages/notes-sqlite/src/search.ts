/**
 * Lexical search over notes (docs/journal.md#search, docs/memory.md).
 *
 * The channels the journal has, merged the same way, and one more when a
 * deployment installed it:
 *
 * - a word index, segmented and ranked with BM25 over title, summary and body,
 *   the title and the summary weighted above the body;
 * - a trigram index for exact substrings, which is what makes a Chinese
 *   substring findable;
 * - a `LIKE` scan, for one- and two-character queries, which have no trigram of
 *   their own;
 * - a semantic channel, note text embedded and searched by meaning, when
 *   `@4fu/arbor-search-zvec` is installed.
 *
 * Exact substring hits come first, then word hits that are not already there,
 * then the hits only the semantic channel found, each channel by its own
 * relevance. The `LIKE` scan has no relevance of its own, so it answers in id
 * order and a page is byte-stable however it is paged.
 */

import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { NoteStatus, Segmenter } from "@4fu/arbor-interfaces";
import {
  MIN_TRIGRAM_CHARS,
  escapeLike,
  likePattern,
  mergeHits,
  quoteFts,
  trigramMatch,
  wordMatch,
} from "@4fu/arbor-lexical";
import type { Ranked } from "@4fu/arbor-lexical";
import { FTS_TABLE, WORD_TABLE } from "./schema.ts";

export { MIN_TRIGRAM_CHARS, escapeLike, likePattern, quoteFts };

/**
 * The BM25 column weights both note indexes are ranked with, in the order the
 * FTS5 tables carry their columns: title, summary, body. The title names the
 * note and the summary is its one line, so a hit in either counts for more
 * than one in the body: ten times as much for the title, four times for the
 * summary.
 */
export const COLUMN_WEIGHTS = "10.0, 4.0, 1.0";

/** One condition over `notes n`, and the values it is bound to. */
export interface SubstringClause {
  sql: string;
  params: readonly SQLInputValue[];
}

/** The `LIKE` scan's condition, for a query the trigram index cannot answer. */
function likeClause(query: string): SubstringClause {
  const pattern = likePattern(query);
  return {
    sql: `(n.title LIKE ? ESCAPE '\\' OR n.summary LIKE ? ESCAPE '\\' OR n.body LIKE ? ESCAPE '\\')`,
    params: [pattern, pattern, pattern],
  };
}

/** The word index's condition: every one of the query's segments. */
function wordClause(tokens: readonly string[]): SubstringClause {
  return {
    sql: `n.id IN (SELECT rowid FROM ${WORD_TABLE} WHERE ${WORD_TABLE} MATCH ?)`,
    params: [wordMatch(tokens)],
  };
}

/** The notes holding the query as an exact substring, as a condition over `notes n`. */
export function substringClause(query: string): SubstringClause {
  if (Array.from(query).length >= MIN_TRIGRAM_CHARS) {
    return {
      sql: `n.id IN (SELECT rowid FROM ${FTS_TABLE} WHERE ${FTS_TABLE} MATCH ?)`,
      params: [trigramMatch(query)],
    };
  }
  return likeClause(query);
}

/** Every match from one index, by relevance, with the status filter applied. */
function ranked(db: DatabaseSync, table: string, match: string, status?: NoteStatus): Ranked[] {
  const filtered = status === undefined ? "" : " AND n.status = ?";
  const params: SQLInputValue[] = status === undefined ? [match] : [match, status];
  const rows = db
    .prepare(
      `SELECT f.rowid AS rowid, bm25(${table}, ${COLUMN_WEIGHTS}) AS rank
       FROM ${table} f JOIN notes n ON n.id = f.rowid
       WHERE ${table} MATCH ?${filtered}
       ORDER BY rank, f.rowid`,
    )
    .all(...params) as Array<{ rowid: number; rank: number }>;
  return rows.map((row) => ({ rowid: Number(row.rowid), rank: Number(row.rank) }));
}

/** The notes a one- or two-character query holds, in id order. */
function scanIds(db: DatabaseSync, query: string, status?: NoteStatus): number[] {
  const clause = likeClause(query);
  // A delete leaves the row and marks it, and the scan reads the notes table
  // itself, so it leaves the deleted ones out on its own (docs/memory.md).
  const filtered = status === undefined ? " AND n.status <> 'deleted'" : " AND n.status = ?";
  const rows = db
    .prepare(`SELECT n.id AS id FROM notes n WHERE ${clause.sql}${filtered} ORDER BY n.id`)
    .all(...clause.params, ...(status === undefined ? [] : [status])) as Array<{ id: number }>;
  return rows.map((row) => Number(row.id));
}

/**
 * The notes a text query matches, in the order search returns them: exact
 * substring hits first, then word hits that are not already there, each channel
 * by its own relevance, then the hits only the semantic channel found. A
 * one- or two-character query has no trigram and no word match of its own, so
 * the fallback scan answers it in id order, and the semantic channel's hits
 * follow it.
 *
 * `semantic` is the channel's own candidates as ranks, in the order it gave
 * them: the note store asks it for the notes nearest the query and applies its
 * own filters to what comes back, so a channel that filters less than the store
 * does still answers the read it was asked (docs/memory.md#search).
 */
export function matchedIds(
  db: DatabaseSync,
  query: string,
  segmenter: Segmenter,
  status?: NoteStatus,
  semantic: readonly Ranked[] = [],
): number[] {
  if (Array.from(query).length < MIN_TRIGRAM_CHARS) {
    // A one- or two-character query has no trigram and no word match of its
    // own: the scan answers it in id order, and the semantic channel's hits
    // follow it.
    const scanned: Ranked[] = scanIds(db, query, status).map((rowid) => ({ rowid, rank: 0 }));
    return mergeHits(
      { channel: "substring", hits: scanned },
      { channel: "semantic", hits: semantic },
    ).map((hit) => hit.rowid);
  }
  const substrings = ranked(db, FTS_TABLE, trigramMatch(query), status);
  const match = wordMatch(segmenter.segment(query));
  const words = match === "" ? [] : ranked(db, WORD_TABLE, match, status);
  return mergeHits(
    { channel: "substring", hits: substrings },
    { channel: "word", hits: words },
    { channel: "semantic", hits: semantic },
  ).map((hit) => hit.rowid);
}

/**
 * The ids of several notes that hold the query: an exact substring or the
 * query's words. `about` and `linked` bound a lookup to the notes the journal
 * resolved, in their own weight order, so this answers a set and not an order.
 */
export function holdingIds(
  db: DatabaseSync,
  query: string,
  ids: readonly number[],
  segmenter: Segmenter,
): number[] {
  if (ids.length === 0) return [];
  const clauses = [substringClause(query)];
  if (Array.from(query).length >= MIN_TRIGRAM_CHARS) {
    const tokens = segmenter.segment(query);
    if (wordMatch(tokens) !== "") clauses.push(wordClause(tokens));
  }
  const rows = db
    .prepare(
      `SELECT n.id AS id FROM notes n
       WHERE (${clauses.map((clause) => clause.sql).join(" OR ")})
         AND n.id IN (${ids.map(() => "?").join(", ")})
       ORDER BY n.id`,
    )
    .all(...clauses.flatMap((clause) => clause.params), ...ids) as Array<{ id: number }>;
  return rows.map((row) => Number(row.id));
}
