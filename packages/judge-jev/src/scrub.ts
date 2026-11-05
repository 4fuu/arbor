/**
 * Scrubbing: no secret value reaches Jev, and none reaches the decision log.
 *
 * Every request is scrubbed on the way out (docs/dispatch.md#judge-decisions).
 * The state is task content, window profiles and note summaries - outside text
 * and tool output - and a credential can hide in any of them. The scrubber
 * itself belongs to the host, which knows the secret values; this module is the
 * walk that applies it to every string of a structured value, so a caller
 * cannot forget one field.
 *
 * Numbers, booleans and nulls carry no secret and are left alone.
 */

import type { JudgeQuestion } from "./options.ts";

/** The same scrub over every string inside a structured value. */
export function scrubJson(value: unknown, scrub: (text: string) => string): unknown {
  if (typeof value === "string") return scrub(value);
  if (Array.isArray(value)) return value.map((entry) => scrubJson(entry, scrub));
  if (value !== null && typeof value === "object") {
    const next: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      next[key] = scrubJson(entry, scrub);
    }
    return next;
  }
  return value;
}

/** A scrub over one record of questions, keyed by question id. */
export function scrubQuestions(
  questions: Record<string, JudgeQuestion>,
  scrub: (text: string) => string,
): Record<string, JudgeQuestion> {
  const out: Record<string, JudgeQuestion> = {};
  for (const [id, question] of Object.entries(questions)) {
    out[id] = scrubJson(question, scrub) as JudgeQuestion;
  }
  return out;
}
