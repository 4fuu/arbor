/**
 * Note search with the jieba segmenter (docs/journal.md#search).
 *
 * `@4fu/arbor-segmenter-jieba` is an optional peer, so it is loaded at run time and
 * these tests skip when it is not installed: the approximation's tests in
 * search.test.ts are the ones that run then.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Segmenter } from "@4fu/arbor-interfaces";
import { fallbackSegmenter } from "@4fu/arbor-lexical";
import { SqliteJournal } from "@4fu/arbor-journal-sqlite";
import { SqliteNoteStore } from "./notes.ts";

let jieba: Segmenter | null = null;
try {
  jieba = (await import("@4fu/arbor-segmenter-jieba")).jiebaSegmenter;
} catch {
  jieba = null;
}

async function fixture(): Promise<SqliteNoteStore> {
  const journal = new SqliteJournal({ path: ":memory:", segmenter: jieba ?? fallbackSegmenter });
  const store = new SqliteNoteStore({ journal, segmenter: jieba ?? fallbackSegmenter });
  await store.write({ title: "部署上线", body: "第一批内容", summary: "流程已确认" });
  await store.write({ title: "部署服务并上线检查", body: "第二批内容", summary: "运维" });
  await store.write({ title: "cart total checkout", body: "第三批内容", summary: "结账" });
  return store;
}

describe("search with the jieba segmenter", {
  skip: jieba === null ? "@4fu/arbor-segmenter-jieba is not installed" : false,
}, () => {
  it("finds a Chinese phrase where it appears, and the words elsewhere", async () => {
    const store = await fixture();
    const page = await store.search({ query: "部署上线" });

    // n1 holds the phrase; n2 holds both words with other text between them,
    // which the word index answers and a character index cannot.
    assert.equal(page.total, 2);
    assert.equal(page.items[0]?.id, "n1");
    assert.equal(page.items[1]?.id, "n2");
  });

  it("answers a two-word query in any order, without the phrase", async () => {
    const store = await fixture();
    const page = await store.search({ query: "检查 部署" });

    // n2 holds both words with text between them and no phrase to find, so
    // this is the word index alone.
    assert.equal(page.total, 1);
    assert.equal(page.items[0]?.id, "n2");
  });

  it("ranks the note that is about the query above one that mentions it", async () => {
    const journal = new SqliteJournal({ path: ":memory:", segmenter: jieba ?? fallbackSegmenter });
    const store = new SqliteNoteStore({ journal, segmenter: jieba ?? fallbackSegmenter });
    await store.write({ title: "部署上线", body: "简短" });
    await store.write({ title: "无关", body: "无关内容无关内容无关内容无关内容部署服务并上线检查" });

    // The space keeps the trigram index out of it, so this is the word index.
    const page = await store.search({ query: "部署 上线" });
    assert.equal(page.total, 2);
    assert.equal(page.items[0]?.id, "n1");
    assert.equal(page.items[1]?.id, "n2");
  });

  it("finds Latin text whatever its case", async () => {
    const store = await fixture();

    assert.equal((await store.search({ query: "CHECKOUT" })).total, 1);
    assert.equal((await store.search({ query: "cart" })).total, 1);
  });
});
