/**
 * The pieces of lexical search every store shares (docs/journal.md#search).
 *
 * All text search is lexical and built for Chinese and mixed text: a word index
 * by jieba segmentation with BM25, a trigram index for exact substrings, and a
 * fallback for one- or two-character queries. Results are merged, exact
 * substring hits first, and then by relevance.
 *
 * What lives here is what that model needs and no store should own alone: how a
 * literal is quoted for an FTS5 `MATCH` and escaped for `LIKE`, how a query
 * becomes one index's match, and how the channels are merged. Each store keeps
 * its own schema, its own filters and its own read of the rows a match names.
 */

import type { MatchKind } from "@4fu/arbor-interfaces";

/** A query shorter than this cannot use the trigram index. */
export const MIN_TRIGRAM_CHARS = 3;

/**
 * Which channel a match came from, and the `match` a hit carries. The two
 * lexical channels are `substring` and `word`; `semantic` is the one a store adds
 * when a deployment gave it an embedding channel (docs/journal.md#search).
 */
export type SearchChannel = MatchKind;

/** One match from one index, with its raw relevance. Lower `rank` is better. */
export interface Ranked {
  /** The row the index matched: an event's `seq`, a note's `id`. */
  rowid: number;
  rank: number;
}

/** One index's matches, named by the channel they are merged as. */
export interface ChannelHits {
  channel: SearchChannel;
  hits: readonly Ranked[];
}

/** One merged match, with the channel it came from and its relevance in 0..1. */
export interface MergedHit {
  rowid: number;
  channel: SearchChannel;
  /** Relevance within the match's own channel; higher is better. */
  score: number;
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

/**
 * Merge the channels the way lexical search does: the first channel's hits
 * first, then the next channel's hits that are not already there. Each channel
 * keeps the order it arrives in, which is its own relevance order - the query
 * that fills a channel orders it - and a row two channels found stays where the
 * first one put it. The channels are named at the call site in the order they
 * merge, so a later one - a vector index, say - plugs in as one more argument
 * and nothing here changes.
 *
 * A store with a semantic channel names it last, so the vector channel adds the
 * hits no lexical index found and never moves one it did.
 */
export function mergeHits(...channels: readonly ChannelHits[]): MergedHit[] {
  const seen = new Set<number>();
  const merged: MergedHit[] = [];
  for (const { channel, hits } of channels) {
    if (hits.length === 0) continue;
    const best = Math.min(...hits.map((hit) => hit.rank));
    for (const hit of hits) {
      if (seen.has(hit.rowid)) continue;
      seen.add(hit.rowid);
      merged.push({ rowid: hit.rowid, channel, score: normalize(hit.rank, best) });
    }
  }
  return merged;
}

/** Relevance in 0..1 within one channel; higher is better. */
function normalize(rank: number, best: number): number {
  if (best === 0) return 1;
  return Math.max(0, Math.min(1, rank / best));
}
