import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Segmenter } from "@4fu/arbor-interfaces";
import { fallbackSegmenter, indexText, resolveSegmenter } from "./index.ts";

/** What a store resolves when the caller names no segmenter. */
const resolved = resolveSegmenter();

describe("fallback segmenter", () => {
  it("indexes a Chinese run per character and per bigram", () => {
    assert.deepEqual(fallbackSegmenter.segment("部署上线"), ["部", "署", "上", "线", "部署", "署上", "上线"]);
  });

  it("indexes Latin text per word, folded to lower case", () => {
    assert.deepEqual(fallbackSegmenter.segment("Deploy NOTES"), ["deploy", "notes"]);
  });

  it("keeps a bigram inside one run and never across a separator", () => {
    assert.deepEqual(fallbackSegmenter.segment("你好，世界"), [
      "你",
      "好",
      "你好",
      "世",
      "界",
      "世界",
    ]);
  });

  it("splits on punctuation and whitespace", () => {
    assert.deepEqual(fallbackSegmenter.segment("cart_total (new)"), ["cart", "total", "new"]);
    assert.deepEqual(fallbackSegmenter.segment("部署 deploy"), ["部", "署", "部署", "deploy"]);
  });

  it("indexes nothing for text with no word characters", () => {
    assert.deepEqual(fallbackSegmenter.segment(" ，。!! "), []);
    assert.equal(indexText(" ，。!! ", fallbackSegmenter), "");
  });

  it("puts one segment on each line for the word index", () => {
    assert.equal(indexText("部署上线", fallbackSegmenter), "部\n署\n上\n线\n部署\n署上\n上线");
  });
});

describe("segmenter resolution", () => {
  it("resolves jieba when the package loads", {
    skip: resolved === fallbackSegmenter ? "@4fu/arbor-segmenter-jieba is not installed, or does not load here" : false,
  }, () => {
    // The workspace installs the optional peer, so the default segments with
    // the dictionary: two words, not the seven character and bigram segments
    // the approximation gives for the same text.
    assert.deepEqual(resolved.segment("部署上线"), ["部署", "上线"]);
  });

  it("falls back when jieba cannot be loaded", () => {
    const missing = (): Segmenter | null => {
      throw new Error("Cannot find module '@4fu/arbor-segmenter-jieba'");
    };

    assert.equal(resolveSegmenter(missing), fallbackSegmenter);
  });

  it("falls back when the package is installed but holds no segmenter", () => {
    const withoutOne = (): Segmenter | null => null;
    assert.equal(resolveSegmenter(withoutOne), fallbackSegmenter);
  });
});
