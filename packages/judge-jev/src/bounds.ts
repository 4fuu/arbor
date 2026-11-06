/**
 * The bounds on what one judge request carries.
 *
 * Jev's context window is 64k tokens, and the state is chat text, window
 * profiles and note summaries: a host with a long task or many live windows
 * must not post all of it. The bounds here are the judge's own, computed in
 * code, and every cut is reported in the state as a labelled fact
 * (`dropped_content`, `dropped_candidates`, `dropped_older`) so a question
 * never reads a silence that is only a cut - the rule a shared recent context
 * states the same way.
 *
 * Nothing is cut in half. A list whose newest items matter most - a task's
 * content blocks - keeps the newest whole items that fit; a list whose leading
 * items are already the strongest - the host's candidate order, or the rule
 * score - keeps the leading ones. Either way the newest item is kept even when
 * it alone is bigger than the budget, because a decision with no items at all
 * answers nothing.
 */

/** Tokens one task's content blocks may use. */
export const CONTENT_TOKENS = 8_000;

/** Tokens the candidate windows of one decision may use. */
export const CANDIDATES_TOKENS = 6_000;

/** Characters one string in the state may use. */
export const MAX_TEXT_CHARS = 400;

/** How many of a window's taken tasks the state carries. */
export const MAX_TASKS = 5;

/** How many of a window's last inputs the state carries. */
export const MAX_LAST_INPUTS = 3;

/** How many of a window's expectations the state carries. */
export const MAX_EXPECTS = 8;

/**
 * A rough token estimate: a Chinese, Japanese or Korean character is one
 * token, and every other script about four characters. It is an estimate, and
 * it is the same one for every item, which is what a budget needs.
 */
export function estimateTokens(text: string): number {
  let tokens = 0;
  let other = 0;
  for (const character of text) {
    if (isCjk(character.codePointAt(0) ?? 0)) {
      tokens += 1;
      continue;
    }
    other += 1;
    if (other === 4) {
      tokens += 1;
      other = 0;
    }
  }
  return tokens + (other > 0 ? 1 : 0);
}

function isCjk(codePoint: number): boolean {
  return (
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) ||
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0x3040 && codePoint <= 0x30ff) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7af) ||
    (codePoint >= 0x20000 && codePoint <= 0x2a6df) ||
    (codePoint >= 0x2a700 && codePoint <= 0x2ebef)
  );
}

/** What one item costs, as its JSON form. */
export function jsonCost(item: unknown): number {
  return estimateTokens(JSON.stringify(item) ?? "");
}

/**
 * The newest whole items that fit the budget, oldest first, with how many older
 * ones were left out. An item is never cut in half, and the newest item is kept
 * even when it alone is bigger than the budget, because a task with no content
 * at all answers nothing.
 */
export function fitNewest<T>(
  items: readonly T[],
  cost: (item: T) => number,
  budget: number,
): { kept: T[]; dropped: number } {
  const kept: T[] = [];
  let used = 0;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index] as T;
    const size = cost(item);
    if (kept.length > 0 && used + size > budget) break;
    kept.push(item);
    used += size;
  }
  kept.reverse();
  return { kept, dropped: items.length - kept.length };
}

/**
 * The leading whole items that fit the budget, with how many later ones were
 * left out. Used where the caller's order is already a ranking - the host's
 * candidate order, or the rule score - so the strongest items are the ones
 * asked about and the rest are reported as dropped.
 */
export function fit<T>(
  items: readonly T[],
  cost: (item: T) => number,
  budget: number,
): { kept: T[]; dropped: number } {
  const kept: T[] = [];
  let used = 0;
  for (const item of items) {
    const size = cost(item);
    if (kept.length > 0 && used + size > budget) break;
    kept.push(item);
    used += size;
  }
  return { kept, dropped: items.length - kept.length };
}

/**
 * One string cut at `limit` characters, counted in code points so a character
 * is never split, with a marker that says it was cut.
 */
export function truncate(text: string, limit: number = MAX_TEXT_CHARS): string {
  const characters = Array.from(text);
  if (characters.length <= limit) return text;
  return `${characters.slice(0, limit).join("")}…`;
}

/** The newest `limit` items of a list, with how many older ones were left out. */
export function newest<T>(items: readonly T[], limit: number): { kept: T[]; dropped: number } {
  return { kept: items.slice(0, limit), dropped: Math.max(0, items.length - limit) };
}
