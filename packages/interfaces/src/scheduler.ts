/**
 * The `Scheduler` interface: insertion timing, backpressure and scheduled
 * tasks (docs/architecture.md#interfaces, docs/dispatch.md).
 *
 * The model sees only input blocks; it never manages timing. The rules below
 * decide when the host calls the backend's steering:
 *
 * - Protection period: when a window starts on a target, only inputs for that
 *   target enter during it; inputs for the same target do not restart it.
 *   Environment deltas and conversation updates are not held back.
 * - After it: an input for the current target that is still being batched goes
 *   in first; then the others, by priority and age.
 * - No insertion after the final usage reminder; waiting inputs are dispatched
 *   again.
 * - Paused: nothing is inserted.
 *
 * Backpressure: there is no cap on windows. How many run at once is bounded by
 * the backend, so when it reports rate limits new windows wait in a queue
 * ordered by priority and age.
 */

import type { Delivery } from "./agent.ts";
import type { TaskInput } from "./task.ts";
import type { Target, TaskRef } from "./refs.ts";
import type { WindowRuntimeState } from "./windows.ts";

/** One input waiting to enter a window. */
export interface QueuedInput {
  id: string;
  kind: Delivery["kind"];
  targets: readonly Target[];
  /** Higher goes first. */
  priority: number;
  /** When it was queued. */
  time: number;
  /** Environment deltas and conversation updates are never held back. */
  unfiltered?: boolean;
}

export interface InsertionRequest {
  state: WindowRuntimeState;
  queued: readonly QueuedInput[];
  now: number;
}

export interface InsertionPlan {
  /** Steer in now, at the next tool-call boundary. */
  insert: readonly QueuedInput[];
  /** Queue for after the run ends. */
  followUp: readonly QueuedInput[];
  /** Keep waiting. */
  hold: readonly QueuedInput[];
  /** Dispatch again: the window is past its final reminder. */
  redispatch: readonly QueuedInput[];
}

export interface RateLimitState {
  limited: boolean;
  retryAfterMs?: number;
}

export interface AdmissionRequest {
  running: number;
  queued: readonly TaskInput[];
  rateLimit?: RateLimitState;
  now: number;
}

export interface AdmissionPlan {
  /** How many new windows may open now. */
  open: number;
  /** Whether the rest must wait in the queue. */
  wait: boolean;
  reason?: string;
}

/** A daily skip period, `HH:MM` to `HH:MM`. */
export interface SkipPeriod {
  from: string;
  to: string;
}

export interface ScheduledTaskInput {
  name?: string;
  /** The first firing, in epoch milliseconds. */
  firstAt: number;
  repeat?: { everyMs: number } | { dailyAt: string };
  skipDaily?: readonly SkipPeriod[];
  targets?: readonly Target[];
  task: Omit<TaskInput, "kind">;
}

export interface ScheduledTask {
  ref: TaskRef;
  name?: string;
  firstAt: number;
  nextAt: number;
  lastAt?: number;
  repeat?: { everyMs: number } | { dailyAt: string };
  skipDaily?: readonly SkipPeriod[];
  targets: readonly Target[];
  paused: boolean;
}

export interface Scheduler {
  /** Which waiting inputs may enter a running window now. */
  insertion(request: InsertionRequest): Promise<InsertionPlan>;

  /** How many new windows may open now, given the backend's rate limits. */
  admission(request: AdmissionRequest): Promise<AdmissionPlan>;

  schedule(input: ScheduledTaskInput): Promise<TaskRef>;

  cancel(ref: TaskRef): Promise<void>;

  list(): Promise<readonly ScheduledTask[]>;

  /** The tasks whose time has come, in the order they should be dispatched. */
  due(now: number): Promise<readonly TaskInput[]>;
}
