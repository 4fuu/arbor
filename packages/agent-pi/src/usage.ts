/**
 * What one window's tokens are (docs/windows.md#usage-reminders).
 *
 * `used` is the footprint of the window's context, not a running total: the
 * last request's input, cache read and cache write. A running total would
 * resend the context on every turn and cross the reminder tiers in the first
 * few turns; the footprint is what the tiers and the hard limit are about.
 */

import type { TokenUsage } from "@4fu/arbor-interfaces";
import type { Usage as PiUsage } from "@earendil-works/pi-ai";

/** The tokens one provider request carried. */
export function requestTokens(usage: PiUsage | undefined): number {
  if (usage === undefined) return 0;
  return usage.input + usage.cacheRead + usage.cacheWrite;
}

/** The window's usage, from the last assistant message. */
export function tokenUsage(
  usage: PiUsage | undefined,
  limit: number,
  reserve: number,
  previous?: TokenUsage,
): TokenUsage {
  const used = Math.max(requestTokens(usage), previous?.used ?? 0);
  return { used, limit, reserve };
}

/** True when the reported usage moved the window forward. */
export function usageChanged(before: TokenUsage, after: TokenUsage): boolean {
  return before.used !== after.used;
}

/** The core's usage shape, for a window that never reached a model. */
export function emptyUsage(limit: number, reserve: number): TokenUsage {
  return { used: 0, limit, reserve };
}
