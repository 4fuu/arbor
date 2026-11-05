/**
 * Dispatch: for every task, whether a live window takes it or a new window
 * opens (docs/dispatch.md).
 *
 * There is no main line and no router session. The order is fixed:
 *
 *  1. **Filter.** The judge decides whether the batch needs handling at all.
 *     An explicit request always passes.
 *  2. **Hard rule.** A batch that replies to or quotes something a live window
 *     produced, or that matches a window's exact expectation, goes to that
 *     window. Several matches go to the judge, which chooses among them.
 *  3. **Judge.** The candidates are the live windows that share a target with
 *     the task, describe an expectation, or worked recently - at most 8. The
 *     judge scores each against one more option: a new window.
 *  4. **Act.** The best candidate above the threshold takes the task as an
 *     inserted input; otherwise a new window opens, and its first input lists
 *     the live windows related to the task.
 *
 * The thresholds and the fallbacks live here, in code that never moves: when
 * the judge is unreachable, or a decision is `off` or `shadow`, that decision's
 * own documented fallback acts and nothing else changes. The judge answers what
 * it is asked and never moves a rule (packages/interfaces/src/judge.ts).
 */

import type {
  ActiveSetAnswer,
  ActiveSetBudget,
  Block,
  BoardLine,
  BroadcastAnswer,
  CandidateWindow,
  Delivery,
  Event,
  EventRef,
  FilterAnswer,
  Judge,
  JudgeAnswer,
  JudgeRequest,
  JudgeTask,
  Journal,
  ModelTierAnswer,
  NoticeAnswer,
  NoteRef,
  Ref,
  RouteAnswer,
  RouteScore,
  Settings,
  Task,
  TaskInput,
  TaskRef,
  WindowRef,
} from "@arbor/interfaces";
import { taskBlock } from "@arbor/prompt";
import { atHardLimit } from "@arbor/prompt";
import type { WindowRecord } from "./host.ts";

/**
 * Where each decision's threshold sits: the service layer's own, on the scale
 * the judge's own questions define, so a threshold is tuned from real decisions
 * (docs/dispatch.md#judge-decisions). A judge that answers with a bare boolean
 * and no score is read as it stands.
 */

/** A batch needs handling at probability 0.5. */
export const FILTER_THRESHOLD = 0.5;

/** A candidate takes the task at "good fit" or better, on the 0..3 route scale. */
export const ROUTE_THRESHOLD = 2;

/** A window needs a notice at probability 0.5. */
export const NOTICE_THRESHOLD = 0.5;

/** A window needs a broadcast at probability 0.5. */
export const BROADCAST_THRESHOLD = 0.5;

/** A note is still needed at the top level of the 0..2 active-set scale. */
export const ACTIVE_SET_THRESHOLD = 2;

/** How many candidate windows the route decision may score. At most 8. */
export const MAX_CANDIDATES = 8;

/** How far back a chain of replies between windows may go. */
export const MAX_REPLY_HOPS = 5;

/** How many of a window's taken tasks its profile carries. */
export const MAX_PROFILE_TASKS = 5;

/** How many of a window's last inputs its profile carries. */
export const MAX_PROFILE_INPUTS = 3;

/** How a task reached the window it went to. */
export type DispatchRoute = "filtered" | "hard_rule" | "judge" | "fallback" | "waiting" | "redelivered";

/** What one dispatch decided. */
export interface DispatchResult {
  task: TaskRef;
  /** The window that took the task, or null when none did. */
  window: WindowRef | null;
  route: DispatchRoute;
  /** The judge's answer, when it was asked. */
  answer?: JudgeAnswer;
  /** The tier a new window opened with. */
  tier?: string;
}

/** One judge decision as the host logs it. */
export interface DecisionRecord {
  decision: JudgeRequest["decision"];
  mode: JudgeRequest["mode"];
  /** The state the judge saw. */
  state: unknown;
  answer?: JudgeAnswer;
  ok: boolean;
  error?: string;
}

/** What the dispatcher needs from the host: the live windows and the two actions. */
export interface DispatchHost {
  readonly journal: Journal;
  /** The judge, when one is configured. */
  readonly judge: Judge | undefined;
  readonly settings: Settings | undefined;
  now(): number;
  nextTask(): TaskRef;
  /** Blocks to text, by the host's one renderer. */
  render(blocks: readonly Block[]): string;
  /** The live windows. */
  live(): readonly WindowRecord[];
  /** One window's board line, for its profile. */
  boardLine(window: WindowRef): BoardLine | undefined;
  /** A new event reached the windows already in it. */
  circulate?(event: Event): Promise<void>;
  /** Open a window for a task, at a tier. Null while backpressure holds it. */
  open(task: Task, tier?: string): Promise<WindowRecord | null>;
  /** Insert a task into a live window, under the insertion rules. */
  insert(record: WindowRecord, task: Task): Promise<void>;
  /** Every judge decision, for the log. */
  logDecision?(record: DecisionRecord): void;
  /**
   * The extra criteria the plugins registered for one decision, which ride on
   * the request the judge is asked with
   * (packages/interfaces/src/plugin.ts, `Plugin.judgeCriteria`).
   */
  criteria?(decision: JudgeRequest["decision"]): readonly string[];
}

export class Dispatcher {
  private readonly host: DispatchHost;

  constructor(host: DispatchHost) {
    this.host = host;
  }

  /**
   * Route one task. The task and the outside events it batches are recorded
   * first, so a ref names them before anything decides about them, and the new
   * events reach the windows already in them before anything routes.
   */
  async dispatch(task: TaskInput): Promise<DispatchResult> {
    const taskRef = this.host.nextTask();
    const recorded = await this.record(task, taskRef);
    // Every outside event in the batch is one the journal already holds, so the
    // message is stored once and the delivery is not new input: nothing is
    // recorded for it and nothing is routed (docs/journal.md#external-ids). A
    // window that already answered it is not asked to answer it again.
    if (recorded === null) {
      return { task: taskRef, window: null, route: "redelivered" };
    }
    const full: Task = { ...task, ref: taskRef, eventRefs: recorded.eventRefs, refs: recorded.refs };
    for (const event of recorded.events) await this.host.circulate?.(event);
    if (!(await this.filter(full))) {
      return { task: taskRef, window: null, route: "filtered" };
    }
    const matched = await this.matched(full);
    if (matched.length === 1) {
      const record = matched[0] as WindowRecord;
      await this.host.insert(record, full);
      return { task: taskRef, window: record.window, route: "hard_rule" };
    }
    const candidates = await this.candidates(full, matched);
    const routed = await this.route(full, candidates);
    if (routed.window !== null) {
      await this.host.insert(routed.window, full);
      return {
        task: taskRef,
        window: routed.window.window,
        route: routed.answer === undefined ? "fallback" : "judge",
        ...(routed.answer === undefined ? {} : { answer: routed.answer }),
      };
    }
    const tier = await this.tier(full);
    const opened = await this.host.open(full, tier);
    if (opened === null) {
      return { task: taskRef, window: null, route: "waiting", tier };
    }
    return {
      task: taskRef,
      window: opened.window,
      route: routed.answer === undefined ? "fallback" : "judge",
      tier,
      ...(routed.answer === undefined ? {} : { answer: routed.answer }),
    };
  }

  // ---- 1. filter ----------------------------------------------------------

  /**
   * One request, with the criteria its plugins registered for this decision.
   * A criterion steers the wording of the question and never enters its state,
   * so it changes what the judge is asked, not what it is shown
   * (packages/interfaces/src/judge.ts).
   */
  private ask<S>(decision: JudgeRequest["decision"], mode: JudgeRequest["mode"], state: S): JudgeRequest {
    const criteria = this.host.criteria?.(decision) ?? [];
    return {
      decision,
      mode,
      state,
      ...(criteria.length === 0 ? {} : { criteria }),
    } as JudgeRequest;
  }

  /**
   * Does the batch need handling? An explicit request always passes. The judge
   * decides the rest; a decision that is `off`, `shadow`, unanswered or
   * unreachable passes the batch, which is this decision's own fallback.
   */
  private async filter(task: Task): Promise<boolean> {
    if (task.explicit === true) return true;
    const mode = this.modeOf("filter");
    const state = { task: judgeTask(task), explicit: false };
    if (mode === "off") return true;
    const judge = this.host.judge;
    if (judge === undefined) return true;
    try {
      const answer = (await judge.decide(this.ask("filter", mode, state))) as FilterAnswer;
      this.log("filter", mode, state, answer);
      if (mode === "shadow") return true;
      return thresholded(answer, FILTER_THRESHOLD);
    } catch (error) {
      this.failed("filter", mode, state, error);
      return true;
    }
  }

  // ---- 2. the hard rule ---------------------------------------------------

  /**
   * The windows the hard rule sends this task to: one that produced something
   * the batch replies to or quotes, or that expects exactly this. Several
   * matches go to the judge, which chooses among them
   * (docs/coordination.md#expectations).
   */
  private async matched(task: Task): Promise<readonly WindowRecord[]> {
    const quoted = await this.quoting(task);
    return this.host
      .live()
      .filter((record) => this.mayTake(record))
      .filter((record) => quoted.has(record.window) || this.expects(record, task).length > 0);
  }

  /** The live windows that produced something the batch replies to or quotes. */
  private async quoting(task: Task): Promise<Set<WindowRef>> {
    const windows = new Set<WindowRef>();
    const live = new Set(this.host.live().map((record) => record.window));
    for (const ref of await this.namedRefs(task)) {
      let page;
      try {
        page = await this.host.journal.links(ref, { limit: 50 });
      } catch {
        continue;
      }
      for (const item of page.items) {
        // The batch names what it answers; a window that named the same thing
        // is the one that produced it.
        if (item.direction !== "in") continue;
        if (item.window === null || !live.has(item.window)) continue;
        windows.add(item.window);
      }
    }
    return windows;
  }

  /** The refs the batch names: what its events carry, and what a reply answers. */
  private async namedRefs(task: Task): Promise<readonly Ref[]> {
    const refs = new Set<Ref>(task.refs);
    for (const event of task.events ?? []) {
      for (const ref of event.refs ?? []) refs.add(ref);
      if (event.replyTo === undefined) continue;
      const stored = await this.storedEvent(event.replyTo);
      if (stored !== null) refs.add(stored);
    }
    return [...refs];
  }

  /** The stored event an outside message's native id names. */
  private async storedEvent(external: string): Promise<Ref | null> {
    const page = await this.host.journal.list({ external, kinds: ["input", "send"], limit: 5 });
    return page.items[0]?.ref ?? null;
  }

  /**
   * The event a native id is already stored as, or null when it is new. The
   * journal's unique index on `external` is what makes a redelivered message
   * stored once (docs/journal.md#external-ids); this is the read that tells a
   * redelivery from a new message before anything is appended for it.
   */
  private async stored(external: string): Promise<Event | null> {
    const page = await this.host.journal.list({ external, kinds: ["input"], limit: 1 });
    return page.items[0] ?? null;
  }

  /** The exact expectations of one window that this task answers. */
  private expects(record: WindowRecord, task: Task): readonly string[] {
    const line = this.host.boardLine(record.window);
    const wanted = new Set<string>([...task.targets, ...task.refs]);
    for (const event of task.events ?? []) {
      if (event.external !== undefined) wanted.add(event.external);
      if (event.replyTo !== undefined) wanted.add(event.replyTo);
    }
    return (line?.expects ?? [])
      .filter((one) => one.kind === "exact" && one.item !== undefined)
      .map((one) => one.item as string)
      .filter((item) => wanted.has(item));
  }

  // ---- 3. the judge -------------------------------------------------------

  /**
   * One window's profile, assembled by the host with no extra model call: its
   * board line, the targets it touched, its expectations, its tasks and its
   * last inputs (docs/dispatch.md#judge-decisions).
   */
  async profile(record: WindowRecord): Promise<CandidateWindow> {
    const line = this.host.boardLine(record.window);
    const started = await this.host.journal.list({ window: record.window, kinds: ["window_start"], limit: 20 });
    const inputs = await this.host.journal.list({
      window: record.window,
      kinds: ["delivery", "input"],
      limit: 20,
    });
    return {
      window: record.window,
      doing: line?.doing ?? "",
      targets: [...(line?.targets ?? [])],
      expects: (line?.expects ?? []).map((one) => one.description ?? one.item ?? one.ref),
      state: record.state === "running" ? "running" : "idle",
      usage: { used: record.usage.used, limit: record.usage.limit },
      tasks: started.items
        .slice(-MAX_PROFILE_TASKS)
        .reverse()
        .map((event) => doingOf(event.body)),
      lastInputs: inputs.items.slice(-MAX_PROFILE_INPUTS).map((event) => ({
        ref: event.ref,
        summary: openingWords(event.body),
      })),
      finalReminderSent: record.finalReminderSent,
    };
  }

  /**
   * The candidates, ranked and bounded: the live windows that share a target
   * with the task, describe an expectation, or worked recently. A window that
   * is still open worked within its idle period, so every live window is a
   * candidate; the ones that share a target come first, because a bounded
   * request asks about the strongest ones.
   *
   * A window that has had its final usage reminder, or is near its hard limit,
   * is not a candidate (docs/dispatch.md#routing).
   */
  private async candidates(
    task: Task,
    matched: readonly WindowRecord[],
  ): Promise<readonly CandidateWindow[]> {
    const first = new Set(matched.map((record) => record.window));
    const shared = (profile: CandidateWindow): number =>
      profile.targets.filter((target) => task.targets.includes(target)).length;
    const rank = (profile: CandidateWindow): number =>
      first.has(profile.window) ? 0 : shared(profile) > 0 ? 1 : profile.expects.length > 0 ? 2 : 3;
    const profiles: CandidateWindow[] = [];
    for (const record of this.host.live()) {
      if (!this.mayTake(record)) continue;
      profiles.push(await this.profile(record));
    }
    profiles.sort((left, right) => {
      const leftRank = rank(left);
      const rightRank = rank(right);
      if (leftRank !== rightRank) return leftRank - rightRank;
      if (shared(left) !== shared(right)) return shared(right) - shared(left);
      // A window with more room left is the better candidate.
      const leftShare = left.usage.limit > 0 ? left.usage.used / left.usage.limit : 1;
      const rightShare = right.usage.limit > 0 ? right.usage.used / right.usage.limit : 1;
      if (leftShare !== rightShare) return leftShare - rightShare;
      return left.window < right.window ? -1 : left.window > right.window ? 1 : 0;
    });
    const bound = this.host.settings?.judge?.maxCandidates ?? MAX_CANDIDATES;
    return profiles.slice(0, Math.max(1, Math.min(MAX_CANDIDATES, bound)));
  }

  /**
   * How well each candidate fits, against a new window. The judge decides; a
   * decision that is `off`, `shadow`, unanswered or unreachable falls back to a
   * new window, which is this decision's own fallback.
   */
  private async route(
    task: Task,
    candidates: readonly CandidateWindow[],
  ): Promise<{ window: WindowRecord | null; answer?: RouteAnswer }> {
    const mode = this.modeOf("route");
    const state = { task: judgeTask(task), candidates };
    const none: { window: WindowRecord | null; answer?: RouteAnswer } = { window: null };
    if (mode === "off") return none;
    const judge = this.host.judge;
    if (judge === undefined) return none;
    let answer: RouteAnswer;
    try {
      answer = (await judge.decide(this.ask("route", mode, state))) as RouteAnswer;
    } catch (error) {
      this.failed("route", mode, state, error);
      return none;
    }
    this.log("route", mode, state, answer);
    if (mode === "shadow") return none;
    const best = bestOf(answer, candidates);
    if (best === null) return none;
    const record = this.host.live().find((one) => one.window === best);
    if (record === undefined || !this.mayTake(record)) return none;
    return { window: record, answer };
  }

  // ---- 4. act -------------------------------------------------------------

  /**
   * Which tier a new window needs. The judge picks among the configured tiers,
   * each described by what settings say it is for, so a deployment whose tiers
   * are not the judge's own names them itself; a decision that is `off`,
   * `shadow`, unanswered or unreachable falls back to the default tier, then the
   * first configured one.
   */
  private async tier(task: Task): Promise<string | undefined> {
    const tiers = Object.keys(this.host.settings?.modelTiers ?? {});
    if (tiers.length === 0) return this.host.settings?.defaultTier;
    const mode = this.modeOf("model_tier");
    const criteria = this.host.settings?.judge?.tierCriteria;
    const state = {
      task: judgeTask(task),
      tiers,
      ...(criteria === undefined ? {} : { criteria }),
    };
    if (mode === "off") return this.defaultTier(tiers);
    const judge = this.host.judge;
    if (judge === undefined) return this.defaultTier(tiers);
    let answer: ModelTierAnswer;
    try {
      answer = (await judge.decide(this.ask("model_tier", mode, state))) as ModelTierAnswer;
    } catch (error) {
      this.failed("model_tier", mode, state, error);
      return this.defaultTier(tiers);
    }
    this.log("model_tier", mode, state, answer);
    if (mode === "shadow") return this.defaultTier(tiers);
    return tiers.includes(answer.tier) ? answer.tier : this.defaultTier(tiers);
  }

  private defaultTier(tiers: readonly string[]): string | undefined {
    const configured = this.host.settings?.defaultTier;
    if (configured !== undefined && tiers.includes(configured)) return configured;
    return tiers[0];
  }

  // ---- the other decisions ------------------------------------------------

  /**
   * The notice decision: which of the windows that touched the event's target
   * need to know about it. A decision that is `off`, `shadow`, unanswered or
   * unreachable sends no notice, which is this decision's own fallback.
   */
  async notice(
    event: { ref: Ref; kind: string; target: string; summary: string },
    candidates: readonly CandidateWindow[],
  ): Promise<readonly WindowRef[]> {
    const mode = this.modeOf("notice");
    const state = { event, candidates };
    if (mode === "off" || candidates.length === 0) return [];
    const judge = this.host.judge;
    if (judge === undefined) return [];
    let answer: JudgeAnswer;
    try {
      answer = await judge.decide(this.ask("notice", mode, state));
    } catch (error) {
      this.failed("notice", mode, state, error);
      return [];
    }
    this.log("notice", mode, state, answer);
    if (mode === "shadow") return [];
    return (answer as NoticeAnswer).windows
      .filter((one) => thresholded(one, NOTICE_THRESHOLD))
      .map((one) => one.window)
      .filter((window) => candidates.some((candidate) => candidate.window === window));
  }

  /**
   * The broadcast decision: which live windows need this broadcast.
   * Environment deltas are never filtered. A decision that is `off`, `shadow`,
   * unanswered or unreachable delivers, which is this decision's own fallback -
   * a delivery is never the harmful action.
   */
  async broadcast(
    broadcast: { from: WindowRef | null; summary: string; refs: readonly Ref[] },
    candidates: readonly CandidateWindow[],
    unfiltered = false,
  ): Promise<readonly WindowRef[]> {
    const every = candidates.map((candidate) => candidate.window);
    if (unfiltered) return every;
    const mode = this.modeOf("broadcast");
    const state = { broadcast, candidates };
    if (mode === "off") return every;
    const judge = this.host.judge;
    if (judge === undefined) return every;
    let answer: JudgeAnswer;
    try {
      answer = await judge.decide(this.ask("broadcast", mode, state));
    } catch (error) {
      this.failed("broadcast", mode, state, error);
      return every;
    }
    this.log("broadcast", mode, state, answer);
    if (mode === "shadow") return every;
    return (answer as BroadcastAnswer).windows
      .filter((one) => thresholded(one, BROADCAST_THRESHOLD))
      .map((one) => one.window)
      .filter((window) => candidates.some((candidate) => candidate.window === window));
  }

  /**
   * The active set decision: which notes are still needed, within the judge's
   * bounded share. The share is additive and never outweighs the rule score, so
   * this only names notes the rule score did not pick
   * (docs/memory.md#the-active-set). A decision that is `off`, `shadow`,
   * unanswered or unreachable leaves the rule score alone.
   */
  async activeSet(
    notes: readonly { ref: NoteRef; summary: string; score: number }[],
    budget: ActiveSetBudget,
    judgeShare: number,
  ): Promise<readonly NoteRef[]> {
    const mode = this.modeOf("active_set");
    const state = { notes, budget, judgeShare };
    if (mode === "off") return [];
    const judge = this.host.judge;
    if (judge === undefined) return [];
    let answer: JudgeAnswer;
    try {
      answer = await judge.decide(this.ask("active_set", mode, state));
    } catch (error) {
      this.failed("active_set", mode, state, error);
      return [];
    }
    this.log("active_set", mode, state, answer);
    if (mode === "shadow") return [];
    const scores = (answer as ActiveSetAnswer).scores;
    return notes
      .filter((note) => levelOf({ ...(scores === undefined ? {} : { scores }) }, note.ref) >= ACTIVE_SET_THRESHOLD)
      .map((note) => note.ref);
  }

  // ---- the host's own bounds ---------------------------------------------

  /**
   * True when a window may still take work: it is live, it has not had its final
   * usage reminder and it is not near its hard limit
   * (docs/dispatch.md#routing).
   */
  mayTake(record: WindowRecord): boolean {
    if (record.state === "ended") return false;
    if (record.finalReminderSent) return false;
    return !atHardLimit(record.usage);
  }

  /** One decision's mode. Every decision is `on` by default. */
  private modeOf(decision: JudgeRequest["decision"]): JudgeRequest["mode"] {
    return this.host.settings?.judge?.modes?.[decision] ?? "on";
  }

  /** The delivery an inserted task enters a window as. */
  deliveryOf(task: Task): Delivery {
    return {
      kind: "inserted_task",
      refs: [task.ref, ...task.refs],
      time: this.host.now(),
      content: [taskBlock({ ...task, time: task.time })],
    };
  }

  /** Record the task and the outside events it batches. */
  private async record(
    task: TaskInput,
    taskRef: TaskRef,
  ): Promise<{ eventRefs: readonly EventRef[]; refs: readonly Ref[]; events: readonly Event[] } | null> {
    const eventRefs: EventRef[] = [];
    const refs = new Set<Ref>();
    const events: Event[] = [];
    const batched = task.events ?? [];
    for (const event of batched) {
      const carried = [...(event.refs ?? []), ...(event.replyTo === undefined ? [] : [event.replyTo])];
      // A native id the journal already holds is a redelivery. The message is
      // stored once, so it is not appended again and it is not news: the refs it
      // names still ride on the task, so what it answers stays reachable.
      if (event.external !== undefined && (await this.stored(event.external)) !== null) {
        for (const ref of carried) refs.add(ref);
        refs.add(event.external);
        if (event.replyTo !== undefined) refs.add(event.replyTo);
        continue;
      }
      const appended = await this.host.journal.append({
        kind: "input",
        body: this.host.render(event.content),
        targets: [event.target],
        ...(event.external === undefined ? {} : { external: event.external }),
        refs: carried,
        time: event.time,
      });
      eventRefs.push(appended.ref);
      events.push(appended);
      for (const ref of carried) refs.add(ref);
      if (event.external !== undefined) refs.add(event.external);
      if (event.replyTo !== undefined) refs.add(event.replyTo);
    }
    // A task made without outside events - a scheduled firing, a service event,
    // a direct open - always has its own record; a batch of nothing but
    // redeliveries has none.
    if (batched.length > 0 && events.length === 0) return null;
    const carried = [...refs];
    await this.host.journal.append({
      kind: "task",
      body: JSON.stringify({
        task: taskRef,
        kind: task.kind,
        reason: task.reason,
        ...(task.source === undefined ? {} : { source: task.source }),
        explicit: task.explicit === true,
      }),
      targets: [...task.targets],
      refs: [taskRef, ...eventRefs, ...carried],
      links: [
        ...eventRefs.map((ref) => ({ kind: "origin" as const, to: ref })),
        ...carried.map((ref) => ({ kind: "cite" as const, to: ref })),
      ],
      time: task.time,
    });
    return { eventRefs, refs: carried, events };
  }

  private log(
    decision: JudgeRequest["decision"],
    mode: JudgeRequest["mode"],
    state: unknown,
    answer: JudgeAnswer,
  ): void {
    this.host.logDecision?.({ decision, mode, state, answer, ok: true });
  }

  private failed(
    decision: JudgeRequest["decision"],
    mode: JudgeRequest["mode"],
    state: unknown,
    error: unknown,
  ): void {
    this.host.logDecision?.({
      decision,
      mode,
      state,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** The task as the judge sees it: its targets, its reason and its content. */
export function judgeTask(task: Task): JudgeTask {
  return {
    ref: task.ref,
    kind: task.kind,
    reason: task.reason,
    targets: [...task.targets],
    content: [...task.content],
    time: task.time,
  };
}

/** A bool answer, read through the service layer's own threshold. */
export function thresholded(
  answer: { needs?: boolean; needsHandling?: boolean; score?: number },
  threshold: number,
): boolean {
  if (answer.score !== undefined) return answer.score >= threshold;
  return (answer.needs ?? answer.needsHandling) === true;
}

/** One note's level, from the active set answer's own scores. */
function levelOf(
  answer: { scores?: readonly { ref: NoteRef; score: number }[] },
  ref: NoteRef,
): number {
  const found = answer.scores?.find((entry) => entry.ref === ref);
  return found?.score ?? Number.NEGATIVE_INFINITY;
}

/**
 * The best of a route answer, or null when nothing is good enough. The judge
 * names the best of the items it was asked about; the threshold is the service
 * layer's own, and a candidate the request could not ask about is never best.
 */
function bestOf(answer: RouteAnswer, candidates: readonly CandidateWindow[]): WindowRef | null {
  const best = answer.best;
  if (best === "new") return null;
  const score = (answer.scores as readonly RouteScore[]).find((entry) => entry.item === best)?.score;
  if (score === undefined || score < ROUTE_THRESHOLD) return null;
  if (!candidates.some((candidate) => candidate.window === best)) return null;
  return best;
}

/** What a window's start event says it was opened for. */
function doingOf(body: string | null): string {
  if (body === null) return "";
  try {
    const parsed = JSON.parse(body) as { doing?: unknown };
    return typeof parsed.doing === "string" ? parsed.doing : "";
  } catch {
    return "";
  }
}

/** An event's opening words, for a one-line profile. */
function openingWords(body: string | null): string {
  if (body === null) return "";
  return body.replace(/\s+/gu, " ").trim().slice(0, 80);
}
