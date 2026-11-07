/**
 * The semantic channel the note store takes (docs/memory.md#search).
 *
 * These tests drive the store through its public interface with a
 * `SemanticIndex` of their own, so the contract - when the channel is consulted,
 * how its results merge, what a delete erases, what a replace replaces, what a
 * catch-up indexes - is checked without a model and without zvec. The real
 * channel is tested in `@4fu/arbor-search-zvec`; the last describe here runs the
 * store over it with a deterministic embedder, and skips when the package or its
 * prebuilt binary is not there.
 */

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type {
  NoteQuery,
  Ref,
  SemanticFilters,
  SemanticIndex,
} from "@4fu/arbor-interfaces";
import { fallbackSegmenter } from "@4fu/arbor-lexical";
import { SqliteJournal } from "@4fu/arbor-journal-sqlite";
import { SqliteNoteStore } from "./notes.ts";
import { resolveSemanticIndex } from "./semantic.ts";

/** The package that holds the zvec semantic index, when a deployment installed it. */
const ZVEC_PACKAGE = "@4fu/arbor-search-zvec";

/** What that package exports, as far as these tests read it. */
interface SemanticIndexPackage {
  createZvecIndex?: ZvecFactory;
}

/** The channel's factory, as far as these tests call it. */
type ZvecFactory = (options: { path: string; embed?: unknown }) => SemanticIndex | null;

/**
 * The optional channel's factory, or `null` when there is none: the package is
 * not installed, or zvec's prebuilt binary does not load on this platform. It is
 * loaded the way the store loads it, so these tests skip rather than fail when
 * the optional peer is not there.
 */
function loadChannel(): ZvecFactory | null {
  try {
    const require = createRequire(import.meta.url);
    const loaded: unknown = require(ZVEC_PACKAGE);
    const create = (loaded as SemanticIndexPackage | null)?.createZvecIndex;
    return typeof create === "function" ? create : null;
  } catch {
    return null;
  }
}

const createZvecIndex = loadChannel();
const missing =
  createZvecIndex === null
    ? `${ZVEC_PACKAGE} is not installed, or @zvec/zvec's prebuilt binary does not load on this platform`
    : "";

/** The concepts the test channel knows, and the words that name each. */
const CONCEPTS: ReadonlyArray<{ id: string; words: readonly string[] }> = [
  { id: "payment", words: ["扣了", "付过", "付款", "支付", "回调", "payment"] },
  { id: "deploy", words: ["部署", "上线", "发布", "deploy", "release"] },
  { id: "certificate", words: ["证书", "握手", "certificate", "tls"] },
  { id: "database", words: ["数据库", "连接池", "database"] },
  { id: "meeting", words: ["会议室", "开会", "meeting"] },
];

function vectorOf(text: string): number[] {
  const vector = CONCEPTS.map((concept) => (concept.words.some((word) => text.includes(word)) ? 1 : 0));
  const norm = Math.sqrt(vector.reduce((sum: number, one) => sum + one * one, 0)) || 1;
  return vector.map((one) => one / norm);
}

const dot = (a: readonly number[], b: readonly number[]) =>
  a.reduce((sum: number, one, index) => sum + one * (b[index] ?? 0), 0);

/** A semantic channel that knows the concepts above, in memory. */
class TestChannel implements SemanticIndex {
  readonly added: Array<{ ref: Ref; text: string }> = [];
  readonly removed: Ref[] = [];
  readonly searches: Array<{ query: string; limit: number; filters: SemanticFilters }> = [];
  private readonly vectors = new Map<Ref, number[]>();
  usable = true;

  async add(ref: Ref, text: string): Promise<void> {
    this.added.push({ ref, text });
    this.vectors.set(ref, vectorOf(text));
  }

  async remove(ref: Ref): Promise<void> {
    this.removed.push(ref);
    this.vectors.delete(ref);
  }

  async search(
    query: string,
    limit: number,
    filters: SemanticFilters,
  ): Promise<readonly Ref[]> {
    this.searches.push({ query, limit, filters });
    if (!this.usable) return [];
    const queryVector = vectorOf(query);
    return [...this.vectors.entries()]
      .map(([ref, vector]) => ({ ref, score: dot(queryVector, vector) }))
      .sort((a, b) => b.score - a.score || a.ref.localeCompare(b.ref))
      .slice(0, limit)
      .map((one) => one.ref);
  }

  async ready(): Promise<boolean> {
    return this.usable;
  }

  async held(): Promise<ReadonlySet<Ref>> {
    return new Set(this.vectors.keys());
  }

  async close(): Promise<void> {}
}

/**
 * A store with the fixture's notes, and the channel it was given. Every note
 * carries exactly one concept, so the nearest neighbour is the note that holds
 * the query's concept and the rest tie. Two notes carry the payment concept, so
 * a note whose text is replaced stops being the payment hit while the other one
 * stays it.
 */
async function storeWith(
  semantic: SemanticIndex | null,
): Promise<{ store: SqliteNoteStore; channel: TestChannel | null }> {
  const journal = new SqliteJournal({ path: ":memory:", segmenter: fallbackSegmenter });
  const store = new SqliteNoteStore({ journal, segmenter: fallbackSegmenter, semantic });
  await store.write({ title: "网关拦掉了通知", summary: "用户反馈", body: "用户钱扣了订单还挂着" });
  await store.write({ title: "重试队列", summary: "待办", body: "补一个重试队列比较稳妥" });
  await store.write({ title: "客户端报错", summary: "握手失败", body: "昨天刚更新过配置" });
  await store.write({ title: "连接池", summary: "上限太低", body: "数据库查询经常超时" });
  await store.write({ title: "证书到期", summary: "待办", body: "记得续期" });
  await store.write({ title: "支付回调没到", summary: "对账差异", body: "用户付过款了订单还挂着" });
  return { store, channel: semantic instanceof TestChannel ? semantic : null };
}

/** A query that shares no word with n1 and its payment concept with n6 alone. */
const MEANING_QUERY = "付过款了却看不到变化";

/** A query that shares no word with the notes and their database concept with two. */
const DATABASE_QUERY = "连接池打满之后查询排队";

/** The ids a search answers, in the order it answers them. */
async function ids(store: SqliteNoteStore, query: NoteQuery = {}): Promise<string[]> {
  return (await store.search(query)).items.map((item) => item.id);
}

describe("the note store's semantic channel", () => {
  it("indexes each note's title, summary and body as it is written", async () => {
    const channel = new TestChannel();
    const { store } = await storeWith(channel);
    try {
      assert.deepEqual(
        channel.added.map((one) => one.ref),
        ["n1", "n2", "n3", "n4", "n5", "n6"],
      );
      // One vector per note, over the three fields the lexical index weights,
      // in that order: the title names the note and the body is its content.
      assert.equal(
        channel.added[0]?.text,
        "网关拦掉了通知\n用户反馈\n用户钱扣了订单还挂着",
      );
    } finally {
      await store.close();
    }
  });

  it("searches exactly lexically when no channel is registered", async () => {
    const { store } = await storeWith(null);
    try {
      // Nothing finds the payment note by meaning, which is what the channel is
      // for; the lexical indexes answer what they always answered.
      assert.equal((await store.search({ query: MEANING_QUERY })).total, 0);
      assert.equal((await store.search({ query: "证书" })).total, 1);
    } finally {
      await store.close();
    }
  });

  it("finds a note by meaning, after the lexical hits", async () => {
    const channel = new TestChannel();
    const { store } = await storeWith(channel);
    try {
      const page = await store.search({ query: MEANING_QUERY });
      assert.equal(page.items[0]?.id, "n1", "the note that means the query comes first");
      // The channel answers candidates, not certainties, so the notes it ranked
      // below the hit are in the page too.
      assert.ok(page.total > 1);

      // An exact substring hit keeps its place in front of a semantic one: n5
      // holds the query verbatim, and the channel ranks n3 first. The two- and
      // the four-character query take the scan and the trigram index
      // respectively, so both merges are checked.
      const both = await store.search({ query: "证书" });
      assert.deepEqual(
        both.items.map((item) => item.id),
        ["n5", "n3", "n1", "n2", "n4", "n6"],
      );
      const phrase = await store.search({ query: "证书到期" });
      assert.deepEqual(
        phrase.items.map((item) => item.id),
        ["n5", "n3", "n1", "n2", "n4", "n6"],
      );
      // The channel was asked for candidates, and the read's own filters are
      // the store's to apply.
      const asked = channel.searches.at(-1);
      assert.deepEqual(asked?.filters, {});
      assert.ok((asked?.limit ?? 0) >= 10, "a page of one still fuses a handful of candidates");
    } finally {
      await store.close();
    }
  });

  it("keeps the read's own filters over the semantic channel's hits", async () => {
    const { store } = await storeWith(new TestChannel());
    try {
      // n1 is the payment note and it is archived, so a status filter that takes
      // archived notes out takes the hit with it.
      assert.deepEqual(await ids(store, { query: MEANING_QUERY, status: "active" }), []);
      assert.equal((await ids(store, { query: MEANING_QUERY, status: "archived" }))[0], "n1");

      // `about` and `linked` bound a read to the notes the journal resolved, and
      // the channel does not widen that bound: no note is about this target.
      assert.deepEqual(await ids(store, { query: MEANING_QUERY, about: "file:src/other.ts" }), []);
      assert.deepEqual(await ids(store, { query: MEANING_QUERY, about: "n2" }), []);
    } finally {
      await store.close();
    }
  });

  it("erases the note's vector when the note is deleted", async () => {
    const channel = new TestChannel();
    const { store } = await storeWith(channel);
    try {
      await store.write({
        id: "n1",
        title: "网关拦掉了通知",
        body: "",
        delete: true,
        expectedRevision: 1,
      });
      assert.deepEqual(channel.removed, ["n1"]);
      assert.ok(!(await ids(store, { query: MEANING_QUERY })).includes("n1"), "the note is not a hit");
      assert.ok(!(await channel.held()).has("n1"));
      // The other notes stay searchable, lexically and by meaning.
      assert.equal((await ids(store, { query: "证书" }))[0], "n5");
    } finally {
      await store.close();
    }
  });

  it("replaces the note's vector when its revision is replaced", async () => {
    const channel = new TestChannel();
    const { store } = await storeWith(channel);
    try {
      await store.write({
        id: "n1",
        title: "连接池调优",
        summary: "数据库",
        body: "连接池上限设得太低",
        expectedRevision: 1,
      });

      // The payment meaning is gone with the text that carried it: the page of
      // one is now the other payment note, and the database meaning the note
      // now has answers instead.
      const payment = await store.search({ query: MEANING_QUERY, limit: 1 });
      assert.equal(payment.items[0]?.id, "n6", "the replaced note is not the payment hit");
      assert.equal((await ids(store, { query: DATABASE_QUERY }))[0], "n1");
      // One vector per note: the replace replaced it rather than adding to it,
      // and what it holds is the note's current text.
      assert.deepEqual(
        channel.added.filter((one) => one.ref === "n1").map((one) => one.text),
        ["网关拦掉了通知\n用户反馈\n用户钱扣了订单还挂着", "连接池调优\n数据库\n连接池上限设得太低"],
      );
      assert.deepEqual([...(await channel.held())].filter((ref) => ref === "n1"), ["n1"]);
    } finally {
      await store.close();
    }
  });

  it("indexes what the channel is missing after a restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "arbor-notes-"));
    const path = join(directory, "notes.db");
    const journal = new SqliteJournal({ path: ":memory:", segmenter: fallbackSegmenter });
    const first = new SqliteNoteStore({ path, journal, segmenter: fallbackSegmenter });
    await first.write({ title: "证书到期", summary: "待办", body: "记得续期" });
    await first.close();

    // A second host over the same database, with a channel that starts empty:
    // the notes are there, the vectors are not.
    const channel = new TestChannel();
    const second = new SqliteNoteStore({
      path,
      journal,
      segmenter: fallbackSegmenter,
      semantic: channel,
    });
    try {
      assert.equal(channel.added.length, 0, "the notes are in the database, the vectors are not");
      assert.equal(await second.catchUpSemantic(), 1);
      assert.deepEqual(
        channel.added.map((one) => one.ref),
        ["n1"],
      );
      assert.deepEqual([...(await channel.held())], ["n1"]);
    } finally {
      await second.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("catches up on a search when the channel is not ready yet", async () => {
    const channel = new TestChannel();
    const { store } = await storeWith(channel);
    try {
      channel.usable = false;
      assert.equal((await store.search({ query: MEANING_QUERY })).total, 0, "a channel not ready answers nothing");
      channel.usable = true;
      assert.equal((await ids(store, { query: MEANING_QUERY }))[0], "n1", "it catches up once it is ready");
    } finally {
      await store.close();
    }
  });

  it("keeps a write working when the channel refuses", async () => {
    const channel = new TestChannel();
    const { store } = await storeWith(channel);
    try {
      const original = channel.add.bind(channel);
      channel.add = async () => {
        throw new Error("the store refused");
      };
      const note = await store.write({ title: "又一条", summary: "新", body: "新内容" });
      assert.equal(note.ref, "n7@1");
      // The note is searchable lexically, and a catch-up indexes it later.
      assert.equal((await ids(store, { query: "又一条" }))[0], "n7");
      channel.add = original;
      assert.equal(await store.catchUpSemantic(), 1);
      assert.ok((await channel.held()).has("n7"));
    } finally {
      await store.close();
    }
  });

  it("closes the channel with the store", async () => {
    let closed = 0;
    const channel = new TestChannel();
    const original = channel.close.bind(channel);
    channel.close = async () => {
      closed += 1;
      await original();
    };
    const { store } = await storeWith(channel);
    await store.close();
    assert.equal(closed, 1);
  });

  it("pages a search the same way however it is paged", async () => {
    const { store } = await storeWith(new TestChannel());
    try {
      // A query the scan and the channel both answer, so the order mixes them.
      const all = await store.search({ query: "证书" });
      assert.equal(all.total, 6);

      const paged: string[] = [];
      for (let offset = 0; offset < all.total; offset += 1) {
        const page = await store.search({ query: "证书", limit: 1, offset });
        paged.push(...page.items.map((item) => item.id));
      }
      assert.deepEqual(
        paged,
        all.items.map((item) => item.id),
      );
    } finally {
      await store.close();
    }
  });
});

describe("the semantic channel a note store resolves for itself", () => {
  it("falls back to none when the package is not installed", () => {
    assert.equal(resolveSemanticIndex("/tmp/arbor-none", () => null), null);
    assert.equal(
      resolveSemanticIndex("/tmp/arbor-none", () => {
        throw new Error("the prebuilt binary does not load here");
      }),
      null,
    );
  });

  it("uses what the loader hands back", () => {
    const channel = new TestChannel();
    assert.equal(resolveSemanticIndex("/tmp/arbor-none", () => channel), channel);
  });
});

/**
 * The store over the channel itself, with a deterministic embedder: the note id
 * is the channel's ref, one vector per note survives a close and a reopen, and a
 * search over a real collection answers the way the in-memory one does.
 */
describe("the note store over the zvec channel", () => {
  /** The embedder the real channel is opened with, and the store's own notes. */
  const CONCEPT_EMBEDDER = {
    dimension: CONCEPTS.length,
    async embed(texts: readonly string[]): Promise<readonly number[][]> {
      return texts.map(vectorOf);
    },
  };

  function open(path: string): SemanticIndex | null {
    if (createZvecIndex === null) return null;
    return createZvecIndex({ path, embed: CONCEPT_EMBEDDER });
  }

  /** Wait for the channel to be ready: the model loads in the background. */
  async function ready(index: SemanticIndex): Promise<void> {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      if (await index.ready()) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("the semantic channel never became ready");
  }

  it("finds a note by meaning, and keeps an exact hit in front of it", async (t) => {
    if (createZvecIndex === null) return t.skip(missing);
    const root = mkdtempSync(join(tmpdir(), "arbor-notes-"));
    const channel = open(join(root, "vectors"));
    assert.ok(channel !== null);
    const store = new SqliteNoteStore({
      path: join(root, "notes.db"),
      journal: new SqliteJournal({ path: ":memory:", segmenter: fallbackSegmenter }),
      segmenter: fallbackSegmenter,
      semantic: channel,
    });
    try {
      // n1 means the certificate query without holding a word of it; n2 holds
      // the query verbatim and means it as well.
      await store.write({ title: "握手失败", summary: "客户端报错", body: "昨天刚更新过配置" });
      await store.write({ title: "网关拦掉了通知", summary: "用户反馈", body: "用户钱扣了订单还挂着" });
      await store.write({ title: "证书到期", summary: "待办", body: "记得续期" });
      await ready(channel);
      assert.equal((await ids(store, { query: MEANING_QUERY }))[0], "n2");
      assert.deepEqual(await ids(store, { query: "证书到期" }), ["n3", "n1", "n2"]);
    } finally {
      await store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps the vectors across a close and a reopen of the collection", async (t) => {
    if (createZvecIndex === null) return t.skip(missing);
    const root = mkdtempSync(join(tmpdir(), "arbor-notes-"));
    const path = join(root, "notes.db");
    const vectors = join(root, "vectors");
    const journal = new SqliteJournal({ path: ":memory:", segmenter: fallbackSegmenter });
    const firstChannel = open(vectors);
    assert.ok(firstChannel !== null);
    const first = new SqliteNoteStore({
      path,
      journal,
      segmenter: fallbackSegmenter,
      semantic: firstChannel,
    });
    try {
      await first.write({ title: "网关拦掉了通知", summary: "用户反馈", body: "用户钱扣了订单还挂着" });
      await ready(firstChannel);
    } finally {
      await first.close();
    }

    // A second host over the same database and the same collection: the notes
    // are there and so are the vectors, so a catch-up indexes nothing.
    const secondChannel = open(vectors);
    assert.ok(secondChannel !== null);
    const second = new SqliteNoteStore({
      path,
      journal,
      segmenter: fallbackSegmenter,
      semantic: secondChannel,
    });
    try {
      await ready(secondChannel);
      assert.equal(await second.catchUpSemantic(), 0);
      assert.equal((await ids(second, { query: MEANING_QUERY }))[0], "n1");
    } finally {
      await second.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
