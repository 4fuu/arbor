/**
 * Refs the host assigns: windows, tasks and messages between windows
 * (docs/journal.md#refs).
 *
 * The numbers come from the journal, not from memory, so a host restart
 * continues the one global order instead of starting a second one.
 */

import type { EventRef, MessageRef, TaskRef, WindowRef } from "@4fu/arbor-interfaces";
import type { EventKind, EventPage, Journal } from "@4fu/arbor-interfaces";

export interface RefSeed {
  window: number;
  task: number;
  message: number;
}

/** The highest number a set of refs of one kind carries. */
export function highestOf(refs: readonly string[], prefix: string): number {
  let highest = 0;
  for (const ref of refs) {
    const match = new RegExp(`^${prefix}(\\d+)$`).exec(ref);
    if (match === null) continue;
    highest = Math.max(highest, Number(match[1]));
  }
  return highest;
}

/**
 * The newest events of some kinds. A list page runs in the global order from
 * the oldest event, and refs only grow, so the highest ref is on the last page.
 */
async function latest(journal: Journal, kinds: EventKind[]): Promise<EventPage> {
  const limit = 200;
  const first = await journal.list({ kinds, limit });
  if (first.total <= first.items.length) return first;
  return journal.list({ kinds, limit, offset: first.total - limit });
}

/** One allocator per kind, seeded from the journal. */
export class RefAllocator {
  private window: number;
  private task: number;
  private message: number;

  constructor(seed: Partial<RefSeed> = {}) {
    this.window = seed.window ?? 0;
    this.task = seed.task ?? 0;
    this.message = seed.message ?? 0;
  }

  /** Seed the allocator from the journal, so a restart continues the order. */
  static async from(journal: Journal): Promise<RefAllocator> {
    const started = await latest(journal, ["window_start"]);
    const tasks = await latest(journal, ["input", "task", "schedule"]);
    const messages = await latest(journal, ["window_message"]);
    return new RefAllocator({
      window: highestOf(
        started.items.map((event) => event.window ?? ""),
        "c",
      ),
      task: highestOf(
        tasks.items.flatMap((event) => event.refs),
        "t",
      ),
      message: highestOf(
        messages.items.flatMap((event) => event.refs),
        "m",
      ),
    });
  }

  nextWindow(): WindowRef {
    this.window += 1;
    return `c${this.window}`;
  }

  nextTask(): TaskRef {
    this.task += 1;
    return `t${this.task}`;
  }

  nextMessage(): MessageRef {
    this.message += 1;
    return `m${this.message}`;
  }
}

/** An event ref, for a tool call recorded at one. */
export function eventRefOf(ref: string): EventRef | undefined {
  return /^r\d+$/.test(ref) ? (ref as EventRef) : undefined;
}
