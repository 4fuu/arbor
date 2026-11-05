/**
 * Lexical search over notes (docs/journal.md#search, docs/memory.md).
 *
 * Lists show summaries and never bodies, so note search is a lookup of the
 * notes whose title, summary or body holds the query as an exact substring:
 * the trigram index answers three characters and more, which is what makes a
 * Chinese substring findable, and a `LIKE` scan answers a one- or
 * two-character query, which has no trigram of its own. Results come back in id
 * order, so a page is byte-stable however it is paged.
 */

import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { FTS_TABLE } from "./schema.ts";

/** A query shorter than this cannot use the trigram index. */
export const MIN_TRIGRAM_CHARS = 3;

/** One condition over `notes n`, and the values it is bound to. */
export interface SubstringClause {
  sql: string;
  params: readonly SQLInputValue[];
}

/** The notes holding the query, as a condition over `notes n`. */
export function substringClause(query: string): SubstringClause {
  if (Array.from(query).length >= MIN_TRIGRAM_CHARS) {
    return {
      sql: `n.id IN (SELECT rowid FROM ${FTS_TABLE} WHERE ${FTS_TABLE} MATCH ?)`,
      params: [quoteFts(query)],
    };
  }
  const pattern = likePattern(query);
  return {
    sql: `(n.title LIKE ? ESCAPE '\\' OR n.summary LIKE ? ESCAPE '\\' OR n.body LIKE ? ESCAPE '\\')`,
    params: [pattern, pattern, pattern],
  };
}

/** The ids of several notes that hold the query, by id. */
export function holdingIds(db: DatabaseSync, query: string, ids: readonly number[]): number[] {
  if (ids.length === 0) return [];
  const clause = substringClause(query);
  const rows = db
    .prepare(
      `SELECT n.id AS id FROM notes n
       WHERE ${clause.sql} AND n.id IN (${ids.map(() => "?").join(", ")})
       ORDER BY n.id`,
    )
    .all(...clause.params, ...ids) as unknown as Array<{ id: number }>;
  return rows.map((row) => Number(row.id));
}

/** Escape a literal for `LIKE ... ESCAPE '\'`. */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

export function likePattern(query: string): string {
  return `%${escapeLike(query)}%`;
}

/** Quote one phrase for an FTS5 `MATCH`, so outside text is never syntax. */
export function quoteFts(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}
