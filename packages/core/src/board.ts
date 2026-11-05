/**
 * The board: one line per live window, from the journal
 * (docs/coordination.md#the-board).
 *
 * A window owns no conversation, file or task, so the board is a view, not
 * state that outlives a window. What the model set with `board.set` and what it
 * declared with `board.expect` is recorded as events, so a restart rebuilds the
 * lines without asking a model.
 */

import type { BoardLine, Expectation, Ref, Target, WindowRef } from "@arbor/interfaces";
import type { TokenUsage } from "@arbor/interfaces";
import type { Event } from "@arbor/interfaces";

/** What the host knows about one live window, for its board line. */
export interface BoardEntry {
  window: WindowRef;
  doing: string;
  targets: readonly Target[];
  expects: readonly Expectation[];
  state: string;
  usage: TokenUsage;
  task?: Ref;
  startedAt: number;
}

export class Board {
  private readonly entries = new Map<WindowRef, BoardEntry>();

  /** Open a line for a window. */
  open(entry: BoardEntry): void {
    this.entries.set(entry.window, entry);
  }

  /** Close a line. An ended window is never reopened. */
  close(window: WindowRef): void {
    this.entries.delete(window);
  }

  /** Update a live line, from the window's own state. */
  update(window: WindowRef, change: { usage?: TokenUsage; state?: string; doing?: string }): void {
    const entry = this.entries.get(window);
    if (entry === undefined) return;
    this.entries.set(window, {
      ...entry,
      ...(change.usage === undefined ? {} : { usage: change.usage }),
      ...(change.state === undefined ? {} : { state: change.state }),
      ...(change.doing === undefined ? {} : { doing: change.doing }),
    });
  }

  get(window: WindowRef): BoardEntry | undefined {
    return this.entries.get(window);
  }

  entries_(): readonly BoardEntry[] {
    return [...this.entries.values()];
  }

  /** `board.set`: the first task's title until the model sets a line. */
  setDoing(window: WindowRef, doing: string): void {
    const entry = this.entries.get(window);
    if (entry === undefined) return;
    this.entries.set(window, { ...entry, doing });
  }

  /** Record a target the window touched. */
  touch(window: WindowRef, target: Target): void {
    const entry = this.entries.get(window);
    if (entry === undefined || entry.targets.includes(target)) return;
    this.entries.set(window, { ...entry, targets: [...entry.targets, target] });
  }

  /** `board.expect`: what the window expects to be routed to it. */
  addExpectation(window: WindowRef, expectation: Expectation): void {
    const entry = this.entries.get(window);
    if (entry === undefined) return;
    this.entries.set(window, { ...entry, expects: [...entry.expects, expectation] });
  }

  /** `board.unexpect`. */
  removeExpectation(window: WindowRef, ref: Ref): void {
    const entry = this.entries.get(window);
    if (entry === undefined) return;
    this.entries.set(window, { ...entry, expects: entry.expects.filter((one) => one.ref !== ref) });
  }

  /** The live view every window and every operator reads. */
  lines(): readonly BoardLine[] {
    return this.entries_().map((entry) => ({
      window: entry.window,
      doing: entry.doing,
      targets: entry.targets,
      expects: entry.expects,
      state: entry.state as BoardLine["state"],
      usage: entry.usage,
    }));
  }

  /**
   * Rebuild the lines the journal holds: what a window set and what it
   * declared. The usage and the state are the host's own, so a restart starts
   * them at zero and the model learns the real numbers from the next result.
   */
  rebuild(events: readonly Event[]): void {
    for (const event of events) {
      if (event.window === null) continue;
      const window = event.window;
      if (event.kind === "window_start") {
        const doing = readString(event, "doing");
        if (doing !== "" && !this.entries.has(window)) {
          this.entries.set(window, {
            window,
            doing,
            targets: [...event.targets],
            expects: [],
            state: "running",
            usage: { used: 0, limit: 0, reserve: 0 },
            startedAt: event.time,
          });
        }
        continue;
      }
      if (event.kind === "board_line") {
        const doing = readString(event, "doing");
        const entry = this.entries.get(window);
        if (doing !== "" && entry !== undefined) this.setDoing(window, doing);
        continue;
      }
      if (event.kind === "board_expect") {
        const entry = this.entries.get(window);
        const ref = readString(event, "ref");
        if (entry !== undefined && ref !== "") {
          this.addExpectation(window, {
            kind: readString(event, "kind") === "exact" ? "exact" : "described",
            ...(readString(event, "item") === "" ? {} : { item: readString(event, "item") }),
            ...(readString(event, "description") === "" ? {} : { description: readString(event, "description") }),
            ref: ref as Ref,
          });
        }
      }
    }
  }
}

/** One structured field of a host-owned event, read back after a restart. */
export function readString(event: Event, key: string): string {
  if (event.body === null) return "";
  try {
    const parsed = JSON.parse(event.body) as Record<string, unknown>;
    const value = parsed[key];
    return typeof value === "string" ? value : "";
  } catch {
    return "";
  }
}

/** One structured field of a host-owned event, as a number. */
export function readNumber(event: Event, key: string): number {
  if (event.body === null) return 0;
  try {
    const parsed = JSON.parse(event.body) as Record<string, unknown>;
    const value = parsed[key];
    return typeof value === "number" ? value : 0;
  } catch {
    return 0;
  }
}

/** The JSON one host-owned event carries in its body. */
export function hostBody(fields: Record<string, unknown>): string {
  return JSON.stringify(fields);
}
