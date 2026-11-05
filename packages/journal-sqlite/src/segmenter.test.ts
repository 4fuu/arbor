import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { defaultSegmenter, indexText } from "./segmenter.ts";

describe("default segmenter", () => {
  it("indexes a Chinese run per character and per bigram", () => {
    assert.deepEqual(defaultSegmenter.segment("部署上线"), ["部", "署", "上", "线", "部署", "署上", "上线"]);
  });

  it("indexes Latin text per word, folded to lower case", () => {
    assert.deepEqual(defaultSegmenter.segment("Deploy NOTES"), ["deploy", "notes"]);
  });

  it("keeps a bigram inside one run and never across a separator", () => {
    assert.deepEqual(defaultSegmenter.segment("你好，世界"), [
      "你",
      "好",
      "你好",
      "世",
      "界",
      "世界",
    ]);
  });

  it("splits on punctuation and whitespace", () => {
    assert.deepEqual(defaultSegmenter.segment("cart_total (new)"), ["cart", "total", "new"]);
    assert.deepEqual(defaultSegmenter.segment("部署 deploy"), ["部", "署", "部署", "deploy"]);
  });

  it("indexes nothing for text with no word characters", () => {
    assert.deepEqual(defaultSegmenter.segment(" ，。!! "), []);
    assert.equal(indexText(" ，。!! ", defaultSegmenter), "");
  });

  it("puts one segment on each line for the word index", () => {
    assert.equal(indexText("部署上线", defaultSegmenter), "部\n署\n上\n线\n部署\n署上\n上线");
  });
});
