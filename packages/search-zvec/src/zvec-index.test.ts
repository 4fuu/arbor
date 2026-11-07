/**
 * The zvec semantic channel (docs/journal.md#search).
 *
 * These tests use a deterministic test embedder rather than a model, so the
 * channel's contract - what it indexes, what a filter keeps, what a redaction
 * erases, what survives a restart - is checked without a download. The tests
 * that need zvec's prebuilt binary skip with a message naming what is missing;
 * the ones that need the default embedding model are in embedder.test.ts.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { Embedder, SemanticFilters, SemanticIndex, WindowRef } from "@4fu/arbor-interfaces";
import { createZvecIndex, filterExpression } from "./zvec-index.ts";
import type { ZvecIndexOptions } from "./zvec-index.ts";
import { transformersInstalled } from "./embedder.ts";

/** zvec's own binding, which is what these tests need. */
const zvec = await import("@zvec/zvec").catch(() => null);
const missing = zvec === null ? "@zvec/zvec's prebuilt binary does not load on this platform" : "";

/** The concepts the test embedder knows, and the words that name each. */
const CONCEPTS: ReadonlyArray<{ id: string; words: readonly string[] }> = [
  { id: "payment", words: ["扣了", "付过", "付款", "支付", "回调", "payment"] },
  { id: "deploy", words: ["部署", "上线", "发布", "deploy", "release"] },
  { id: "certificate", words: ["证书", "握手", "certificate", "tls"] },
  { id: "database", words: ["数据库", "连接池", "database"] },
  { id: "meeting", words: ["会议室", "开会", "meeting"] },
];

/**
 * An embedder that knows the concepts above and nothing else, so a query and an
 * event that share a concept and no words still match - which is the whole point
 * of the channel. Every event here carries exactly one concept, so the nearest
 * neighbour is the event that holds the query's concept and the rest tie.
 */
function testEmbedder(): Embedder & { load(): Promise<void> } {
  let loaded = false;
  const embed = (texts: readonly string[]): readonly number[][] =>
    texts.map((text) => {
      const vector = CONCEPTS.map((concept) =>
        concept.words.some((word) => text.includes(word)) ? 1 : 0,
      );
      const norm = Math.sqrt(vector.reduce((sum: number, one) => sum + one * one, 0)) || 1;
      return vector.map((one) => one / norm);
    });
  return {
    dimension: CONCEPTS.length,
    async load(): Promise<void> {
      loaded = true;
    },
    async embed(texts: readonly string[]): Promise<readonly number[][]> {
      if (!loaded) throw new Error("the test embedder was not loaded");
      return embed(texts);
    },
  };
}

/** An embedder whose model cannot be fetched, and starts working when told. */
function unreachableEmbedder(): Embedder & { load(): Promise<void>; reachable: boolean } {
  const base = testEmbedder();
  const embedder = {
    dimension: CONCEPTS.length,
    reachable: false,
    async load(): Promise<void> {
      if (!embedder.reachable) throw new Error("huggingface.co is unreachable");
      await base.load();
    },
    async embed(texts: readonly string[]): Promise<readonly number[][]> {
      if (!embedder.reachable) throw new Error("huggingface.co is unreachable");
      return base.embed(texts);
    },
  };
  return embedder;
}

/** An embedder whose model takes as long as `release` says before it arrives. */
function slowEmbedder(): Embedder & { load(): Promise<void>; release(): void } {
  const base = testEmbedder();
  let arrive: (() => void) | null = null;
  const embedder = {
    dimension: CONCEPTS.length,
    async load(): Promise<void> {
      await new Promise<void>((resolve) => {
        arrive = resolve;
      });
      await base.load();
    },
    release(): void {
      arrive?.();
    },
    async embed(texts: readonly string[]): Promise<readonly number[][]> {
      return base.embed(texts);
    },
  };
  return embedder;
}

/** One indexed event. Each carries exactly one concept. */
const EVENTS: ReadonlyArray<{
  ref: `r${number}`;
  text: string;
  kind: string;
  window: WindowRef | null;
}> = [
  { ref: "r1", text: "网关把通知拦掉了，用户钱扣了订单还挂着", kind: "input", window: "c41" },
  { ref: "r2", text: "补一个重试队列比较稳妥", kind: "assistant", window: "c41" },
  { ref: "r3", text: "证书昨天到期了，客户端全部报错", kind: "input", window: "c52" },
  { ref: "r4", text: "连接池上限设得太低", kind: "assistant", window: "c52" },
  { ref: "r5", text: "约了 3 号会议室，日历邀请已经发出", kind: "assistant", window: null },
];

/** A query that shares no word with r1 and its payment concept with nothing else. */
const MEANING_QUERY = "付过款了却看不到变化";
/** A query that shares no word with r3 and its certificate concept with nothing else. */
const CERTIFICATE_QUERY = "tls 出问题之后所有请求都失败";

/** What a test may hand `createZvecIndex` besides the path and the embedder. */
type OpenOptions = Partial<Omit<ZvecIndexOptions, "path" | "embed">>;

function open(path: string, embed: Embedder, extra: OpenOptions = {}): SemanticIndex | null {
  return createZvecIndex({ path, embed, ...extra });
}

/** Wait for the channel to be ready: the model loads in the background. */
async function ready(index: SemanticIndex): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (await index.ready()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("the semantic channel never became ready");
}

async function indexed(): Promise<{ index: SemanticIndex; root: string }> {
  const root = mkdtempSync(join(tmpdir(), "arbor-zvec-"));
  const index = open(join(root, "vectors"), testEmbedder());
  assert.ok(index !== null);
  for (const event of EVENTS) {
    await index.add(event.ref, event.text, { kind: event.kind, window: event.window });
  }
  return { index, root };
}

/** Clean up a store and its channel. */
async function done(index: SemanticIndex, root: string): Promise<void> {
  await index.close();
  rmSync(root, { recursive: true, force: true });
}

describe("the zvec semantic channel", () => {
  it("finds an event by meaning when no word is shared", async (t) => {
    if (zvec === null) return t.skip(missing);
    const { index, root } = await indexed();
    try {
      await ready(index);
      // The query and r1 share no word; they share the payment concept, and no
      // other event carries it, so r1 is the only hit worth having.
      assert.deepEqual([...(await index.search(MEANING_QUERY, 1, {}))], ["r1"]);
      assert.deepEqual([...(await index.search(CERTIFICATE_QUERY, 1, {}))], ["r3"]);
    } finally {
      await done(index, root);
    }
  });

  it("applies the filters a read asked for", async (t) => {
    if (zvec === null) return t.skip(missing);
    const { index, root } = await indexed();
    try {
      await ready(index);
      const hit = (filters: SemanticFilters) => index.search(MEANING_QUERY, 1, filters);

      // A filter that keeps r1 leaves it first.
      assert.deepEqual([...(await hit({ kinds: ["input"] }))], ["r1"]);
      assert.deepEqual([...(await hit({ window: "c41" }))], ["r1"]);
      assert.deepEqual([...(await hit({ beforeSeq: 2 }))], ["r1"]);

      // A filter that takes r1 out takes the payment hit with it.
      assert.ok(!(await hit({ kinds: ["assistant"] })).includes("r1"));
      assert.ok(!(await hit({ window: "c52" })).includes("r1"));
      assert.ok(!(await hit({ afterSeq: 1 })).includes("r1"));

      // The sequence range reads the ref's number, which is the journal's order.
      assert.deepEqual([...(await index.search(CERTIFICATE_QUERY, 1, { afterSeq: 3 }))].includes("r3"), false);
      assert.deepEqual([...(await index.search(CERTIFICATE_QUERY, 1, { beforeSeq: 4 }))], ["r3"]);
    } finally {
      await done(index, root);
    }
  });

  it("keeps a filter's value that carries a quote as data", async (t) => {
    if (zvec === null) return t.skip(missing);
    const { index, root } = await indexed();
    try {
      await ready(index);
      await index.add("r6", "it's quoted", { kind: "in'put", window: "c1" });
      assert.deepEqual([...(await index.search(CERTIFICATE_QUERY, 5, { kinds: ["in'put"] }))], ["r6"]);
    } finally {
      await done(index, root);
    }
  });

  it("forgets an event's vector, as a redaction does", async (t) => {
    if (zvec === null) return t.skip(missing);
    const { index, root } = await indexed();
    try {
      await ready(index);
      assert.ok((await index.held()).has("r1"));
      await index.remove("r1");
      assert.ok(!(await index.held()).has("r1"));
      // The nearest neighbour is now whichever event ties for second, so the
      // payment event is gone from every page.
      assert.ok(!(await index.search(MEANING_QUERY, 5, {})).includes("r1"));
    } finally {
      await done(index, root);
    }
  });

  it("keeps what it indexed across a close and a reopen", async (t) => {
    if (zvec === null) return t.skip(missing);
    const { index, root } = await indexed();
    const store = join(root, "vectors");
    try {
      await ready(index);
      await index.close();

      const reopened = open(store, testEmbedder());
      assert.ok(reopened !== null);
      await ready(reopened);
      assert.deepEqual([...(await reopened.search(MEANING_QUERY, 1, {}))], ["r1"]);
      await reopened.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("holds what arrives while the model loads, and indexes it when it has", async (t) => {
    if (zvec === null) return t.skip(missing);
    const root = mkdtempSync(join(tmpdir(), "arbor-zvec-"));
    const embedder = slowEmbedder();
    const index = open(join(root, "vectors"), embedder);
    assert.ok(index !== null);
    try {
      // The model has not arrived, so nothing is embedded and nothing is stored,
      // and a search answers nothing rather than waiting for the download.
      await index.add("r1", EVENTS[0]!.text, { kind: "input", window: "c41" });
      await index.add("r2", EVENTS[1]!.text, { kind: "assistant", window: "c41" });
      assert.equal(await index.ready(), false);
      assert.deepEqual([...(await index.search(MEANING_QUERY, 1, {}))], []);
      assert.deepEqual([...(await index.held())], []);

      embedder.release();
      await ready(index);
      assert.deepEqual([...(await index.held())].sort(), ["r1", "r2"]);
      assert.deepEqual([...(await index.search(MEANING_QUERY, 1, {}))], ["r1"]);
    } finally {
      await done(index, root);
    }
  });

  it("stays lexical after a fetch that failed, warns once, and retries later", async (t) => {
    if (zvec === null) return t.skip(missing);
    const root = mkdtempSync(join(tmpdir(), "arbor-zvec-"));
    const warnings: string[] = [];
    const embedder = unreachableEmbedder();
    let now = 0;
    const index = open(join(root, "vectors"), embedder, {
      warn: (message: string) => warnings.push(message),
      now: () => now,
      retryAfterMs: 1_000,
    });
    assert.ok(index !== null);
    try {
      await index.add("r1", EVENTS[0]!.text, { kind: "input", window: "c41" });
      assert.equal(await index.ready(), false, "a fetch that failed leaves the channel lexical");
      assert.deepEqual([...(await index.search(MEANING_QUERY, 1, {}))], []);
      assert.equal(warnings.length, 1, "one warning per failed attempt, not one per call");
      assert.match(warnings[0] ?? "", /embedding model is not available/);
      assert.match(warnings[0] ?? "", /search stays lexical/);

      // Inside the retry window nothing is tried again, however much is asked.
      now = 500;
      await index.add("r2", EVENTS[1]!.text, { kind: "assistant", window: "c41" });
      assert.equal(await index.ready(), false);
      assert.equal(warnings.length, 1);

      // Past it, a model that can be fetched flips the channel and indexes
      // everything it held while it could not.
      now = 2_000;
      embedder.reachable = true;
      await index.add("r3", EVENTS[2]!.text, { kind: "input", window: "c52" });
      await ready(index);
      assert.equal(warnings.length, 1, "the warning names the failure, not every retry");
      assert.deepEqual([...(await index.held())].sort(), ["r1", "r2", "r3"]);
      assert.deepEqual([...(await index.search(CERTIFICATE_QUERY, 1, {}))], ["r3"]);
    } finally {
      await done(index, root);
    }
  });

  it("answers no channel when no embedding model is available", async (t) => {
    if (zvec === null) return t.skip(missing);
    if (transformersInstalled()) {
      return t.skip("@huggingface/transformers is installed here, so the default model is available");
    }
    const root = mkdtempSync(join(tmpdir(), "arbor-zvec-"));
    try {
      assert.equal(createZvecIndex({ path: join(root, "vectors") }), null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a second host on the same store, with one writer per data directory", async (t) => {
    if (zvec === null) return t.skip(missing);
    const { index, root } = await indexed();
    const warnings: string[] = [];
    try {
      await ready(index);
      const second = open(join(root, "vectors"), testEmbedder(), {
        warn: (message: string) => warnings.push(message),
      });
      assert.equal(second, null, "one host owns the collection's LOCK");
      assert.match(warnings[0] ?? "", /held by another host/);
      assert.match(warnings[0] ?? "", /search stays lexical/);
    } finally {
      await done(index, root);
    }
  });
});

describe("the filter a semantic search builds", () => {
  it("names only the filters it was given", () => {
    assert.equal(filterExpression({}), undefined);
    assert.equal(filterExpression({ afterSeq: 5 }), "seq > 5");
    assert.equal(filterExpression({ beforeSeq: 5 }), "seq < 5");
    assert.equal(filterExpression({ afterSeq: 2, beforeSeq: 9 }), "seq > 2 AND seq < 9");
    assert.equal(filterExpression({ kinds: ["input"] }), "kind = 'input'");
    assert.equal(filterExpression({ kinds: ["input", "send"] }), "kind IN ('input', 'send')");
    assert.equal(filterExpression({ window: "c41" }), "window = 'c41'");
    assert.equal(
      filterExpression({ window: "c41", kinds: ["input"], afterSeq: 1, beforeSeq: 9 }),
      "seq > 1 AND seq < 9 AND kind = 'input' AND window = 'c41'",
    );
  });

  it("keeps a value that carries a quote inside the expression", () => {
    assert.equal(filterExpression({ kinds: ["in'put"] }), "kind = 'in\\'put'");
    assert.equal(filterExpression({ kinds: ["in'put", "it's"] }), "kind IN ('in\\'put', 'it\\'s')");
  });
});
