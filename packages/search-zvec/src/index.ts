/**
 * @4fu/arbor-search-zvec - the optional semantic search channel.
 *
 * `@4fu/arbor-journal-sqlite` takes this package as an optional peer: installed,
 * event text is embedded and searched by meaning beside the lexical indexes;
 * absent, or when zvec's native binary does not load on the platform, or when no
 * embedding model is available, search is exactly what it is without it
 * (docs/journal.md#search). See README.md for what a deployment configures.
 */

export { createZvecIndex, filterExpression } from "./zvec-index.ts";
export type { ZvecIndexOptions } from "./zvec-index.ts";

export { localEmbedder, transformersInstalled, DEFAULT_MODEL } from "./embedder.ts";
export type { LocalEmbedder, LocalEmbedderOptions } from "./embedder.ts";
