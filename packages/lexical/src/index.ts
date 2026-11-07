/**
 * @4fu/arbor-lexical - the lexical search the journal and notes share.
 */

export { fallbackSegmenter, resolveSegmenter, indexText } from "./segmenter.ts";

export {
  MIN_TRIGRAM_CHARS,
  escapeLike,
  likePattern,
  quoteFts,
  trigramMatch,
  wordMatch,
  mergeHits,
} from "./search.ts";
export type { ChannelHits, MergedHit, Ranked, SearchChannel } from "./search.ts";
