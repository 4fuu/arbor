/**
 * The `TaskSource` interface: turn outside events into tasks, batching them
 * (docs/architecture.md#interfaces, docs/dispatch.md#tasks).
 *
 * A task is one unit of input: a batch of outside events, a scheduled firing,
 * or a service event. Batching is the source's business - a chat source
 * debounces per conversation, so several messages sent in a row become one
 * task. The host makes no tasks of its own for maintenance.
 *
 * A source claims the outside events of the source it names: the host hands it
 * every event whose `OutsideEvent.source` is this source's `id`, and dispatches
 * the tasks it makes of them as they stand. The host groups nothing of its own
 * for a source's events, and never debounces on its behalf - a source that
 * debounces keeps its own buffer.
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
  /**
   * An opaque label naming what this task serves, which the embedding attaches
   * and arbor never interprets: the id of the session, the conversation handle
   * or the unit of work this task belongs to
   * (docs/windows.md#what-a-window-serves).
   *
   * The host carries it without reading it: on the window the task opens, on
   * that window's continuations, on the journal's record of both, and to a
   * per-window prompt section, so an embedding can tell which of its own
   * sessions a window belongs to without a map of its own.
   */
  label?: string;
  /** Higher goes first when insertion timing orders waiting inputs. */
  priority?: number;
  /**
   * The batch names the agent directly, so `filter` always passes it. The
   * source knows this; the host does not guess it (docs/dispatch.md#routing).
   */
  explicit?: boolean;
}

export interface Task extends TaskInput {
  ref: TaskRef;
  /** The events the batch was made of, once they are in the journal. */
  eventRefs: readonly EventRef[];
  refs: readonly Ref[];
}

export interface TaskSource {
  readonly id: string;

  /**
   * An opaque label naming what this source serves, stamped on every task it
   * makes that names none of its own - the session this source is the outside
   * of, for a source that serves one
   * (docs/windows.md#what-a-window-serves). A source that serves many names
   * nothing and lets each task carry its own.
   */
  readonly label?: string;

  /** Turn outside events into tasks, batched the way this source batches. */
  toTasks(events: readonly OutsideEvent[]): readonly TaskInput[];

  /**
   * Push source. The host may poll instead. The host takes this one at `start`,
   * the way it takes a channel's, and what it pushes goes through `ingest`.
   */
  subscribe?(handler: (events: readonly OutsideEvent[]) => void | Promise<void>): Unsubscribe;
}
