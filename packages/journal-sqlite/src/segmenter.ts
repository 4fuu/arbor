/**
 * Word segmentation for the journal's word index (docs/journal.md#search).
 *
 * The spec calls for jieba segmentation with BM25. A dictionary segmenter is a
 * native dependency and a data file, so the default here approximates it and
 * stays swappable: Chinese, Japanese and Korean runs are indexed per character
 * and per bigram, and every other script per word. A deployment that wants
 * jieba's dictionary implements `Segmenter` and registers it with the journal.
 *
 * Character and bigram indexing is what makes a two-character Chinese query
 * find the phrase it appears in, without a dictionary.
 */

import type { Segmenter } from "@arbor/interfaces";

/** CJK unified ideographs, extensions, compatibility, kana and hangul. */
function isCjk(codePoint: number): boolean {
  return (
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) ||
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0x3040 && codePoint <= 0x30ff) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7af) ||
    (codePoint >= 0x20000 && codePoint <= 0x2a6df) ||
    (codePoint >= 0x2a700 && codePoint <= 0x2ebef)
  );
}

/** Whitespace and punctuation separate words; everything else is part of one. */
const SEPARATOR = /[\s\p{P}\p{S}\p{C}\p{Z}]/u;

export const defaultSegmenter: Segmenter = {
  segment(text: string): string[] {
    const chars = Array.from(text);
    const tokens: string[] = [];
    let index = 0;
    while (index < chars.length) {
      const first = chars[index] as string;
      const codePoint = first.codePointAt(0) as number;
      if (isCjk(codePoint)) {
        const run: string[] = [];
        while (index < chars.length) {
          const char = chars[index] as string;
          const point = char.codePointAt(0) as number;
          if (!isCjk(point)) break;
          run.push(char);
          index += 1;
        }
        tokens.push(...run);
        for (let offset = 0; offset + 1 < run.length; offset += 1) {
          tokens.push((run[offset] as string) + (run[offset + 1] as string));
        }
        continue;
      }
      if (SEPARATOR.test(first)) {
        index += 1;
        continue;
      }
      const run: string[] = [];
      while (index < chars.length) {
        const char = chars[index] as string;
        const point = char.codePointAt(0) as number;
        if (isCjk(point) || SEPARATOR.test(char)) break;
        run.push(char);
        index += 1;
      }
      tokens.push(run.join("").toLowerCase());
    }
    return tokens;
  },
};

/** The text the word index stores: the segments, one per line. */
export function indexText(text: string, segmenter: Segmenter): string {
  return segmenter.segment(text).join("\n");
}
