import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TokenUsage } from "@4fu/arbor-interfaces";
import {
  REMINDER_SERIES,
  REMINDER_TIERS,
  atHardLimit,
  hardLimitAt,
  hardLimitReserve,
  nextReminderTier,
  usedPercent,
} from "./reminder.ts";

function usage(used: number, limit = 200000, reserve = 4000): TokenUsage {
  return { used, limit, reserve };
}

describe("usage reminders", () => {
  it("sends nothing before the first tier", () => {
    assert.equal(nextReminderTier(usage(1000), 0), null);
  });

  it("sends the highest crossed tier and skips the ones it jumped over", () => {
    const tier = nextReminderTier(usage(130000), 0);
    assert.equal(tier?.tier, "handoff");
    // 15, 30, 50 and 60 were all crossed; only 60 is sent.
    assert.equal(REMINDER_TIERS.indexOf(tier!), 3);
  });

  it("does not send a tier twice", () => {
    assert.equal(nextReminderTier(usage(130000), 4), null);
    assert.equal(nextReminderTier(usage(130000), 4)?.tier, undefined);
  });

  it("reports the real share of the window", () => {
    assert.equal(usedPercent(usage(30000)), 15);
    assert.equal(usedPercent(usage(200000)), 100);
    assert.equal(usedPercent(usage(250000)), 100);
  });

  it("fires the final tier at window - 2 x reserve", () => {
    const final = REMINDER_TIERS[REMINDER_TIERS.length - 1];
    assert.equal(final?.tier, "final");
    assert.equal(final?.at(usage(0)), 200000 - 2 * 4000);
    const tier = nextReminderTier(usage(195000), 6);
    assert.equal(tier?.tier, "final");
  });

  it("holds a series of seven reminders", () => {
    assert.equal(REMINDER_SERIES, 7);
  });
});

describe("hard limit", () => {
  it("reserves 16k tokens, or a quarter of a small window", () => {
    assert.equal(hardLimitReserve(200000), 16000);
    assert.equal(hardLimitReserve(40000), 10000);
  });

  it("ends the window at window - min(16k, window / 4)", () => {
    assert.equal(hardLimitAt(usage(0)), 200000 - 16000);
    assert.equal(hardLimitAt(usage(0, 40000)), 40000 - 10000);
  });

  it("is reached only at or past that point", () => {
    assert.equal(atHardLimit(usage(183999)), false);
    assert.equal(atHardLimit(usage(184000)), true);
  });
});
