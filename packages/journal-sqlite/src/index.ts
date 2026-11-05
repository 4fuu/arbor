/**
 * @arbor/journal-sqlite - the default `Journal` and `BlobStore`.
 */

export { SqliteJournal, deriveLinks, parseEventRef, eventRefOf, summaryOf } from "./sqlite-journal.ts";
export type { SqliteJournalOptions } from "./sqlite-journal.ts";

export { FsBlobStore, blobIdOf, blobRefOf } from "./blob-store.ts";
export type { BlobEntry, BlobRegistry } from "./blob-store.ts";

export { defaultSegmenter, indexText } from "./segmenter.ts";

export {
  SCHEMA_VERSION,
  IMPLICIT_CITE_WEIGHT,
  TRIGRAM_TABLE,
  WORD_TABLE,
  createSchema,
} from "./schema.ts";

export {
  buildFilters,
  escapeLike,
  likePattern,
  quoteFts,
  ranked,
  substring,
  trigramMatch,
  wordMatch,
} from "./search.ts";
export type { FilterSql, Ranked, SearchFilters } from "./search.ts";

export { MIN_TRIGRAM_CHARS } from "./sqlite-journal.ts";
