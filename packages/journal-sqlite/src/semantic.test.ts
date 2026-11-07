/**
 * The semantic channel the journal takes (docs/journal.md#search).
 *
 * These tests drive the journal through its public interface with a
 * `SemanticIndex` of their own, so the contract - when the channel is consulted,
 * how its results merge, what a redaction erases, what a catch-up indexes - is
 * checked without a model and without zvec. The real channel is tested in
 * `@4fu/arbor-search-zvec`.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type {
  EventRef,
  SearchOptions,
  SearchPage,
  SemanticFilters,
  SemanticFields,
  SemanticIndex,
} from "@4fu/arbor-interfaces";
import { SqliteJournal } from "./sqlite-journal.ts";
import { resolveSemanticIndex } from "./semantic.ts";
import { fallbackSegmenter } from "@4fu/arbor-lexical";

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
  a.reduce((sum, one, index) => sum + one * (b[index] ?? 0), 0);

/** A semantic channel that knows the concepts above, in memory. */
class TestChannel implements SemanticIndex {
  readonly added: Array<{ ref: EventRef; text: string; fields?: SemanticFields }> = [];
  readonly removed: EventRef[] = [];
  readonly searches: Array<{ query: string; limit: number; filters: SemanticFilters }> = [];
  private readonly vectors = new Map<EventRef, number[]>();
  private readonly fields = new Map<EventRef, SemanticFields>();
  usable = true;

  async add(ref: EventRef, text: string, fields?: SemanticFields): Promise<void> {
    this.added.push({ ref, text, fields });
    this.vectors.set(ref, vectorOf(text));
    this.fields.set(ref, fields ?? {});
  }

  async remove(ref: EventRef): Promise<void> {
    this.removed.push(ref);
    this.vectors.delete(ref);
    this.fields.delete(ref);
  }

  async search(query: string, limit: number, filters: SemanticFilters): Promise<readonly EventRef[]> {
    this.searches.push({ query, limit, filters });
    if (!this.usable) return [];
    const query_vector = vectorOf(query);
    return [...this.vectors.entries()]
      .filter(([ref]) => this.keeps(ref, filters))
      .map(([ref, vector]) => ({ ref, score: dot(query_vector, vector) }))
      .sort((a, b) => b.score - a.score || a.ref.localeCompare(b.ref))
      .slice(0, limit)
      .map((one) => one.ref);
  }

  async ready(): Promise<boolean> {
    return this.usable;
  }

  async held(): Promise<ReadonlySet<EventRef>> {
    return new Set(this.vectors.keys());
  }

  async close(): Promise<void> {}

  /** The filters the channel can answer itself; the journal applies the rest. */
  private keeps(ref: EventRef, filters: SemanticFilters): boolean {
    const seq = Number(ref.slice(1));
    if (filters.afterSeq !== undefined && seq <= filters.afterSeq) return false;
    if (filters.beforeSeq !== undefined && seq >= filters.beforeSeq) return false;
    const fields = this.fields.get(ref) ?? {};
    if (filters.kinds !== undefined && !filters.kinds.includes(fields.kind ?? "")) return false;
    if (filters.window !== undefined && filters.window !== null && fields.window !== filters.window) {
      return false;
    }
    return true;
  }
}

/** A journal with the fixture's events, and the channel it was given. */
async function journalWith(
  semantic: SemanticIndex | null,
): Promise<{ journal: SqliteJournal; channel: TestChannel | null }> {
  const journal = new SqliteJournal({
    path: ":memory:",
    segmenter: fallbackSegmenter,
    semantic,
  });
  await journal.append({
    kind: "input",
    window: "c41",
    body: "网关把通知拦掉了，用户钱扣了订单还挂着",
    targets: ["qq:group:1"],
  });
  await journal.append({ kind: "assistant", window: "c41", body: "补一个重试队列比较稳妥" });
  await journal.append({
    kind: "input",
    window: "c52",
    body: "证书昨天到期了，客户端全部报错",
    targets: ["file:src/gateway.ts"],
  });
  await journal.append({ kind: "assistant", window: "c52", body: "连接池上限设得太低" });
  return { journal, channel: semantic instanceof TestChannel ? semantic : null };
}

/** A query that shares no word with r1 and its payment concept with nothing else. */
const MEANING_QUERY = "付过款了却看不到变化";

describe("the journal's semantic channel", () => {
  it("indexes each event's text as it is appended", async () => {
    const channel = new TestChannel();
    const { journal } = await journalWith(channel);
    try {
      assert.deepEqual(
        channel.added.map((one) => one.ref),
        ["r1", "r2", "r3", "r4"],
      );
      assert.deepEqual(channel.added[0]?.fields, { kind: "input", window: "c41" });
    } finally {
      await journal.close();
    }
  });

  it("searches exactly lexically when no channel is registered", async () => {
    const { journal } = await journalWith(null);
    try {
      // Nothing finds the payment event by meaning, which is what the channel is
      // for; the lexical indexes answer what they always answered.
      assert.equal((await journal.search(MEANING_QUERY)).total, 0);
      assert.equal((await journal.search("证书")).total, 1);
    } finally {
      await journal.close();
    }
  });

  it("finds an event by meaning, after the lexical hits", async () => {
    const channel = new TestChannel();
    const { journal } = await journalWith(channel);
    try {
      const page: SearchPage = await journal.search(MEANING_QUERY);
      assert.equal(page.items[0]?.ref, "r1", "the event that means the query comes first");
      assert.equal(page.items[0]?.match, "semantic", "and no lexical index found it");
      // The channel answers candidates, not certainties, so the events it ranked
      // below the hit are in the page too.
      assert.ok(page.total > 1);
      // The channel's own order shows in the score, so a reader can tell the
      // nearest hit from the ones behind it.
      assert.ok(
        (page.items[0]?.score ?? 0) > (page.items[1]?.score ?? 0),
        "the nearest hit scores above the ones behind it",
      );

      // An exact substring hit keeps its place in front of a semantic one: the
      // query appears verbatim in r3, and the channel ranks r3 first too.
      const both = await journal.search("证书");
      assert.equal(both.items[0]?.ref, "r3");
      assert.equal(both.items[0]?.match, "substring");
      assert.equal(both.items[1]?.match, "semantic");
    } finally {
      await journal.close();
    }
  });

  it("keeps the read's filters over the semantic channel's hits", async () => {
    const channel = new TestChannel();
    const { journal } = await journalWith(channel);
    try {
      const refs = async (options: SearchOptions): Promise<string[]> =>
        (await journal.search(MEANING_QUERY, options)).items.map((hit) => hit.ref);

      // r1 is the payment event, so every filter that takes it out takes the hit
      // with it, and the ones that keep it keep it.
      assert.ok(!(await refs({ window: "c52" })).includes("r1"), "r1 is in c41");
      assert.ok(!(await refs({ kinds: ["assistant"] })).includes("r1"), "r1 is an input");
      assert.ok(!(await refs({ afterSeq: 1 })).includes("r1"), "the range is the event's order");
      assert.deepEqual(await refs({ targets: ["qq:group:1"] }), ["r1"]);
      assert.deepEqual(await refs({ window: "c41", kinds: ["input"] }), ["r1"]);
    } finally {
      await journal.close();
    }
  });

  it("passes the read's filters to the channel as well", async () => {
    const channel = new TestChannel();
    const { journal } = await journalWith(channel);
    try {
      await journal.search(MEANING_QUERY, { window: "c52", kinds: ["input"], afterSeq: 2 });
      const asked = channel.searches.at(-1);
      assert.deepEqual(asked?.filters, { window: "c52", kinds: ["input"], afterSeq: 2 });
      assert.ok((asked?.limit ?? 0) >= 10, "a page of one still fuses a handful of candidates");
    } finally {
      await journal.close();
    }
  });

  it("erases the event's vector when it is redacted", async () => {
    const channel = new TestChannel();
    const { journal } = await journalWith(channel);
    try {
      await journal.redact("r1", "personal data");
      assert.deepEqual(channel.removed, ["r1"]);
      const page = await journal.search(MEANING_QUERY);
      assert.ok(!page.items.some((hit) => hit.ref === "r1"), "the redacted event is not a hit");
      assert.ok(!(await channel.held()).has("r1"));
      const lexical = await journal.search("证书");
      assert.equal(lexical.items[0]?.ref, "r3", "the other events stay searchable");
    } finally {
      await journal.close();
    }
  });

  it("indexes what the channel is missing after a restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "arbor-journal-"));
    const path = join(directory, "journal.db");
    const first = new SqliteJournal({ path, segmenter: fallbackSegmenter });
    await first.append({ kind: "input", window: "c41", body: "证书昨天到期了，客户端全部报错" });
    await first.close();

    // A second host over the same database, with a channel that starts empty:
    // the events are there, the vectors are not.
    const channel = new TestChannel();
    const second = new SqliteJournal({ path, segmenter: fallbackSegmenter, semantic: channel });
    try {
      assert.equal(channel.added.length, 0, "the events are in the database, the vectors are not");
      assert.equal((await second.catchUpSemantic()), 1);
      assert.deepEqual(
        channel.added.map((one) => one.ref),
        ["r1"],
      );
      assert.deepEqual([...(await channel.held())], ["r1"]);
    } finally {
      await second.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("catches up on a search when the channel is not ready yet", async () => {
    const channel = new TestChannel();
    const { journal } = await journalWith(channel);
    try {
      channel.usable = false;
      assert.equal((await journal.search(MEANING_QUERY)).total, 0, "a channel not ready answers nothing");
      channel.usable = true;
      const page = await journal.search(MEANING_QUERY);
      assert.equal(page.items[0]?.ref, "r1", "the channel catches up once it is ready");
    } finally {
      await journal.close();
    }
  });

  it("closes the channel with the journal", async () => {
    let closed = 0;
    const channel = new TestChannel();
    const original = channel.close.bind(channel);
    channel.close = async () => {
      closed += 1;
      await original();
    };
    const { journal } = await journalWith(channel);
    await journal.close();
    assert.equal(closed, 1);
  });

  it("keeps an append working when the channel refuses", async () => {
    const channel = new TestChannel();
    const { journal } = await journalWith(channel);
    try {
      const original = channel.add.bind(channel);
      channel.add = async () => {
        throw new Error("the store refused");
      };
      const event = await journal.append({ kind: "input", window: "c41", body: "又一条" });
      assert.equal(event.ref, "r5");
      // The event is searchable lexically, and a catch-up indexes it later.
      const page = await journal.search("又一条");
      assert.equal(page.items[0]?.ref, "r5");
      assert.equal(page.items[0]?.match, "substring");
      channel.add = original;
      assert.equal((await journal.catchUpSemantic()), 1);
      assert.ok((await channel.held()).has("r5"));
    } finally {
      await journal.close();
    }
  });
});

describe("the semantic channel a journal resolves for itself", () => {
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
