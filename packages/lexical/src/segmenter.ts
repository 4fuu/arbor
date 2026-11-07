/**
 * Word segmentation for the word index (docs/journal.md#search).
 *
 * The spec calls for jieba segmentation with BM25, and the default is jieba
 * when `@4fu/arbor-segmenter-jieba` is installed: `resolveSegmenter` loads it, and
 * a store that keeps a word index uses what it returns when the caller names no
 * segmenter. The package is an optional peer dependency, so a deployment that
 * leaves it out keeps working.
 *
 * What is left here is the approximation that answers when jieba is not there:
 * Chinese, Japanese and Korean runs are indexed per character and per bigram,
 * and every other script per word. Character and bigram indexing is what makes
 * a two-character Chinese query find the phrase it appears in, without a
 * dictionary.
 */

import { createRequire } from "node:module";
import type { Segmenter } from "@4fu/arbor-interfaces";

/** The package that holds the jieba segmenter, when a deployment installed it. */
const JIEBA_PACKAGE = "@4fu/arbor-segmenter-jieba";

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

export const fallbackSegmenter: Segmenter = {
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

/**
 * Load the jieba segmenter, or `null` when it is not there: the package is not
 * installed, or it holds no segmenter.
 */
function loadJieba(): Segmenter | null {
  const require = createRequire(import.meta.url);
  const loaded: unknown = require(JIEBA_PACKAGE);
  const candidate = (loaded as { jiebaSegmenter?: unknown } | null)?.jiebaSegmenter;
  if (candidate === null || typeof candidate !== "object") return null;
  const shape = candidate as { segment?: unknown };
  return typeof shape.segment === "function" ? (candidate as Segmenter) : null;
}

/**
 * The segmenter a store uses when the caller names none: jieba when the
 * package is installed, the per-character-and-bigram approximation otherwise.
 * `load` replaces how the jieba package is loaded. A host that resolves modules
 * its own way passes its own; so does a test that has no jieba package to load.
 * A load that fails falls back rather than stopping the store, because the
 * package is optional: it may be missing, or its prebuilt binary may not load
 * on this platform.
 */
export function resolveSegmenter(load: () => Segmenter | null = loadJieba): Segmenter {
  try {
    return load() ?? fallbackSegmenter;
  } catch {
    return fallbackSegmenter;
  }
}

/** The text the word index stores: the segments, one per line. */
export function indexText(text: string, segmenter: Segmenter): string {
  return segmenter.segment(text).join("\n");
}
