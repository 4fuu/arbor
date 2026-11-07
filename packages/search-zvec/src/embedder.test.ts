/**
 * The default embedder (docs/journal.md#search).
 *
 * It runs a small bilingual retrieval model in-process through transformers.js,
 * which is an optional peer: these tests skip when it is not installed, naming
 * what is missing. What they check is the contract the channel relies on - a
 * dimension, vectors in the order asked for - rather than the model's quality,
 * which is measured outside the repository.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Embedder } from "@4fu/arbor-interfaces";
import { DEFAULT_MODEL, localEmbedder, transformersInstalled } from "./embedder.ts";

/** transformers.js, which is what the default embedder needs. */
const transformers = transformersInstalled();
const missing =
  transformers === false
    ? "@huggingface/transformers is not installed, so the default embedding model cannot run"
    : "";

/** A cache of its own, so a test never depends on what another one downloaded. */
const cacheDir = `/tmp/arbor-embedder-test-${process.pid}`;

async function embedder(): Promise<Embedder & { load(): Promise<void> }> {
  const made = localEmbedder({ cacheDir });
  await made.load();
  return made;
}

describe("the default embedder", () => {
  it("embeds text into one vector per text, with a fixed dimension", async (t) => {
    if (!transformers) return t.skip(missing);
    const made = await embedder();
    assert.equal(made.dimension, 512, `${DEFAULT_MODEL} is a 512-dimension model`);

    const vectors = await made.embed(["部署上线", "deploy the release", ""]);
    assert.equal(vectors.length, 3);
    for (const vector of vectors) {
      assert.equal(vector.length, made.dimension);
      // Normalized, so a dot product is a cosine: the metric the store uses.
      const norm = Math.sqrt(vector.reduce((sum, one) => sum + one * one, 0));
      assert.ok(Math.abs(norm - 1) < 1e-3, `norm ${norm}`);
    }
  });

  it("puts a query nearer the event that means the same thing", async (t) => {
    if (!transformers) return t.skip(missing);
    const made = await embedder();
    const [query, same, other] = await made.embed([
      "付过款了却看不到变化",
      "网关把通知拦掉了，用户钱扣了订单还挂着",
      "约了 3 号会议室，日历邀请已经发出",
    ]);
    const dot = (a: readonly number[], b: readonly number[]) =>
      a.reduce((sum, one, index) => sum + one * (b[index] ?? 0), 0);
    assert.ok(
      dot(query ?? [], same ?? []) > dot(query ?? [], other ?? []),
      "the event about the query is nearer than the unrelated one",
    );
  });

  it("answers whether it can run at all, without loading anything", () => {
    assert.equal(transformersInstalled(), transformers);
  });
});
