/**
 * Usage reminders (docs/windows.md#usage-reminders).
 *
 * Host reminders are appended to an input, never to the prefix. The series has
 * seven tiers, each with its own instruction: at 15, 30 and 50 % write down
 * what a later window would need; at 60 % say what the boundary is; at 70 %
 * open no new large task; at 80 % rotate before new work; a final one at
 * `window - 2 x reserve` rotates now. Each carries the real numbers, its place
 * in the series and, from 80 % on, the cost of ignoring it. Only the highest
 * crossed tier is sent; the lower ones it jumped over are recorded as sent
 * with it.
 */

import type { TokenUsage } from "@4fu/arbor-interfaces";

/** One tier of the series. `tier` names the instruction in the text table. */
export interface ReminderTier {
  /** The share of the window, in percent. */
  percent: number;
  /** The tier's key in the text table: `p15` … `p80`, or `final`. */
  tier: "p15" | "p30" | "p50" | "p60" | "p70" | "p80" | "final";
  /** The share of the window's tokens at which this tier fires. */
  at: (usage: TokenUsage) => number;
}

const HARD_LIMIT_TOKENS = 16000;

function atPercent(percent: number): (usage: TokenUsage) => number {
  return (usage) => Math.floor((usage.limit * percent) / 100);
}

/** The tiers in their fixed order. */
export const REMINDER_TIERS: readonly ReminderTier[] = [
  { percent: 15, tier: "p15", at: atPercent(15) },
  { percent: 30, tier: "p30", at: atPercent(30) },
  { percent: 50, tier: "p50", at: atPercent(50) },
  { percent: 60, tier: "p60", at: atPercent(60) },
  { percent: 70, tier: "p70", at: atPercent(70) },
  { percent: 80, tier: "p80", at: atPercent(80) },
  {
    percent: 100,
    tier: "final",
    at: (usage) => usage.limit - 2 * usage.reserve,
  },
];

/** How many reminders the series holds. */
export const REMINDER_SERIES = REMINDER_TIERS.length;

/** The share of the window the host holds back at the hard limit. */
export function hardLimitReserve(limit: number): number {
  return Math.min(HARD_LIMIT_TOKENS, Math.floor(limit / 4));
}

/** The token count at which the host ends the window by itself. */
export function hardLimitAt(usage: TokenUsage): number {
  return usage.limit - hardLimitReserve(usage.limit);
}

/** True once the window has reached its hard limit. */
export function atHardLimit(usage: TokenUsage): boolean {
  return usage.used >= hardLimitAt(usage);
}

/** The share of the window used, in whole percent. */
export function usedPercent(usage: TokenUsage): number {
  if (usage.limit <= 0) return 0;
  return Math.min(100, Math.floor((usage.used / usage.limit) * 100));
}

/** The tier that fires next, or `null` when none has been crossed. */
export function nextReminderTier(usage: TokenUsage, sent: number): ReminderTier | null {
  let crossed: ReminderTier | null = null;
  for (let index = 0; index < REMINDER_TIERS.length; index += 1) {
    const tier = REMINDER_TIERS[index];
    if (tier === undefined) continue;
    if (usage.used >= tier.at(usage)) crossed = tier;
  }
  if (crossed === null) return null;
  const index = REMINDER_TIERS.indexOf(crossed);
  return index < sent ? null : crossed;
}
