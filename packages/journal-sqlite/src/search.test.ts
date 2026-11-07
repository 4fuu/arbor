import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SqliteJournal } from "./sqlite-journal.ts";
import { fallbackSegmenter } from "@4fu/arbor-lexical";

// The fixture pins the approximation, so these hold whether or not the optional
// jieba package is installed; search-jieba.test.ts covers the other one.
async function fixture(): Promise<SqliteJournal> {
  const journal = new SqliteJournal({ path: ":memory:", segmenter: fallbackSegmenter });
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

describe("search", () => {
  it("puts an exact substring hit before a word hit", async () => {
    const journal = await fixture();
    const page = await journal.search("cart total");

    assert.equal(page.total, 2);
    assert.equal(page.items[0]?.ref, "r3");
    assert.equal(page.items[0]?.match, "substring");
    assert.equal(page.items[0]?.window, "c1");
    assert.equal(page.items[0]?.summary, "cart total checkout failed");
    assert.equal(page.items[1]?.ref, "r4");
    assert.equal(page.items[1]?.match, "word");
  });

  it("finds a Chinese phrase only where it appears", async () => {
    const journal = await fixture();
    const page = await journal.search("部署上线");

    // r2 and r5 hold the words but not the phrase, so they are not hits.
    assert.equal(page.total, 1);
    assert.equal(page.items[0]?.ref, "r1");
    assert.equal(page.items[0]?.match, "substring");
    assert.equal(page.items[0]?.window, "c1");
  });

  it("finds a one- or two-character query with the substring fallback, newest first", async () => {
    const journal = await fixture();
    const page = await journal.search("部署");

    assert.equal(page.total, 3);
    assert.deepEqual(
      page.items.map((hit) => hit.ref),
      ["r5", "r2", "r1"],
    );
    assert.deepEqual(
      page.items.map((hit) => hit.match),
      ["substring", "substring", "substring"],
    );
  });

  it("searches through punctuation, and merges the substring hit first", async () => {
    const journal = await fixture();
    const page = await journal.search("署，上");

    assert.equal(page.total, 3);
    assert.equal(page.items[0]?.ref, "r5");
    assert.equal(page.items[0]?.match, "substring");
    assert.deepEqual(
      page.items.slice(1).map((hit) => hit.match),
      ["word", "word"],
    );
    assert.deepEqual(new Set(page.items.slice(1).map((hit) => hit.ref)), new Set(["r1", "r2"]));

    const latin = await journal.search("checkout");
    assert.equal(latin.total, 1);
    assert.equal(latin.items[0]?.ref, "r3");
  });

  it("ranks the document that is about the query above one that only mentions it", async () => {
    const journal = new SqliteJournal({ path: ":memory:", segmenter: fallbackSegmenter });
    await journal.append({ kind: "input", window: "c1", body: "部署上线" });
    await journal.append({
      kind: "input",
      window: "c2",
      body: "无关内容无关内容无关内容无关内容部署上线",
    });

    const page = await journal.search("部署上线");
    assert.equal(page.total, 2);
    assert.equal(page.items[0]?.ref, "r1");
    assert.ok((page.items[0]?.score ?? 0) > (page.items[1]?.score ?? 0));
  });

  it("filters by kind, target, window and sequence range", async () => {
    const journal = await fixture();

    const byKind = await journal.search("部署", { kinds: ["tool_result"] });
    assert.equal(byKind.total, 0);

    const byWindow = await journal.search("部署", { window: "c2" });
    assert.equal(byWindow.total, 1);
    assert.equal(byWindow.items[0]?.ref, "r2");

    const byTarget = await journal.search("cart", { targets: ["file:src/cart.ts"] });
    assert.equal(byTarget.total, 1);
    assert.equal(byTarget.items[0]?.ref, "r3");

    const after = await journal.search("部署", { afterSeq: 1 });
    assert.deepEqual(
      after.items.map((hit) => hit.ref),
      ["r5", "r2"],
    );

    const before = await journal.search("部署", { beforeSeq: 3 });
    assert.deepEqual(
      before.items.map((hit) => hit.ref),
      ["r2", "r1"],
    );
  });

  it("reports the bound and the call that pages the rest", async () => {
    const journal = await fixture();
    const page = await journal.search("部署", { limit: 1 });

    assert.equal(page.total, 3);
    assert.equal(page.limit, 1);
    assert.equal(page.items.length, 1);
    assert.equal(page.nextCall, 'journal.search("部署", offset=1)');

    const next = await journal.search("部署", { limit: 1, offset: 1 });
    assert.equal(next.items[0]?.ref, "r2");
  });

  it("treats FTS5 syntax in a query as data, never as an operator", async () => {
    const journal = await fixture();

    // An operator that were read as one would widen this to every event.
    assert.equal((await journal.search("cart OR zebra")).total, 0);

    // Quotes and wildcards are literal text: the words inside them still match.
    assert.equal((await journal.search('"部署"')).total, 3);
    assert.equal((await journal.search("cart*")).total, 2);
  });

  it("returns an empty page for an empty query", async () => {
    const journal = await fixture();
    const page = await journal.search("   ");
    assert.equal(page.total, 0);
    assert.deepEqual(page.items, []);
    assert.equal(page.limit, 20);
  });

  it("does not find a redacted event", async () => {
    const journal = await fixture();
    await journal.redact("r1", "personal data");
    assert.equal((await journal.search("部署上线")).total, 0);
    assert.equal((await journal.search("部署")).total, 2);
  });

  it("indexes and queries with one segmenter when the caller names none", async () => {
    // jieba when the optional package is installed, the approximation
    // otherwise. Either way the two words find the text that holds them, which
    // they would not if indexing and querying used different segmenters.
    const journal = new SqliteJournal({ path: ":memory:" });
    await journal.append({ kind: "input", window: "c1", body: "部署上线" });

    const page = await journal.search("部署 上线");
    assert.equal(page.total, 1);
    assert.equal(page.items[0]?.ref, "r1");
    assert.equal(page.items[0]?.match, "word");
  });
});
