/**
 * Window shapes (docs/windows.md) and the live view the host keeps of them
 * (docs/coordination.md#the-board).
 *
 * A window is one context window: a model run over one prompt. Windows are
 * disposable; none of them owns a conversation, a file or a task.
 */

import type { Block } from "./blocks.ts";
import type { Ref, Target, TaskRef, WindowRef } from "./refs.ts";

export type WindowState = "running" | "idle" | "ended" | "paused";

/** What the host knows about a live window, for the board and for dispatch. */
export interface WindowRuntimeState {
  window: WindowRef;
  state: WindowState;
  /** When the window opened. */
  startedAt: number;
  /** The task it was opened for. */
  task?: TaskRef;
  /** The targets it has touched. */
  targets: readonly Target[];
  /** The target it is working on now, for the protection period. */
  currentTarget?: Target;
  /** Insertion is paused. */
  paused: boolean;
  /** The protection period's end, in epoch milliseconds. */
  protectionUntil: number | null;
  /** The final usage reminder has been sent, so nothing more is inserted. */
  finalReminderSent: boolean;
  usage: TokenUsage;
}

export interface TokenUsage {
  /** Tokens used in this window. */
  used: number;
  /** The context window's token budget. */
  limit: number;
  /** Tokens held back from the model. */
  reserve: number;
}

/**
 * A handoff: the cost of ending a window with unfinished work. Each part
 * carries refs; the details belong in notes and the journal.
 */
export interface Handoff {
  topics: readonly string[];
  progress: readonly string[];
  pending: readonly string[];
  agreements: readonly string[];
  refs: readonly Ref[];
}

/** One line on the board, per live window. */
export interface BoardLine {
  window: WindowRef;
  /** The first task's title, until the model sets a line with `board.set`. */
  doing: string;
  targets: readonly Target[];
  /** What the window expects to be routed to it. */
  expects: readonly Expectation[];
  state: WindowState;
  usage: TokenUsage;
  /**
   * The work this window still has open in its workspace, each item as the
   * model reads it (docs/workspaces.md#open-work). Empty when it has none.
   */
  openWork?: readonly string[];
}

/**
 * What a window expects to arrive, so the input reaches it instead of a new
 * window. An exact expectation is a rule; a described one joins the window's
 * profile for the judge.
 */
export interface Expectation {
  kind: "exact" | "described";
  /** An outside item, thread or whole conversation, for an exact expectation. */
  item?: Target;
  /** One sentence, for a described expectation. */
  description?: string;
  ref: Ref;
}

/** One block entering a window, in the shape the prompt layout uses. */
export interface InputBlock {
  kind: string;
  window?: WindowRef;
  time: number;
  refs: readonly Ref[];
  content: readonly Block[];
}
