import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { FilterAnswer } from "@arbor/interfaces";

import { Jev } from "./jev.ts";

/**
 * The live smoke test: one real request against TypeSafe's System One service.
 *
 * It is opt-in: it runs only where `ARBOR_LIVE_TESTS=1` is set, so `pnpm check`
 * never makes a network call, even on a machine that has a `JEV_API_KEY` in its
 * environment (docs/architecture.md#data-placement: the setting names the
 * secret, never its value). It asks the cheapest decision there is - one bool
 * question about one small batch - and checks that the answer comes back in the
 * shape this package reads: the wire form of a bool answer is `noul`, and
 * anything else is a protocol error.
 */

const live = process.env.ARBOR_LIVE_TESTS === "1";

describe("against the real service", () => {
  it("answers a filter decision", async (t) => {
    if (!live) {
      return t.skip("set ARBOR_LIVE_TESTS=1 to run against the real service");
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
    // The service layer owns the threshold, so the answer carries the
    // probability it was read from.
    assert.equal(typeof answer.score, "number");
  });
});
