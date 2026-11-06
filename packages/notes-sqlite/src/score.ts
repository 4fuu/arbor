/**
 * The active set's usage score (docs/memory.md#the-active-set).
 *
 * At each snapshot epoch the host picks the active set by usage score - what
 * windows cite, use as evidence and read, decayed by age - within a count and
 * token budget. Credit for the active set flows through evidence links up to
 * three hops, decaying 50/25/12.5, with a visited set so a loop is walked once.
 * A note gets its direct credit or its linked share, whichever is larger.
 *
 * The walk follows the evidence links of a note's current revision, in both
 * directions, and a deleted note earns nothing and passes nothing on. A range
 * link is not walked: `Anchor.range` is a string, not the refs of the two ends
 * of the range, so arbor has no range link to follow.
 */

import type { DatabaseSync } from "node:sqlite";
import type { ActiveSetBudget } from "@4fu/arbor-interfaces";

/** What a window's own use of a note is worth against a bare cite. */
export const USE_WEIGHTS = { cite: 1, evidence: 1, read: 0.25 } as const;

/** How far credit flows, and what each hop is worth: 50, 25, 12.5. */
export const MAX_CREDIT_HOPS = 3;

/** Usage older than this many half-lives has decayed to nothing worth. */
const USAGE_HALF_LIVES_LOADED = 10;

/** One note, scored for the active set. */
export interface ScoredNote {
  note: number;
  score: number;
  /** The token estimate of the note's summary line, for the budget. */
  tokens: number;
}

function toNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  throw new Error(`notes: storage returned a value that is not a number: ${String(value)}`);
}

/** What is left of one use after its age: half of it every half-life. */
export function decay(ageMs: number, halfLifeMs: number): number {
  if (ageMs <= 0) return 1;
  return Math.pow(0.5, ageMs / halfLifeMs);
}

/**
 * A rough token estimate of one rendered line: a Chinese, Japanese or Korean
 * character is one token, and every other script about four characters. It is
 * an estimate, and it is the same one for every note, which is what the budget
 * needs.
 */
export function estimateTokens(text: string): number {
  let tokens = 0;
  let other = 0;
  for (const character of text) {
    const codePoint = character.codePointAt(0) as number;
    if (isCjk(codePoint)) {
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

interface UsageRow {
  note: number;
  weight: number;
  time: number;
}

/** Every use still worth something, as decayed credit per note. */
export function loadCredit(db: DatabaseSync, now: number, halfLifeMs: number): Map<number, number> {
  const since = now - halfLifeMs * USAGE_HALF_LIVES_LOADED;
  const rows = db
    .prepare("SELECT note, weight, time FROM note_usage WHERE time > ?")
    .all(since) as unknown as UsageRow[];
  const credit = new Map<number, number>();
  for (const row of rows) {
    const note = toNumber(row.note);
    const weight = toNumber(row.weight);
    const value = weight * decay(now - toNumber(row.time), halfLifeMs);
    credit.set(note, (credit.get(note) ?? 0) + value);
  }
  return credit;
}

/**
 * The evidence links between notes, in both directions. Only a note's current
 * revision carries links, so an edge from an older revision is not there.
 */
export function loadEdges(db: DatabaseSync): Map<number, Set<number>> {
  const rows = db
    .prepare(
      `SELECT e.note AS from_note, e.to_note AS to_note
       FROM note_refs e
       JOIN notes f ON f.id = e.note AND f.revision = e.revision AND f.status != 'deleted'
       JOIN notes t ON t.id = e.to_note AND t.status != 'deleted'
       WHERE e.kind = 'evidence' AND e.to_note IS NOT NULL`,
    )
    .all() as unknown as Array<{ from_note: number; to_note: number }>;
  const edges = new Map<number, Set<number>>();
  const link = (from: number, to: number): void => {
    const neighbours = edges.get(from) ?? new Set<number>();
    neighbours.add(to);
    edges.set(from, neighbours);
  };
  for (const row of rows) {
    const from = toNumber(row.from_note);
    const to = toNumber(row.to_note);
    link(from, to);
    link(to, from);
  }
  return edges;
}

/**
 * The share of other notes' credit that reaches one note: a breadth-first walk
 * over the evidence links, each note credited once at the shortest distance
 * the walk reaches it, so a loop is walked once.
 */
export function linkedCredit(
  note: number,
  credit: ReadonlyMap<number, number>,
  edges: ReadonlyMap<number, Set<number>>,
): number {
  const visited = new Set<number>([note]);
  let frontier = [note];
  let total = 0;
  for (let hop = 1; hop <= MAX_CREDIT_HOPS && frontier.length > 0; hop += 1) {
    const next: number[] = [];
    for (const current of frontier) {
      for (const neighbour of edges.get(current) ?? []) {
        if (visited.has(neighbour)) continue;
        visited.add(neighbour);
        next.push(neighbour);
      }
    }
    if (next.length === 0) break;
    const share = Math.pow(0.5, hop);
    for (const reached of next) {
      total += (credit.get(reached) ?? 0) * share;
    }
    frontier = next;
  }
  return total;
}

/** Every note that is not deleted, with its score, strongest first. */
export function scoreNotes(db: DatabaseSync, now: number, halfLifeMs: number): ScoredNote[] {
  const credit = loadCredit(db, now, halfLifeMs);
  const edges = loadEdges(db);
  const rows = db
    .prepare("SELECT id, title, summary FROM notes WHERE status != 'deleted'")
    .all() as unknown as Array<{ id: number; title: string; summary: string }>;
  const scored = rows.map((row) => {
    const note = toNumber(row.id);
    const direct = credit.get(note) ?? 0;
    return {
      note,
      score: Math.max(direct, linkedCredit(note, credit, edges)),
      tokens: estimateTokens(`${row.title}\n${row.summary}`),
    };
  });
  scored.sort((a, b) => b.score - a.score || a.note - b.note);
  return scored;
}

/**
 * The rule pick: the strongest notes first, ties by id, within the count and
 * the token budget. A note with no use is not picked; freshness reaches a
 * window through the delta, not through the snapshot.
 */
export function pickByBudget(scored: readonly ScoredNote[], budget: ActiveSetBudget): ScoredNote[] {
  const picked: ScoredNote[] = [];
  let tokens = 0;
  for (const item of scored) {
    if (item.score <= 0) break;
    if (picked.length >= budget.count) break;
    if (tokens + item.tokens > budget.tokens) continue;
    picked.push(item);
    tokens += item.tokens;
  }
  return picked;
}

/**
 * The judge's bounded share: at most a share of the budget, additive only. The
 * judge adds notes the rule score did not pick and never drops one it did,
 * because it never outweighs the model's own use.
 */
export function applyJudgeShare(
  picked: readonly ScoredNote[],
  scored: ReadonlyMap<number, ScoredNote>,
  judgeKeep: readonly string[],
  judgeShare: number,
  budget: ActiveSetBudget,
): ScoredNote[] {
  const slots = Math.max(0, Math.floor(judgeShare * budget.count));
  if (slots === 0 || judgeKeep.length === 0) return [...picked];
  const chosen = new Set(picked.map((item) => item.note));
  let tokens = picked.reduce((total, item) => total + item.tokens, 0);
  const added: ScoredNote[] = [];
  for (const ref of judgeKeep) {
    if (added.length >= slots || chosen.size >= budget.count) break;
    const match = /^n(\d+)(?:@(\d+))?$/.exec(ref);
    if (match === null) continue;
    const item = scored.get(Number(match[1]));
    if (item === undefined || chosen.has(item.note)) continue;
    if (tokens + item.tokens > budget.tokens) continue;
    added.push(item);
    chosen.add(item.note);
    tokens += item.tokens;
  }
  return [...picked, ...added];
}
