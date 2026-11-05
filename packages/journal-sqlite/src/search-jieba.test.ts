/**
 * Search with the jieba segmenter (docs/journal.md#search).
 *
 * `@arbor/segmenter-jieba` is an optional peer, so it is loaded at run time and
 * these tests skip when it is not installed: the approximation's tests in
 * search.test.ts are the ones that run then.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Segmenter } from "@arbor/interfaces";
import { fallbackSegmenter } from "./segmenter.ts";
import { SqliteJournal } from "./sqlite-journal.ts";

let jieba: Segmenter | null = null;
try {
  jieba = (await import("@arbor/segmenter-jieba")).jiebaSegmenter;
} catch {
  jieba = null;
}

async function fixture(): Promise<SqliteJournal> {
  const journal = new SqliteJournal({ path: ":memory:", segmenter: jieba ?? fallbackSegmenter });
  await journal.append({
    kind: "input",
    window: "c1",
    body: "部署上线流程已确认",
    targets: ["qq:group:1"],
  });
  await journal.append({
    kind: "input",
    window: "c2",
    body: "部署服务并上线检查",
    targets: ["qq:group:2"],
  });
  await journal.append({
    kind: "tool_result",
    window: "c1",
    body: "cart total checkout failed",
    targets: ["file:src/cart.ts"],
  });
  await journal.append({
    kind: "input",
    window: "c3",
    body: "the cart is empty and the total is unknown",
    targets: ["qq:group:3"],
  });
  await journal.append({
    kind: "input",
    window: "c1",
    body: "部署，上线完成",
    targets: ["qq:group:1"],
  });
  return journal;
}

describe("search with the jieba segmenter", {
  skip: jieba === null ? "@arbor/segmenter-jieba is not installed" : false,
}, () => {
  it("finds a Chinese phrase where it appears, and the words elsewhere", async () => {
    const journal = await fixture();
    const page = await journal.search("部署上线");

    // r1 holds the phrase; r2 and r5 hold both words with other text between
    // them, which the word index answers and a character index cannot. The
    // shorter of the two ranks first.
    assert.equal(page.total, 3);
    assert.equal(page.items[0]?.ref, "r1");
    assert.equal(page.items[0]?.match, "substring");
    assert.deepEqual(
      page.items.slice(1).map((hit) => hit.ref),
      ["r5", "r2"],
    );
    assert.deepEqual(
      page.items.slice(1).map((hit) => hit.match),
      ["word", "word"],
    );
  });

  it("answers a two-word query in any order, without the phrase", async () => {
    const journal = await fixture();
    const page = await journal.search("检查 部署");

    // r2 holds both words with text between them and no phrase to find, so
    // this is the word index alone.
    assert.equal(page.total, 1);
    assert.equal(page.items[0]?.ref, "r2");
    assert.equal(page.items[0]?.match, "word");
  });

  it("matches a query that carries punctuation", async () => {
    const journal = await fixture();
    const page = await journal.search("部署，上线");

    // The punctuation is not a word, so the words still have to be there and
    // the query does not collapse to nothing.
    assert.equal(page.total, 3);
    assert.equal(page.items[0]?.ref, "r5");
    assert.equal(page.items[0]?.match, "substring");
  });

  it("finds Latin text whatever its case", async () => {
    const journal = await fixture();

    const upper = await journal.search("CHECKOUT");
    assert.equal(upper.total, 1);
    assert.equal(upper.items[0]?.ref, "r3");

    const lower = await journal.search("cart");
    assert.equal(lower.total, 2);
  });

  it("ranks the document that is about the query above one that mentions it", async () => {
    const journal = new SqliteJournal({
      path: ":memory:",
      segmenter: jieba ?? fallbackSegmenter,
    });
    await journal.append({ kind: "input", window: "c1", body: "部署上线" });
    await journal.append({
      kind: "input",
      window: "c2",
      body: "无关内容无关内容无关内容无关内容部署服务并上线检查",
    });

    // The space keeps the trigram index out of it, so this is the word index.
    const page = await journal.search("部署 上线");
    assert.equal(page.total, 2);
    assert.deepEqual(
      page.items.map((hit) => hit.match),
      ["word", "word"],
    );
    assert.equal(page.items[0]?.ref, "r1");
    assert.ok((page.items[0]?.score ?? 0) > (page.items[1]?.score ?? 0));
  });

  it("finds a one-character query with the substring fallback, newest first", async () => {
    const journal = await fixture();
    const page = await journal.search("署");

    assert.deepEqual(
      page.items.map((hit) => hit.ref),
      ["r5", "r2", "r1"],
    );
  });

  it("treats FTS5 syntax in a query as data, never as an operator", async () => {
    const journal = await fixture();

    assert.equal((await journal.search("cart OR zebra")).total, 0);
    assert.equal((await journal.search('"部署"')).total, 3);
    assert.equal((await journal.search("cart*")).total, 2);
  });

  it("does not find a redacted event", async () => {
    const journal = await fixture();
    await journal.redact("r1", "personal data");

    assert.equal((await journal.search("部署上线")).total, 2);
    assert.equal((await journal.search("部署")).total, 2);
  });
});
