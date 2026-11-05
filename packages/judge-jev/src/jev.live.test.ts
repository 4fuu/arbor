import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { FilterAnswer } from "@arbor/interfaces";

import { Jev } from "./jev.ts";

/**
 * The live smoke test: one real request against TypeSafe's System One service.
 *
 * It runs only where a deployment configured a key, and skips otherwise, so a
 * host without one tests everything else. What it needs is `JEV_API_KEY` in the
 * environment - the name of the secret, never its value
 * (docs/architecture.md#data-placement). It asks the cheapest decision there
 * is, one bool question about one small batch, and checks that the answer comes
 * back in the shape this package reads: the wire form of a bool answer is
 * `noul`, and anything else is a protocol error.
 */

const apiKey = process.env.JEV_API_KEY;

describe("against the real service", () => {
  it("answers a filter decision", async (t) => {
    if (apiKey === undefined || apiKey === "") {
      return t.skip("no JEV_API_KEY in the environment");
    }
    const jev = new Jev({ timeoutMs: 20_000 });
    const answer = (await jev.decide({
      decision: "filter",
      mode: "shadow",
      state: {
        explicit: false,
        task: {
          ref: "t1",
          kind: "batch",
          reason: "a message arrived in a chat",
          targets: ["smoke:test"],
          content: [{ kind: "data", fields: { text: "is anyone there?" } }],
          time: Date.now(),
        },
      },
    })) as FilterAnswer;

    assert.equal(answer.decision, "filter");
    assert.equal(typeof answer.needsHandling, "boolean");
  });
});
