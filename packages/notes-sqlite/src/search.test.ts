import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fallbackSegmenter } from "@4fu/arbor-lexical";
import { SqliteJournal } from "@4fu/arbor-journal-sqlite";
import { SqliteNoteStore } from "./notes.ts";

// The fixture pins the fallback segmenter, so these hold whether or not the
// optional jieba package is installed; search-jieba.test.ts covers the other
// one.
async function fixture(): Promise<SqliteNoteStore> {
  const journal = new SqliteJournal({ path: ":memory:", segmenter: fallbackSegmenter });
  const store = new SqliteNoteStore({ journal, segmenter: fallbackSegmenter });
  await store.write({ title: "部署上线", body: "第一批内容", summary: "上线流程" });
  await store.write({ title: "部署服务并上线检查", body: "第二批内容", summary: "运维" });
  await store.write({ title: "cart total checkout", body: "第三批内容", summary: "结账失败" });
  await store.write({ title: "the cart is empty and the total is unknown", body: "第四批内容", summary: "无关" });
  await store.write({ title: "标点用例", body: "第五批内容", summary: "部署，上线完成" });
  return store;
}

/** A store and its journal, both on the fallback segmenter and one fixed clock. */
function fixedStore(now: () => number): SqliteNoteStore {
  const journal = new SqliteJournal({ path: ":memory:", segmenter: fallbackSegmenter, now });
  return new SqliteNoteStore({ journal, segmenter: fallbackSegmenter, now });
}

describe("search", () => {
  it("finds a multi-word query only the word index answers", async () => {
    const store = await fixture();
    const page = await store.search({ query: "检查 部署" });

    // n2 holds both words with other text between them and no phrase to find;
    // n1 and n5 hold one word each, so they are not hits. A substring search
    // answers nothing here, because no note holds the query as it stands.
    assert.equal(page.total, 1);
    assert.equal(page.items[0]?.id, "n2");
    assert.equal(page.items[0]?.title, "部署服务并上线检查");
  });

  it("puts an exact substring hit before a word hit", async () => {
    const store = await fixture();
    const page = await store.search({ query: "cart total" });

    // n3 holds the phrase; n4 holds both words with other text between them,
    // which only the word index answers.
    assert.equal(page.total, 2);
    assert.equal(page.items[0]?.id, "n3");
    assert.equal(page.items[1]?.id, "n4");
  });

  it("finds a Chinese phrase only where it appears", async () => {
    const store = await fixture();
    const page = await store.search({ query: "部署上线" });

    // n2 and n5 hold the words but not the phrase, so they are not hits.
    assert.equal(page.total, 1);
    assert.equal(page.items[0]?.id, "n1");
  });

  it("searches through punctuation, and merges the substring hit first", async () => {
    const store = await fixture();
    const page = await store.search({ query: "署，上线" });

    // n5 holds the punctuated phrase; n1 and n2 hold the characters with other
    // text between them, which the word index answers.
    assert.equal(page.total, 3);
    assert.equal(page.items[0]?.id, "n5");
    assert.deepEqual(
      page.items.slice(1).map((item) => item.id),
      ["n1", "n2"],
    );
  });

  it("ranks the note that is about the query above one that mentions it", async () => {
    const store = fixedStore(() => 0);
    await store.write({ title: "部署上线", body: "简短" });
    await store.write({ title: "无关", body: "无关内容无关内容无关内容无关内容部署上线" });

    const page = await store.search({ query: "部署 上线" });
    assert.equal(page.total, 2);
    assert.equal(page.items[0]?.id, "n1");
    assert.equal(page.items[1]?.id, "n2");
  });

  it("ranks a hit in the title above one in the summary, and that above one in the body", async () => {
    const store = fixedStore(() => 0);
    // The three notes differ only in where the words are: the weights, not the
    // length of the field, are what order them.
    await store.write({ title: "部署上线", summary: "无关", body: "很多其他的内容很多其他的内容" });
    await store.write({ title: "无关", summary: "部署上线", body: "很多其他的内容很多其他的内容" });
    await store.write({ title: "无关", summary: "无关", body: "很多其他的内容部署上线" });

    const page = await store.search({ query: "部署 上线" });
    assert.deepEqual(
      page.items.map((item) => item.id),
      ["n1", "n2", "n3"],
    );
  });

  it("finds a one- or two-character query with the substring fallback, in id order", async () => {
    const store = await fixture();

    // The scan has no relevance of its own, so it answers in id order.
    const two = await store.search({ query: "部署" });
    assert.equal(two.total, 3);
    assert.deepEqual(
      two.items.map((item) => item.id),
      ["n1", "n2", "n5"],
    );
    const one = await store.search({ query: "署" });
    assert.deepEqual(
      one.items.map((item) => item.id),
      ["n1", "n2", "n5"],
    );
    assert.equal((await store.search({ query: "找不到" })).total, 0);
  });

  it("finds an archived note as well as an active one", async () => {
    const store = fixedStore(() => 0);
    await store.write({ title: "部署上线", body: "one" });
    await store.write({ title: "部署文档", body: "two" });
    await store.recordUse({ ref: "n1", kind: "cite", event: "r1", weight: 1 });

    // n1 is in the active set; n2 was never used, so it stays archived.
    const snapshot = await store.snapshot({ minIntervalMs: 0 });
    assert.deepEqual(
      snapshot.items.map((item) => item.id),
      ["n1"],
    );

    // Search is not the active set: both notes answer.
    const page = await store.search({ query: "部署" });
    assert.deepEqual(
      page.items.map((item) => item.id),
      ["n1", "n2"],
    );
  });

  it("drops a deleted note out of both indexes", async () => {
    const store = await fixture();
    await store.write({ title: "部署上线", body: "", id: "n1", delete: true, expectedRevision: 1 });

    // n5 holds the punctuated phrase and n2 holds the characters apart, so both
    // channels still answer; n1 answers neither any more.
    assert.deepEqual(
      (await store.search({ query: "署，上线" })).items.map((item) => item.id),
      ["n5", "n2"],
    );
    assert.deepEqual(
      (await store.search({ query: "部署" })).items.map((item) => item.id),
      ["n2", "n5"],
    );
  });

  it("pages a ranked search the same way however it is paged", async () => {
    const store = await fixture();

    const page = await store.search({ query: "署，上线", limit: 1 });
    assert.equal(page.total, 3);
    assert.equal(page.limit, 1);
    assert.equal(page.items[0]?.id, "n5");
    assert.equal(page.nextCall, 'notes.search(query="署，上线", offset=1)');

    const rest = await store.search({ query: "署，上线", limit: 1, offset: 1 });
    assert.equal(rest.items[0]?.id, "n1");
    // The same query, asked again, answers in the same order.
    assert.deepEqual(
      (await store.search({ query: "署，上线" })).items.map((item) => item.id),
      ["n5", "n1", "n2"],
    );
  });

  it("treats FTS5 syntax in a query as data, never as an operator", async () => {
    const store = await fixture();

    // Quotes are literal text for the trigram index and separators for the
    // word index, so the words inside them still have to be there.
    assert.equal((await store.search({ query: '"部署"' })).total, 3);
    // An operator read as one would widen this to every note.
    assert.equal((await store.search({ query: "部署 OR 找不到" })).total, 0);
  });

  it("keeps the status filter over the merged channels", async () => {
    const store = await fixture();

    assert.equal((await store.search({ query: "部署", status: "active" })).total, 0);
    assert.deepEqual(
      (await store.search({ query: "署，上线", status: "archived" })).items.map((item) => item.id),
      ["n5", "n1", "n2"],
    );
  });

  it("indexes and queries with one segmenter when the caller names none", async () => {
    // jieba when the optional package is installed, the approximation
    // otherwise. Either way the two words find the note that holds them apart,
    // which they would not if indexing and querying used different segmenters.
    const journal = new SqliteJournal({ path: ":memory:" });
    const store = new SqliteNoteStore({ journal });
    await store.write({ title: "a", body: "部署服务并上线检查" });

    const page = await store.search({ query: "检查 部署" });
    assert.equal(page.total, 1);
    assert.equal(page.items[0]?.id, "n1");
  });
});
