/**
 * Lexical search over the journal's events (docs/journal.md#search).
 *
 * Three indexes, merged:
 *
 * - a word index, segmented and ranked with BM25;
 * - a trigram index for exact substrings, which is what makes a Chinese
 *   substring findable;
 * - a substring scan, for one- and two-character queries and for queries the
 *   trigram index cannot answer.
 *
 * Exact substring hits come first, then word hits that are not already there.
 */

import type { DatabaseSync, SQLInputValue } from "node:sqlite";

export interface SearchFilters {
  kinds?: readonly string[];
  window?: string;
  targets?: readonly string[];
  external?: string;
  afterSeq?: number;
  beforeSeq?: number;
}

/** One matching row, with its raw relevance. Lower `rank` is better. */
export interface Ranked {
  seq: number;
  rank: number;
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
      `SELECT f.rowid AS seq, bm25(${table}) AS rank
       FROM ${table} f JOIN events e ON e.seq = f.rowid
       WHERE ${table} MATCH ?${built.sql}
       ORDER BY rank, f.rowid`,
    )
    .all(match, ...built.params) as Array<{ seq: number; rank: number }>;
  return rows.map((row) => ({ seq: Number(row.seq), rank: Number(row.rank) }));
}

/** Every substring match, newest first. The scan has no relevance of its own. */
export function substring(db: DatabaseSync, pattern: string, filters: SearchFilters): Ranked[] {
  const built = buildFilters(filters);
  const rows = db
    .prepare(
      `SELECT e.seq AS seq, 1.0 AS rank FROM events e
       WHERE e.body LIKE ? ESCAPE '\\'${built.sql}
       ORDER BY e.seq DESC`,
    )
    .all(pattern, ...built.params) as Array<{ seq: number; rank: number }>;
  return rows.map((row) => ({ seq: Number(row.seq), rank: Number(row.rank) }));
}

/** Escape a literal for `LIKE ... ESCAPE '\'`. */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

export function likePattern(query: string): string {
  return `%${escapeLike(query)}%`;
}

/** Quote one term for an FTS5 `MATCH`, so outside text is never syntax. */
export function quoteFts(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

/** The trigram index takes one phrase. */
export function trigramMatch(query: string): string {
  return quoteFts(query);
}

/** The word index takes the query's segments, all of them required. */
export function wordMatch(tokens: readonly string[]): string {
  return tokens
    .filter((token) => token.length > 0)
    .map(quoteFts)
    .join(" ");
}
