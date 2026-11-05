import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { jiebaSegmenter } from "./segmenter.ts";

describe("jieba segmenter", () => {
  it("segments Chinese text with the dictionary, not per character", () => {
    assert.deepEqual(jiebaSegmenter.segment("部署上线流程已确认"), [
      "部署",
      "上线",
      "流程",
      "已",
      "确认",
    ]);
  });

  it("cuts a long word into the words inside it, for search", () => {
    assert.deepEqual(jiebaSegmenter.segment("中华人民共和国万岁"), [
      "中华",
      "华人",
      "人民",
      "共和",
      "共和国",
      "中华人民共和国",
      "万岁",
    ]);
  });

  it("keeps Latin words and numbers whole", () => {
    assert.deepEqual(jiebaSegmenter.segment("订单 12345 已支付"), [
      "订单",
      "12345",
      "已",
      "支付",
    ]);
  });

  it("drops punctuation and spaces, which are not words", () => {
    assert.deepEqual(jiebaSegmenter.segment("cart_total (new)"), ["cart", "total", "new"]);
    assert.deepEqual(jiebaSegmenter.segment("部署，上线"), ["部署", "上线"]);
    assert.deepEqual(jiebaSegmenter.segment(" ，。!! "), []);
  });

  it("segments nothing for empty text", () => {
    assert.deepEqual(jiebaSegmenter.segment(""), []);
  });
});
