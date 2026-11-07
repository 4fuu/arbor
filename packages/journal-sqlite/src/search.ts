/**
 * Lexical search over the journal's events (docs/journal.md#search).
 *
 * Three indexes, and a fourth channel when a deployment installed one:
 *
 * - a word index, segmented and ranked with BM25;
 * - a trigram index for exact substrings, which is what makes a Chinese
 *   substring findable;
 * - a substring scan, for one- and two-character queries and for queries the
 *   trigram index cannot answer;
 * - a semantic channel, event text embedded and searched by meaning, when
 *   `@4fu/arbor-search-zvec` is installed.
 *
 * What the journal and the notes store share - how a literal is quoted and
 * escaped, how a query becomes one index's match, and how the channels merge -
 * lives in `@4fu/arbor-lexical`. What lives here is what is the journal's own:
 * the filters a read applies, and reading the rows an index matched.
 */

import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { WindowRef } from "@4fu/arbor-interfaces";
import { MIN_TRIGRAM_CHARS, likePattern, quoteFts, trigramMatch, wordMatch } from "@4fu/arbor-lexical";
import type { Ranked } from "@4fu/arbor-lexical";

export { MIN_TRIGRAM_CHARS, likePattern, quoteFts, trigramMatch, wordMatch };

export interface SearchFilters {
  kinds?: readonly string[];
  window?: WindowRef;
  targets?: readonly string[];
  external?: string;
  afterSeq?: number;
  beforeSeq?: number;
}

export interface FilterSql {
  sql: string;
  params: SQLInputValue[];
}

/**
 * The filters a read applies, as SQL over `events e`. A target filter is an
 * `EXISTS`, so one event with three targets still counts once.
 */
export function buildFilters(filters: SearchFilters): FilterSql {
  const clauses: string[] = [];
  const params: SQLInputValue[] = [];

  if (filters.kinds !== undefined && filters.kinds.length > 0) {
    clauses.push(`AND e.kind IN (${filters.kinds.map(() => "?").join(", ")})`);
    params.push(...filters.kinds);
  }
  if (filters.window !== undefined) {
    clauses.push("AND e.window = ?");
    params.push(filters.window);
  }
  if (filters.external !== undefined) {
    clauses.push("AND e.external = ?");
    params.push(filters.external);
  }
  for (const target of filters.targets ?? []) {
    clauses.push(
      "AND EXISTS (SELECT 1 FROM event_targets et WHERE et.seq = e.seq AND et.target = ?)",
    );
    params.push(target);
  }
  if (filters.afterSeq !== undefined) {
    clauses.push("AND e.seq > ?");
    params.push(filters.afterSeq);
  }
  if (filters.beforeSeq !== undefined) {
    clauses.push("AND e.seq < ?");
    params.push(filters.beforeSeq);
  }

  return { sql: clauses.length === 0 ? "" : ` ${clauses.join(" ")}`, params };
}

/** Every match from one FTS5 index, ordered by relevance. */
export function ranked(
  db: DatabaseSync,
  table: string,
  match: string,
  filters: SearchFilters,
): Ranked[] {
  const built = buildFilters(filters);
  const rows = db
    .prepare(
      `SELECT f.rowid AS rowid, bm25(${table}) AS rank
       FROM ${table} f JOIN events e ON e.seq = f.rowid
       WHERE ${table} MATCH ?${built.sql}
       ORDER BY rank, f.rowid`,
    )
    .all(match, ...built.params) as Array<{ rowid: number; rank: number }>;
  return rows.map((row) => ({ rowid: Number(row.rowid), rank: Number(row.rank) }));
}

/** Every substring match, newest first. The scan has no relevance of its own. */
export function substring(db: DatabaseSync, pattern: string, filters: SearchFilters): Ranked[] {
  const built = buildFilters(filters);
  const rows = db
    .prepare(
      `SELECT e.seq AS rowid, 1.0 AS rank FROM events e
       WHERE e.body LIKE ? ESCAPE '\\'${built.sql}
       ORDER BY e.seq DESC`,
    )
    .all(pattern, ...built.params) as Array<{ rowid: number; rank: number }>;
  return rows.map((row) => ({ rowid: Number(row.rowid), rank: Number(row.rank) }));
}
