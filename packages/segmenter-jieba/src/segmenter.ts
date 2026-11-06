/**
 * Word segmentation for the journal's word index (docs/journal.md#search):
 * jieba's dictionary, which is what the spec asks for.
 *
 * `@node-rs/jieba` is the binding: a Rust crate published through napi-rs,
 * which ships a prebuilt binary per platform as an optional dependency, so
 * installing it needs no compiler and no build step. It loads through
 * Node-API, which is stable across Node versions, and it is maintained, unlike
 * the alternatives: a WASM binding installs just as easily but is a smaller
 * project, and `nodejieba` builds from source, which would put a toolchain in
 * the journal's dependency tree.
 *
 * Text is cut in jieba's search mode: a long word is also cut into the words
 * inside it, so a query for one of those words still finds the text that holds
 * the whole word. The dictionary is jieba's own and is loaded once.
 */

import { Jieba } from "@node-rs/jieba";
import { dict } from "@node-rs/jieba/dict.js";
import type { Segmenter } from "@4fu/arbor-interfaces";

/**
 * A token with no letter and no digit holds no word: it is punctuation or
 * space. Dropping it is what keeps a query that carries punctuation matching,
 * because the word index requires every one of a query's segments.
 */
const HAS_WORD = /[\p{L}\p{N}]/u;

const jieba = Jieba.withDict(dict);

export const jiebaSegmenter: Segmenter = {
  segment(text: string): string[] {
    return jieba.cutForSearch(text).filter((token) => HAS_WORD.test(token));
  },
};
