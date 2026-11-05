/**
 * The `Judge` interface: answer the host's decisions - filter, route, model
 * tier, notice, broadcast, active set (docs/architecture.md#interfaces,
 * docs/dispatch.md#judge-decisions).
 *
 * The judge decides whether, where and when. It never writes text; the model
 * owns content. It is a classifier, not the main model.
 *
 * What is *not* here: the rule bounds and the fallbacks. Those live in code
 * that never moves, in the service layer, so an unreachable judge changes
 * nothing about the rules.
 */

import type { Block } from "./blocks.ts";
import type { NoteRef, Ref, Target, TaskRef, WindowRef } from "./refs.ts";

export type JudgeMode = "off" | "shadow" | "on";

export type JudgeDecisionKind =
  | "filter"
  | "route"
  | "model_tier"
  | "notice"
  | "broadcast"
  | "active_set";

/** A window's profile, assembled by the host with no extra model call. */
export interface CandidateWindow {
  window: WindowRef;
  /** Its board line. */
  doing: string;
  targets: readonly Target[];
  expects: readonly string[];
  state: "running" | "idle";
  usage: { used: number; limit: number };
  /** The tasks it has taken, newest first. */
  tasks: readonly string[];
  /** Its last inputs, by ref and opening words. */
  lastInputs: ReadonlyArray<{ ref: Ref; summary: string }>;
  /** Whether it has had its final usage reminder. */
  finalReminderSent: boolean;
}

/** A task as the judge sees it: its targets, its reason and its content. */
export interface JudgeTask {
  ref: TaskRef;
  kind: "batch" | "scheduled" | "service";
  reason: string;
  targets: readonly Target[];
  content: readonly Block[];
  time: number;
}

export interface FilterState {
  task: JudgeTask;
  /** Explicit requests always pass. */
  explicit: boolean;
}

export interface RouteState {
  task: JudgeTask;
  /** The live windows that share a target, describe an expectation, or worked recently. */
  candidates: readonly CandidateWindow[];
}

export interface ModelTierState {
  task: JudgeTask;
  /** Only configured tiers. */
  tiers: readonly string[];
  /**
   * What each tier is for, as the question reads it: one line per tier name,
   * from `settings.judge.tierCriteria`. A tier named here with no text falls
   * back to the judge's own description of it.
   */
  criteria?: Record<string, string>;
}

export interface NoticeState {
  /** The event that touched the target. */
  event: { ref: Ref; kind: string; target: Target; summary: string };
  /** Only windows that touched the event's target. */
  candidates: readonly CandidateWindow[];
}

export interface BroadcastState {
  broadcast: { from: WindowRef | null; summary: string; refs: readonly Ref[] };
  candidates: readonly CandidateWindow[];
  /** Environment deltas are never filtered. */
  unfiltered?: boolean;
}

export interface ActiveSetState {
  notes: ReadonlyArray<{ ref: NoteRef; summary: string; score: number }>;
  budget: { count: number; tokens: number };
  /** The bounded share the judge may add, which never outweighs the rule score. */
  judgeShare: number;
}

export interface FilterRequest {
  decision: "filter";
  mode: JudgeMode;
  state: FilterState;
  criteria?: readonly string[];
}

export interface RouteRequest {
  decision: "route";
  mode: JudgeMode;
  state: RouteState;
  criteria?: readonly string[];
}

export interface ModelTierRequest {
  decision: "model_tier";
  mode: JudgeMode;
  state: ModelTierState;
  criteria?: readonly string[];
}

export interface NoticeRequest {
  decision: "notice";
  mode: JudgeMode;
  state: NoticeState;
  criteria?: readonly string[];
}

export interface BroadcastRequest {
  decision: "broadcast";
  mode: JudgeMode;
  state: BroadcastState;
  criteria?: readonly string[];
}

export interface ActiveSetRequest {
  decision: "active_set";
  mode: JudgeMode;
  state: ActiveSetState;
  criteria?: readonly string[];
}

export type JudgeRequest =
  | FilterRequest
  | RouteRequest
  | ModelTierRequest
  | NoticeRequest
  | BroadcastRequest
  | ActiveSetRequest;

export interface FilterAnswer {
  decision: "filter";
  needsHandling: boolean;
  /**
   * The judge's own reading, on the question's own scale: a bool question's
   * probability. The service layer owns the threshold and reads this when the
   * answer carries one, so a judge that answers with a probability and one that
   * answers with a bare boolean are read the same way.
   */
  score?: number;
  reason?: string;
}

export interface RouteScore {
  /** A window ref, or `new` for a new window. */
  item: WindowRef | "new";
  score: number;
  reason?: string;
}

export interface RouteAnswer {
  decision: "route";
  scores: readonly RouteScore[];
  best: WindowRef | "new";
}

export interface ModelTierAnswer {
  decision: "model_tier";
  tier: string;
}

export interface WindowDecision {
  window: WindowRef;
  needs: boolean;
  /** The judge's own reading, for the service layer's threshold. */
  score?: number;
  reason?: string;
}

export interface NoticeAnswer {
  decision: "notice";
  windows: readonly WindowDecision[];
}

export interface BroadcastAnswer {
  decision: "broadcast";
  windows: readonly WindowDecision[];
}

export interface ActiveSetAnswer {
  decision: "active_set";
  keep: readonly NoteRef[];
  drop: readonly NoteRef[];
  /**
   * Each candidate's level on the score question's own scale, for the service
   * layer's own threshold. Absent from a judge that answers with the two lists
   * alone.
   */
  scores?: readonly { ref: NoteRef; score: number }[];
}

export type JudgeAnswer =
  | FilterAnswer
  | RouteAnswer
  | ModelTierAnswer
  | NoticeAnswer
  | BroadcastAnswer
  | ActiveSetAnswer;

export interface Judge {
  readonly name: string;

  /** Answer one decision. One request per decision, with its questions batched. */
  decide(request: JudgeRequest): Promise<JudgeAnswer>;
}

/** Extra criteria a plugin registers for its own inputs. */
export interface JudgeCriteria {
  decision: JudgeDecisionKind;
  criteria: readonly string[];
}
