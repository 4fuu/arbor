import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MIN_TRIGRAM_CHARS,
  escapeLike,
  likePattern,
  mergeHits,
  quoteFts,
  trigramMatch,
  wordMatch,
} from "./index.ts";

describe("match strings", () => {
  it("escapes a LIKE pattern's own wildcards", () => {
    assert.equal(escapeLike("a%b_c\\d"), "a\\%b\\_c\\\\d");
    assert.equal(likePattern("100%"), "%100\\%%");
  });

  it("quotes FTS5 syntax as data, never as an operator", () => {
    assert.equal(quoteFts('say "hi"'), '"say ""hi"""');
    assert.equal(trigramMatch("cart OR zebra"), '"cart OR zebra"');
    assert.equal(trigramMatch('"部署"'), '"""部署"""');
  });

  it("requires every one of a query's segments, and drops the empty ones", () => {
    assert.equal(wordMatch(["部署", "上线"]), '"部署" "上线"');
    assert.equal(wordMatch(["部署", "", "上线"]), '"部署" "上线"');
    assert.equal(wordMatch([]), "");
  });

  it("cuts the trigram index at three characters", () => {
    assert.equal(MIN_TRIGRAM_CHARS, 3);
  });
});

describe("mergeHits", () => {
  it("puts the first channel's hits first, then the next channel's", () => {
    // Each channel arrives in its own relevance order, as the query that fills
    // it leaves it, and keeps that order.
    const merged = mergeHits(
      { channel: "substring", hits: [{ rowid: 3, rank: -2 }, { rowid: 7, rank: -1 }] },
      { channel: "word", hits: [{ rowid: 9, rank: -1 }] },
    );

    assert.deepEqual(
      merged.map((hit) => hit.rowid),
      [3, 7, 9],
    );
    assert.deepEqual(
      merged.map((hit) => hit.channel),
      ["substring", "substring", "word"],
    );
  });

  it("keeps a row the first channel found where that channel put it", () => {
    const merged = mergeHits(
      { channel: "substring", hits: [{ rowid: 5, rank: -1 }] },
      { channel: "word", hits: [{ rowid: 5, rank: -1 }, { rowid: 6, rank: -1 }] },
    );

    assert.deepEqual(
      merged.map((hit) => hit.rowid),
      [5, 6],
    );
    assert.deepEqual(
      merged.map((hit) => hit.channel),
      ["substring", "word"],
    );
  });

  it("scores each channel against its own best hit", () => {
    const merged = mergeHits(
      { channel: "substring", hits: [{ rowid: 1, rank: -4 }, { rowid: 2, rank: -1 }] },
      { channel: "word", hits: [{ rowid: 3, rank: -2 }] },
    );

    // The best hit of a channel scores 1; a worse one keeps its share of it.
    assert.deepEqual(
      merged.map((hit) => hit.score),
      [1, 0.25, 1],
    );
  });

  it("skips a channel with no hits, and answers nothing when none has any", () => {
    const merged = mergeHits(
      { channel: "substring", hits: [] },
      { channel: "word", hits: [{ rowid: 4, rank: -1 }] },
    );
    assert.deepEqual(
      merged.map((hit) => hit.rowid),
      [4],
    );
    assert.deepEqual(mergeHits({ channel: "substring", hits: [] }, { channel: "word", hits: [] }), []);
  });
});
