/**
 * @4fu/arbor-notes-sqlite - the default `NoteStore`.
 */

export { SqliteNoteStore, SUMMARY_LIMIT, DEFAULT_BODY_LIMIT, MAX_BODY_LIMIT } from "./notes.ts";
export {
  DEFAULT_MIN_INTERVAL_MS,
  DEFAULT_ACTIVE_BUDGET,
  DEFAULT_JUDGE_SHARE,
  DEFAULT_HALF_LIFE_MS,
  deriveSummary,
} from "./notes.ts";
export type { SqliteNoteStoreOptions } from "./notes.ts";

export { SCHEMA_VERSION, FTS_TABLE, createSchema } from "./schema.ts";

export {
  noteIdOf,
  noteRefOf,
  parseNoteId,
  parseNoteRef,
  noteRefForms,
  storedWindowRef,
  storedEventRef,
} from "./refs.ts";

export {
  USE_WEIGHTS,
  MAX_CREDIT_HOPS,
  decay,
  estimateTokens,
  linkedCredit,
  loadCredit,
  loadEdges,
  pickByBudget,
  applyJudgeShare,
  scoreNotes,
} from "./score.ts";
export type { ScoredNote } from "./score.ts";

export {
  MIN_TRIGRAM_CHARS,
  substringClause,
  holdingIds,
  escapeLike,
  likePattern,
  quoteFts,
} from "./search.ts";
export type { SubstringClause } from "./search.ts";

export { bodyDiff } from "./diff.ts";
