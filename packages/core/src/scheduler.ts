/**
 * The default `Scheduler`: insertion timing, backpressure and scheduled tasks,
 * by simple rules (docs/architecture.md#interfaces, docs/dispatch.md).
 *
 * The rules are the host's own and they never move: they decide *when* the host
 * calls the backend's steering, not what the model reads. Everything here is a
 * function of what it is handed - a window's state, the inputs waiting for it,
 * the clock - so a deployment that replaces this module keeps the same contract
 * and a test drives it without a model.
 *
 * What is *not* here: any cap on windows. There is none
 * (docs/dispatch.md#backpressure).
 */

import type {
  AdmissionPlan,
  AdmissionRequest,
  InsertionPlan,
  InsertionRequest,
  QueuedInput,
  ScheduledTask,
  ScheduledTaskInput,
  ScheduledTaskUpdate,
  Scheduler,
  Settings,
  SkipPeriod,
  TaskInput,
  TaskRef,
} from "@4fu/arbor-interfaces";
import type { Timers, Timer } from "./host.ts";

/** How long to wait before asking the backend about its rate limits again. */
export const DEFAULT_RETRY_MS = 5_000;

/** How far a repeating task may fall behind before its missed firings drop. */
const MAX_LATENESS_MS = 60_000;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The order waiting inputs enter a window in: the current target, then priority, then age. */
function compare(left: QueuedInput, right: QueuedInput, currentTarget: string | undefined): number {
  const leftCurrent = currentTarget !== undefined && left.targets.includes(currentTarget) ? 0 : 1;
  const rightCurrent = currentTarget !== undefined && right.targets.includes(currentTarget) ? 0 : 1;
  if (leftCurrent !== rightCurrent) return leftCurrent - rightCurrent;
  if (left.priority !== right.priority) return right.priority - left.priority;
  if (left.time !== right.time) return left.time - right.time;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function minutesOf(at: number): number {
  const date = new Date(at);
  return date.getUTCHours() * 60 + date.getUTCMinutes();
}

function startOfDay(at: number): number {
  const date = new Date(at);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

/** `HH:MM` as minutes after midnight, or undefined when it is not a clock. */
function clockMinutes(value: string): number | undefined {
  const match = /^(\d{1,2}):(\d{2})$/u.exec(value.trim());
  if (match === null) return undefined;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return undefined;
  return hours * 60 + minutes;
}

/** The moment the daily skip period a time falls in ends. */
function skipEnd(at: number, skip: readonly SkipPeriod[] | undefined): number {
  if (skip === undefined) return at;
  const minutes = minutesOf(at);
  for (const period of skip) {
    const from = clockMinutes(period.from);
    const to = clockMinutes(period.to);
    if (from === undefined || to === undefined) continue;
    const inside = from <= to ? minutes >= from && minutes < to : minutes >= from || minutes < to;
    if (!inside) continue;
    const end = startOfDay(at) + to * 60 * 1000;
    return end > at ? end : end + DAY_MS;
  }
  return at;
}

/** True when a time falls inside one of the daily skip periods. */
function insideSkip(at: number, skip: readonly SkipPeriod[] | undefined): boolean {
  if (skip === undefined || skip.length === 0) return false;
  const minutes = minutesOf(at);
  return skip.some((period) => {
    const from = clockMinutes(period.from);
    const to = clockMinutes(period.to);
    if (from === undefined || to === undefined) return false;
    // A period that crosses midnight wraps around.
    return from <= to ? minutes >= from && minutes < to : minutes >= from || minutes < to;
  });
}

/** The same clock time on the day after `at`. */
function nextDaily(dailyAt: string, at: number): number {
  const wanted = clockMinutes(dailyAt);
  if (wanted === undefined) return at + DAY_MS;
  const day = startOfDay(at) + DAY_MS;
  return day + wanted * 60 * 1000;
}

export interface RuleSchedulerOptions {
  /** The clock. Tests pass a fixed one. */
  now?: () => number;
  /** The timers the loop arms. Tests pass a manual one. */
  timers?: Timers;
  /** The task ref allocator, so a scheduled task's ref continues the one order. */
  nextTask?: () => TaskRef;
  /** Called with the tasks whose time has come. */
  onDue?: (tasks: readonly TaskInput[]) => void | Promise<void>;
  settings?: Settings;
}

/**
 * The default `Scheduler`. One timer is armed at a time, for the nearest firing,
 * so a host with many schedules waits on one timer rather than one each.
 */
export class RuleScheduler implements Scheduler {
  private readonly options: RuleSchedulerOptions;
  private readonly clock: () => number;
  private readonly timers: Timers;
  private readonly tasks = new Map<TaskRef, ScheduledTask>();
  private timer: Timer | undefined;
  private firing = false;

  constructor(options: RuleSchedulerOptions = {}) {
    this.options = options;
    this.clock = options.now ?? (() => Date.now());
    this.timers = options.timers ?? {
      setTimeout: (handler, ms) => ({ id: setTimeout(handler, ms) }),
      clearTimeout: (timer) => clearTimeout(timer.id as ReturnType<typeof setTimeout>),
    };
  }

  // ---- insertion timing ---------------------------------------------------

  /**
   * Which waiting inputs may enter a window now
   * (docs/dispatch.md#insertion-timing).
   *
   * - Paused: nothing is inserted and nothing is dispatched again - the window
   *   is held, not finished with.
   * - Past the final usage reminder: nothing is inserted and every waiting input
   *   is dispatched again.
   * - During the protection period: only inputs for the target the window
   *   started on, plus the kinds that are never held back. The others wait.
   * - After it: the current target first, then the others by priority and age.
   */
  async insertion(request: InsertionRequest): Promise<InsertionPlan> {
    const { state, queued, now } = request;
    if (state.state === "ended" || state.finalReminderSent) {
      return { insert: [], followUp: [], hold: [], redispatch: [...queued] };
    }
    if (state.paused) {
      return { insert: [], followUp: [], hold: [...queued], redispatch: [] };
    }
    const protecting = state.protectionUntil !== null && now < state.protectionUntil;
    const mayEnter = queued.filter((input) => {
      // Environment deltas and conversation updates are never held back.
      if (input.unfiltered === true) return true;
      if (!protecting) return true;
      return state.currentTarget !== undefined && input.targets.includes(state.currentTarget);
    });
    const insert = [...mayEnter].sort((left, right) => compare(left, right, state.currentTarget));
    const entering = new Set(insert.map((input) => input.id));
    return {
      insert,
      // A block that belongs after the run the window is in goes in as a
      // follow-up; the host's own reminders are those. Steering an idle window
      // continues it, which is what a related input wants.
      followUp: [],
      hold: queued.filter((input) => !entering.has(input.id)),
      redispatch: [],
    };
  }

  // ---- backpressure -------------------------------------------------------

  /**
   * How many new windows may open now. There is no cap: while the backend
   * reports rate limits nothing opens and the rest wait in the queue, ordered
   * by priority and age (docs/dispatch.md#backpressure).
   */
  async admission(request: AdmissionRequest): Promise<AdmissionPlan> {
    const limit = request.rateLimit;
    if (limit !== undefined && limit.limited) {
      return {
        open: 0,
        wait: true,
        ...(limit.retryAfterMs === undefined ? {} : { retryAfterMs: limit.retryAfterMs }),
        reason: "the backend reports rate limits",
      };
    }
    return { open: request.queued.length, wait: false };
  }

  // ---- scheduled tasks ----------------------------------------------------

  /** Record one scheduled task and arm the loop for its first firing. */
  async schedule(input: ScheduledTaskInput): Promise<TaskRef> {
    const ref = this.options.nextTask?.() ?? (`t${this.tasks.size + 1}` as TaskRef);
    const firstAt = Math.max(input.firstAt, this.clock()) + this.jitter();
    const task: ScheduledTask = {
      ref,
      ...(input.name === undefined ? {} : { name: input.name }),
      firstAt,
      nextAt: firstAt,
      ...(input.repeat === undefined ? {} : { repeat: input.repeat }),
      ...(input.skipDaily === undefined || input.skipDaily.length === 0
        ? {}
        : { skipDaily: [...input.skipDaily] }),
      targets: [...(input.targets ?? [])],
      paused: false,
      task: input.task,
    };
    this.tasks.set(ref, task);
    if (this.options.settings?.schedule?.spreadColliding === true) this.spread(task);
    this.arm();
    return ref;
  }

  /** Cancel one. A cancelled schedule fires no more. */
  async cancel(ref: TaskRef): Promise<void> {
    this.tasks.delete(ref);
    this.arm();
  }

  /**
   * Change a recorded schedule. A first time that moves, or a repeat rule that
   * is added, re-times the next firing from the new first time; anything else
   * leaves the next firing where it stands, and a skip period the change names
   * still pushes a firing that falls inside it past the period
   * (docs/dispatch.md#scheduled-tasks).
   */
  async update(ref: TaskRef, changes: ScheduledTaskUpdate): Promise<ScheduledTask | null> {
    const found = this.tasks.get(ref);
    if (found === undefined) return null;
    const merged: ScheduledTask = {
      ...found,
      ...(changes.name === undefined ? {} : { name: changes.name }),
      firstAt: changes.firstAt ?? found.firstAt,
      ...(changes.repeat === undefined ? {} : { repeat: changes.repeat }),
      ...(changes.skipDaily === undefined ? {} : { skipDaily: [...changes.skipDaily] }),
      ...(changes.targets === undefined ? {} : { targets: [...changes.targets] }),
      ...(changes.task === undefined ? {} : { task: changes.task }),
    };
    const retimed =
      changes.firstAt !== undefined || (changes.repeat !== undefined && found.repeat === undefined);
    const nextAt = retimed ? Math.max(merged.firstAt, this.clock()) + this.jitter() : found.nextAt;
    const stored: ScheduledTask = {
      ...merged,
      nextAt: insideSkip(nextAt, merged.skipDaily) ? skipEnd(nextAt, merged.skipDaily) : nextAt,
    };
    this.tasks.set(ref, stored);
    this.arm();
    return stored;
  }

  async list(): Promise<readonly ScheduledTask[]> {
    return [...this.tasks.values()].sort((left, right) => left.nextAt - right.nextAt);
  }

  /** Rebuild after a restart, from the journal's record of each schedule. */
  async restore(tasks: readonly ScheduledTask[]): Promise<void> {
    for (const task of tasks) this.tasks.set(task.ref, task);
    this.arm();
  }

  /** The tasks whose time has come, in the order they should be dispatched. */
  async due(now: number): Promise<readonly TaskInput[]> {
    const ready = [...this.tasks.values()]
      .filter((task) => !task.paused && task.nextAt <= now)
      .sort((left, right) => left.nextAt - right.nextAt || (left.ref < right.ref ? -1 : 1));
    const fired: TaskInput[] = [];
    for (const task of ready) {
      if (insideSkip(task.nextAt, task.skipDaily)) {
        // A firing inside a daily skip period moves past it rather than firing.
        this.tasks.set(task.ref, { ...task, nextAt: skipEnd(task.nextAt, task.skipDaily) });
        continue;
      }
      const body = task.task;
      if (body === undefined) continue;
      fired.push({ ...body, kind: "scheduled", source: body.source ?? "schedule" });
      this.advance(task, now);
    }
    this.arm();
    return fired;
  }

  /** Move a fired schedule to its next firing, or drop a finished one. */
  private advance(task: ScheduledTask, now: number): void {
    const repeat = task.repeat;
    if (repeat === undefined) {
      this.tasks.delete(task.ref);
      return;
    }
    let next: number;
    if ("everyMs" in repeat) {
      const elapsed = now - task.nextAt;
      next =
        elapsed > MAX_LATENESS_MS
          ? now
          : task.nextAt + (Math.floor(elapsed / repeat.everyMs) + 1) * repeat.everyMs;
    } else {
      next = nextDaily(repeat.dailyAt, task.nextAt);
    }
    const moved: ScheduledTask = { ...task, nextAt: next + this.jitter(), lastAt: now };
    this.tasks.set(task.ref, insideSkip(next, moved.skipDaily) ? this.skipAhead(moved) : moved);
  }

  /** Push a schedule past the daily period its next firing falls in. */
  private skipAhead(task: ScheduledTask): ScheduledTask {
    return { ...task, nextAt: skipEnd(task.nextAt, task.skipDaily) };
  }

  /** Spread colliding repeating tasks apart, so they do not fire together. */
  private spread(task: ScheduledTask): void {
    if (task.repeat === undefined || !("everyMs" in task.repeat)) return;
    for (const other of this.tasks.values()) {
      if (other.ref === task.ref) continue;
      if (other.repeat === undefined || !("everyMs" in other.repeat)) continue;
      if (Math.abs(other.nextAt - task.nextAt) >= task.repeat.everyMs) continue;
      this.tasks.set(task.ref, { ...task, nextAt: other.nextAt + task.repeat.everyMs });
      return;
    }
  }

  private jitter(): number {
    const jitterMs = this.options.settings?.schedule?.jitterMs ?? 0;
    return jitterMs <= 0 ? 0 : Math.floor(Math.random() * jitterMs);
  }

  /** One timer, for the nearest firing. */
  private arm(): void {
    if (this.timer !== undefined) {
      this.timers.clearTimeout(this.timer);
      this.timer = undefined;
    }
    const next = [...this.tasks.values()]
      .filter((task) => !task.paused)
      .reduce<number | null>(
        (nearest, task) => (nearest === null || task.nextAt < nearest ? task.nextAt : nearest),
        null,
      );
    if (next === null) return;
    this.timer = this.timers.setTimeout(() => {
      this.timer = undefined;
      void this.fire();
    }, Math.max(0, next - this.clock()));
  }

  /** Fire what is due, hand it to the host, and arm the loop again. */
  private async fire(): Promise<void> {
    if (this.firing) return;
    this.firing = true;
    try {
      const fired = await this.due(this.clock());
      if (fired.length > 0) await this.options.onDue?.(fired);
    } finally {
      this.firing = false;
    }
    this.arm();
  }

  /** Stop the loop, so a host that closes leaves no timer behind. */
  close(): void {
    if (this.timer === undefined) return;
    this.timers.clearTimeout(this.timer);
    this.timer = undefined;
  }
}
