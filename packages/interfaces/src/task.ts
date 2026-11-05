/**
 * The `TaskSource` interface: turn outside events into tasks, batching them
 * (docs/architecture.md#interfaces, docs/dispatch.md#tasks).
 *
 * A task is one unit of input: a batch of outside events, a scheduled firing,
 * or a service event. Batching is the source's business - a chat source
 * debounces per conversation, so several messages sent in a row become one
 * task. The host makes no tasks of its own for maintenance.
 */

import type { Block } from "./blocks.ts";
import type { OutsideEvent, Unsubscribe } from "./channel.ts";
import type { EventRef, Ref, Target, TaskRef } from "./refs.ts";

export type TaskKind = "batch" | "scheduled" | "service";

/** What a source hands the host. The host assigns the ref. */
export interface TaskInput {
  kind: TaskKind;
  /** Why it is a task, for the board and the judge. */
  reason: string;
  targets: readonly Target[];
  time: number;
  content: readonly Block[];
  /** The outside events it batches. */
  events?: readonly OutsideEvent[];
  /** The source that made it. */
  source?: string;
  /** Higher goes first when insertion timing orders waiting inputs. */
  priority?: number;
}

export interface Task extends TaskInput {
  ref: TaskRef;
  /** The events the batch was made of, once they are in the journal. */
  eventRefs: readonly EventRef[];
  refs: readonly Ref[];
}

export interface TaskSource {
  readonly id: string;

  /** Turn outside events into tasks, batched the way this source batches. */
  toTasks(events: readonly OutsideEvent[]): readonly TaskInput[];

  /** Push source. The host may poll instead. */
  subscribe?(handler: (events: readonly OutsideEvent[]) => void | Promise<void>): Unsubscribe;
}
