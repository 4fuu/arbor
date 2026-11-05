/**
 * The window host: one implementation of every operation (docs/architecture.md#layers).
 *
 * The host owns the lifecycle a model cannot own for itself. It opens a window
 * with a frozen prefix and a first input, inserts deliveries and reminders at
 * tool-call boundaries, ends the window at its hard limit, opens a continuation
 * when work is unfinished, and rebuilds every running window from the journal
 * after a restart. Everything it did is in the journal, so a window that ends
 * loses nothing.
 *
 * It is also the dispatcher (docs/dispatch.md): for every task, the filter, the
 * hard rule, the judge and the act - and the coordinator that keeps parallel
 * windows current with each other (docs/coordination.md). The rules and the
 * fallbacks live here, in the service layer, around a judge that is replaceable.
 *
 * The host is also the service layer the tools call: `send`, `end`, `search`,
 * the board, the live windows, `reload` and the workspace all reach it here,
 * once (docs/architecture.md#layers). It runs the environment and the services
 * a model installed, and the hooks a deployment or a plugin added, at every
 * point docs/architecture.md#hooks names.
 */

import type {
  AgentBackend,
  Anchor,
  BoardLine,
  Block,
  CallContext,
  Delivery,
  Environment,
  EnvDraft,
  EnvItem,
  EnvItemName,
  EnvItemRef,
  EnvRef,
  EnvDelta,
  EffectExecutor,
  Event,
  EventRef,
  Handoff,
  Journal,
  Judge,
  MessageRef,
  ModelInfo,
  Note,
  NoteStore,
  NoteWriteInput,
  OpenWindowRequest,
  Page,
  Plugin,
  PromptSection,
  QueuedInput,
  ReloadContext,
  RenderedPrompt,
  Ref,
  Scheduler,
  ScheduledTask,
  ScheduledTaskInput,
  ServiceStatus,
  Settings,
  Supervisor,
  Task,
  TaskInput,
  TaskRef,
  Target,
  TextTable,
  ToolCall,
  ToolGroup,
  ToolResult,
  TokenUsage,
  OutsideEvent,
  WindowEndReason,
  WindowRef,
  ToolCallContext,
  WindowRuntimeState,
  SearchHit,
  SnapshotRef,
  WindowSession,
  WindowState,
  Workspace,
  WorkspaceMount,
  WorkspaceRef,
} from "@arbor/interfaces";
import { arborError } from "@arbor/errors";
import { isAbsolute, join } from "node:path";
import {
  REMINDER_TIERS,
  REMINDER_SERIES,
  Renderer,
  atHardLimit,
  dataBlock,
  environmentDeltaBlock,
  firstInputBlocks,
  nextReminderTier,
  outsideMessageBlock,
  reminderBlock,
  textOf,
  usedPercent,
  zhTextTable,
} from "@arbor/prompt";
import { Jev, scrubJson } from "@arbor/judge-jev";
import type { JevDecisionLog } from "@arbor/judge-jev";
import { callContext, type EnvCatalog, type LiveWindow, type ReloadOutcome, type SearchOutcome, type ToolServices } from "@arbor/tools";
import { ToolCatalog } from "@arbor/tools";
import { Board, hostBody, type BoardEntry } from "./board.ts";
import { Coordinator, type CoordinationHost } from "./coordination.ts";
import { Dispatcher, type DecisionRecord, type DispatchHost, type DispatchResult } from "./dispatch.ts";
import { EffectQueue, type EffectInput, type EffectQueueOptions } from "./effects.ts";
import { HookRunner } from "./hooks.ts";
import { HookedJournal } from "./hooked-journal.ts";
import { RefAllocator } from "./refs.ts";
import { DEFAULT_RETRY_MS, RuleScheduler } from "./scheduler.ts";
import type { PromptEpoch } from "./snapshot.ts";
import { SnapshotBuilder } from "./snapshot.ts";

/** How long an ended run stays open for a related input. 300 s. */
const DEFAULT_IDLE_SECONDS = 300;

/** Tokens held back from the model, for the final reminder. */
const DEFAULT_RESERVE_TOKENS = 4000;

/** The context window's token budget. */
const DEFAULT_CONTEXT_TOKENS = 200000;

/** How long a window protects the target it started on. 60 s. */
const DEFAULT_PROTECTION_SECONDS = 60;

/** The timers the host needs, so a test drives them by hand. */
export interface Timers {
  setTimeout(handler: () => void, ms: number): Timer;
  clearTimeout(timer: Timer): void;
}

export interface Timer {
  readonly id: unknown;
}

/** One live window, as the host runs it. */
export interface WindowRecord {
  window: WindowRef;
  task: TaskRef;
  state: WindowState;
  startedAt: number;
  usage: TokenUsage;
  /** The tiers of the reminder series already sent. */
  remindersSent: number;
  /** The model asked to end; the host ends the run at the next boundary. */
  ending: boolean;
  handoff?: Handoff;
  /** Insertion is paused, without ending the window. */
  paused: boolean;
  /** The model tier this window runs at; a continuation keeps it. */
  tier?: string;
  /** The target it is working on now, for the protection period. */
  currentTarget?: Target;
  /** The workspace mount, once the window touched files. */
  mount?: WorkspaceMount;
  workspaceRef?: WorkspaceRef;
  /** The event each tool call was recorded at, for its snapshot. */
  callEvents: Map<string, EventRef>;
  /** The window's session, once it is running. */
  session?: WindowSession;
  /** What is queued for this window and not inserted yet. */
  inbox: QueuedItem[];
  idleTimer?: Timer;
  protectionUntil: number | null;
  finalReminderSent: boolean;
}

/** One input waiting to enter a window, with what it would enter as. */
export interface QueuedItem extends QueuedInput {
  delivery: Delivery;
  /** The task an inserted task came from, so it can be dispatched again. */
  task?: TaskInput;
}

const systemTimers: Timers = {
  setTimeout: (handler, ms) => ({ id: setTimeout(handler, ms) }),
  clearTimeout: (timer) => clearTimeout(timer.id as ReturnType<typeof setTimeout>),
};

export interface ArborOptions {
  journal: Journal;
  backend: AgentBackend;
  /** The workspace implementation. Absent when a deployment never works with files. */
  workspace?: Workspace;
  /** The note store. Absent when notes are not configured. */
  notes?: NoteStore;
  settings?: Settings;
  /**
   * The judge. Defaults to Jev, the default `Judge`
   * (docs/dispatch.md#the-default-judge); the rule bounds and the fallbacks
   * stay here either way.
   */
  judge?: Judge;
  /** Insertion timing, backpressure and scheduled tasks. */
  scheduler?: Scheduler;
  /** Extra tool groups, from a plugin. */
  groups?: readonly ToolGroup[];
  /** The environment. Absent when a deployment has no `/env`. */
  environment?: Environment;
  /** The service supervisor. Absent when no service may run. */
  supervisor?: Supervisor;
  /** The plugins this host runs. Every part of one is optional. */
  plugins?: readonly Plugin[];
  /** Effect executors, from a plugin. */
  executors?: readonly EffectExecutor[];
  /** The one renderer, shared by the host and the backend. */
  renderer?: Renderer;
  table?: TextTable;
  /** The model a new window gets when settings map no tier. */
  defaultModel?: string;
  now?: () => number;
  /** The clock the idle timer uses. Tests pass a manual one. */
  timers?: Timers;
}

export class Arbor {
  readonly journal: Journal;
  readonly backend: AgentBackend;
  readonly board: Board;
  readonly effects: EffectQueue;
  readonly catalog: ToolCatalog;
  readonly renderer: Renderer;
  readonly snapshots: SnapshotBuilder;
  /** The hooks every plugin registered, in the order they registered. */
  readonly hooks: HookRunner;
  /** The dispatcher: filter, hard rule, judge, act (docs/dispatch.md). */
  readonly dispatcher: Dispatcher;
  /** The coordinator: staying current, notices, broadcasts, window messages. */
  readonly coordinator: Coordinator;
  /** Insertion timing, backpressure and scheduled tasks. */
  readonly scheduler: Scheduler;

  private readonly options: ArborOptions;
  private readonly table: TextTable;
  private refs: RefAllocator;
  private readonly windows = new Map<WindowRef, WindowRecord>();
  private readonly clock: () => number;
  private readonly timers: Timers;
  /** The service layer the tools call. One implementation of every operation. */
  readonly services: ToolServices;
  private started = false;
  /** The model a window gets when settings map no tier. */
  private fallbackModel: string | undefined;
  /** The judge. Jev by default; a deployment replaces it. */
  private readonly judge: Judge | undefined;
  /** New windows the backend's rate limits are holding back. */
  private readonly held: { task: TaskInput; tier?: string }[] = [];
  private retryTimer?: Timer;
  /** Every judge decision, so a threshold is tuned from real decisions. */
  private readonly decisions: DecisionRecord[] = [];
  /** The scrub over every string that leaves the host. */
  private readonly scrub: ((text: string) => string) | undefined;
  /** The queue id of the next input that waits for a window. */
  private nextQueueId = 0;
  /** The plugins this host runs, in the order they registered. */
  private readonly plugins: Plugin[] = [];
  /** The prompt sections the plugins registered, one per plugin. */
  private readonly sections: PromptSection[] = [];
  /** The environment as the catalog reads it, kept in step with every change. */
  private view: EnvCatalog = { items: [], modules: [], removed: [] };
  /** The revision each window last read of an item, for `reload`'s check. */
  private readonly reads = new Map<WindowRef, Map<string, number>>();
  /** Functions a delta removed, with the change that removed them. */
  private readonly removed = new Map<string, EnvRef>();
  /** The settings the host runs with, read from the environment at each change. */
  private settings: Settings | undefined;
  /** The environment, loaded once: the plugins' items installed, the catalog current. */
  private loading: Promise<void> | undefined;

  constructor(options: ArborOptions) {
    this.options = options;
    this.hooks = new HookRunner();
    this.journal = new HookedJournal(options.journal, this.hooks);
    this.backend = options.backend;
    this.table = options.table ?? zhTextTable;
    this.renderer = options.renderer ?? new Renderer({ table: this.table });
    this.clock = options.now ?? (() => Date.now());
    this.timers = options.timers ?? systemTimers;
    this.refs = new RefAllocator();
    this.board = new Board();
    this.settings = options.settings;
    const effects: EffectQueueOptions = { hooks: this.hooks };
    this.effects = new EffectQueue(this.journal, options.executors ?? [], effects);
    this.snapshots = new SnapshotBuilder({
      // The settings are read per epoch, because the model changes them itself.
      settings: () => this.settings,
      table: this.table,
      // The one renderer, shared with the backend, so a plugin's kinds and its
      // fixed strings reach every layer.
      renderer: this.renderer,
      ...(options.notes === undefined ? {} : { notes: options.notes }),
      ...(options.environment === undefined
        ? {}
        : {
            env: async () => (await options.environment?.list()) ?? [],
            envRevision: async () => (await options.environment?.revision()) ?? ("e0" as EnvRef),
          }),
      tools: () => this.catalog.tools(),
      modules: () => this.catalog.modules(),
      plugins: () => this.sections,
      now: this.clock,
      activeSet: (candidates, budget, judgeShare) => this.dispatcher.activeSet(candidates, budget, judgeShare),
    });
    this.scrub = scrubOf(this.settings);
    this.judge = options.judge ?? defaultJudge(options.settings, this.scrub, this.judgeRequest);
    this.scheduler =
      options.scheduler ??
      new RuleScheduler({
        now: this.clock,
        timers: this.timers,
        nextTask: () => this.refs.nextTask(),
        onDue: (tasks) => this.dispatchDue(tasks),
        ...(options.settings === undefined ? {} : { settings: options.settings }),
      });
    this.dispatcher = new Dispatcher(this.dispatchHost());
    this.coordinator = new Coordinator(this.coordinationHost());
    this.services = this.buildServices();
    this.catalog = new ToolCatalog({ services: this.services, groups: options.groups });
    for (const plugin of options.plugins ?? []) this.register(plugin);
    // A service's state change reaches the host, which records it and runs its
    // hooks (docs/environment.md#services).
    options.supervisor?.onStateChange?.((status) => this.serviceState(status));
    // A backend that runs windows in process takes the host's control: record a
    // call at its event, run it through the tool groups, end when asked to.
    const attach = (options.backend as { attachControl?: (control: WindowControl) => void }).attachControl;
    attach?.call(options.backend, this.windowControl());
  }

  /** The models the backend can run, for settings' tier mapping. */
  async models(): Promise<readonly ModelInfo[]> {
    return this.backend.models();
  }

  // ---- plugins ------------------------------------------------------------

  /**
   * Plug one in: its hooks, its block kinds and fixed strings on the one
   * renderer, its prompt section, its executors, and its skills and MCP servers
   * into `/env` (docs/architecture.md#plugins). A plugin adds; it never patches
   * the core.
   */
  register(plugin: Plugin): void {
    this.plugins.push(plugin);
    if (plugin.hooks !== undefined) this.hooks.register(plugin.hooks);
    const section = plugin.promptSection;
    if (section !== undefined) {
      this.sections.push(section);
      for (const spec of section.blocks) this.renderer.register(spec);
      if (section.text !== undefined) this.renderer.extend(section.text);
    }
    for (const executor of plugin.adapters?.effectExecutors ?? []) this.effects.addExecutor(executor);
    // A plugin's items arrive in `/env` on the next load, so its abilities reach
    // live windows as a delta and new ones through their prefix.
    this.loading = undefined;
  }

  /** The plugins this host runs, in the order they registered. */
  registered(): readonly Plugin[] {
    return [...this.plugins];
  }

  /** The criteria the plugins added for the judge, which dispatch reads. */
  judgeCriteria(): readonly { plugin: string; decision: string; criteria: readonly string[] }[] {
    return this.plugins.flatMap((plugin) =>
      (plugin.judgeCriteria ?? []).map((one) => ({
        plugin: plugin.name,
        decision: one.decision,
        criteria: one.criteria,
      })),
    );
  }

  // ---- the environment ---------------------------------------------------

  /**
   * The environment, loaded once: a plugin's items installed, the catalog's view
   * current and the settings read. A window's first turn waits for it, so a
   * plugin's abilities are in the prompt it opens with.
   */
  private async load(): Promise<void> {
    this.loading ??= this.loadEnvironment();
    await this.loading;
  }

  private async loadEnvironment(): Promise<void> {
    const environment = this.options.environment;
    if (environment === undefined) return;
    await this.installPluginItems();
    await this.refresh();
  }

  /** A plugin's skills and MCP servers, installed under the plugin's name. */
  private async installPluginItems(): Promise<void> {
    const environment = this.options.environment;
    if (environment === undefined) return;
    const items = await environment.list();
    for (const plugin of this.plugins) {
      const drafts: EnvDraft[] = [];
      for (const draft of [...(plugin.skills ?? []), ...(plugin.mcpServers ?? [])]) {
        if (items.some((item) => item.kind === draft.kind && item.name === draft.name)) continue;
        drafts.push(draft);
      }
      if (drafts.length === 0) continue;
      const revision = await environment.install(drafts);
      await this.journal.append({
        kind: "environment_revision",
        window: null,
        body: hostBody({ revision: revision.ref, plugin: plugin.name }),
        refs: [revision.ref],
      });
    }
  }

  /** The environment as the catalog reads it, and the settings the host runs with. */
  private async refresh(): Promise<void> {
    const environment = this.options.environment;
    if (environment === undefined) return;
    const items = await environment.list();
    const modules = items
      .filter((item: EnvItem) => item.kind === "mcp")
      .map((item) => ({
        name: item.name,
        description: item.description,
        functions: [...(item.functions ?? [])],
      }));
    for (const item of items) {
      if (item.kind !== "mcp") continue;
      for (const fn of item.functions ?? []) this.removed.delete(fn.name);
    }
    this.view = { items, modules, removed: [...this.removed].map(([name, ref]) => ({ name, ref })) };
    this.settings = await environment.settings();
  }

  /** What a window read, so `reload` knows which revision its draft is based on. */
  private noteRead(window: WindowRef, item: EnvItem): void {
    const key = `${item.kind}:${item.name}`;
    const reads = this.reads.get(window);
    if (reads === undefined) this.reads.set(window, new Map([[key, item.revision]]));
    else reads.set(key, item.revision);
  }

  /** The revision a window last read of an item, for `reload`'s conflict check. */
  private readRevision(window: WindowRef, kind: string, name: string): number | undefined {
    return this.reads.get(window)?.get(`${kind}:${name}`);
  }

  /**
   * `reload`: install drafts and remove items as one environment revision, then
   * broadcast the delta to every live window. A refusal changes nothing.
   */
  private async reload(
    window: WindowRef,
    request: { drafts: readonly EnvDraft[]; remove: readonly string[] },
  ): Promise<ReloadOutcome> {
    const environment = this.options.environment;
    if (environment === undefined) {
      throw arborError({
        code: "unavailable",
        rule: "env.absent",
        message: "环境：本主机没有配置环境",
        nextAction: "本主机没有配置环境。",
      });
    }
    const mount = await this.mountFor(window);
    const drafts: EnvDraft[] = [];
    for (const draft of request.drafts) {
      const current = this.view.items.find((item: EnvItem) => item.kind === draft.kind && item.name === draft.name);
      drafts.push({
        ...draft,
        path: mount === undefined || isAbsolute(draft.path) ? draft.path : join(mount.path, draft.path),
        copiedFrom: draft.copiedFrom ?? this.readRevision(window, draft.kind, draft.name) ?? current?.revision ?? 0,
      });
    }
    const context: ReloadContext = {
      window,
      drafts,
      ...(request.remove.length === 0 ? {} : { remove: request.remove }),
    };
    const allowed = await this.hooks.before("beforeReload", context);
    const before = await environment.revision();
    const revision = await environment.install(
      allowed.drafts,
      request.remove as readonly (EnvItemRef | EnvItemName)[],
    );
    await this.hooks.after("afterReload", { ...allowed, revision });
    await this.journal.append({
      kind: "environment_revision",
      window,
      body: hostBody({
        revision: revision.ref,
        changes: revision.changes.map((change) => `${change.change} ${change.item.kind} ${change.item.name}`),
      }),
      refs: [revision.ref],
    });
    // A removal never changes a prompt, but a call into what it removed is
    // refused with the ref of the change that removed it.
    for (const change of revision.changes) {
      if (change.change !== "removed" || change.item.kind !== "mcp") continue;
      for (const fn of change.item.functions ?? []) this.removed.set(fn.name, revision.ref);
    }
    // The prefix is rebuilt at most every `snapshot.min_interval`, so a change
    // reaches a window opened inside the same epoch as a delta in its first
    // input, and the next epoch folds it into the system prompt
    // (docs/windows.md#prompt-layout).
    await this.refresh();
    const delivered = await this.broadcastEnvironment(
      await environment.delta(before),
    );
    return { revision: revision.ref, changes: revision.changes, delivered };
  }

  /** What changed since a window's epoch, for its first input. */
  private async changesSince(epoch: PromptEpoch): Promise<Block[]> {
    const environment = this.options.environment;
    if (environment === undefined) return [];
    const current = await environment.revision();
    if (current === epoch.envRevision) return [];
    const delta = await environment.delta(epoch.envRevision);
    if (delta.items.length === 0) return [];
    return [environmentDeltaBlock(delta, this.clock())];
  }

  /**
   * What the backend calls while a window runs: record a call at its event, run
   * it through the tool groups, and say when the window should end.
   */
  windowControl(): WindowControl {
    return {
      recordToolCall: this.recordToolCall,
      runToolCall: this.runToolCall,
      endRequested: this.endRequested,
    };
  }

  /**
   * Rebuild the host from the journal: continue every window that was running
   * when the host stopped, the way the hard limit does
   * (docs/windows.md#restart). Effects already made are not made again.
   */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.refs = await RefAllocator.from(this.journal);
    // A host restart starts every installed service again, the way the framework
    // guarantees (docs/environment.md#services).
    await this.options.environment?.resume();
    await this.load();
    const board = await this.journal.list({ kinds: ["board_line", "board_expect"], limit: 200 });
    this.board.rebuild(board.items);
    const started = await this.journal.list({ kinds: ["window_start"], limit: 200 });
    const ended = await this.journal.list({ kinds: ["window_end"], limit: 200 });
    const finished = new Set(
      ended.items.map((event) => event.window).filter((one): one is WindowRef => one !== null),
    );
    for (const event of started.items) {
      if (event.window === null || finished.has(event.window)) continue;
      await this.continueWindow(event.window, { midTaskReset: true });
    }
    // The scheduled tasks come back from the journal, so a restart does not
    // lose a schedule that has not fired yet.
    const schedules = await this.journal.list({ kinds: ["schedule"], limit: 200 });
    const restored = schedules.items.flatMap((event) => {
      if (event.body === null) return [];
      try {
        const parsed = JSON.parse(event.body) as ScheduledTask | null;
        return parsed === null || typeof parsed.ref !== "string" ? [] : [parsed];
      } catch {
        return [];
      }
    });
    await this.scheduler.restore?.(restored);
  }

  /** Open a window for one task, at a model tier. */
  async open(task: TaskInput & { ref?: TaskRef }, tier?: string): Promise<WindowRecord> {
    await this.load();
    const window = this.refs.nextWindow();
    // A dispatched task already carries its ref, so the window names the task it
    // was opened for rather than a second one.
    const taskRef = task.ref ?? this.refs.nextTask();
    // A hook may change the task, or refuse the window altogether.
    const start = await this.hooks.before("windowStart", { window, task });
    const wanted = start.task;
    const reason = wanted.reason;
    await this.journal.append({
      kind: "window_start",
      window,
      body: hostBody({ task: taskRef, doing: reason, kind: wanted.kind }),
      targets: [...wanted.targets],
      refs: [taskRef],
    });
    const record = this.record(window, taskRef, reason, [...wanted.targets], tier);
    const epoch = await this.snapshots.epoch();
    const changes = await this.changesSince(epoch);
    const firstInput = this.renderer.render(
      firstInputBlocks({
        task: {
          ref: taskRef,
          kind: wanted.kind,
          reason,
          time: wanted.time,
          targets: wanted.targets,
          ...(wanted.source === undefined ? {} : { source: wanted.source }),
          content: [...wanted.content],
        },
        boardLines: this.relatedLines(wanted.targets),
        ...(changes.length === 0 ? {} : { changes }),
      }),
    );
    // Opening a window starts its first turn; the host keeps watching it.
    void this.run(record, { firstInput, epoch, limits: this.limits() });
    return record;
  }

  // ---- dispatch (docs/dispatch.md) ----------------------------------------

  /**
   * Route one task: whether a live window takes it or a new window opens. The
   * filter, the hard rule, the judge and the act, with the fallbacks around a
   * judge that may be unreachable.
   */
  async dispatch(task: TaskInput): Promise<DispatchResult> {
    return this.dispatcher.dispatch(task);
  }

  /**
   * Outside events in, tasks out. A chat source debounces per conversation, so
   * the events of one conversation become one task; batching is the source's
   * business, and this is the host's own grouping of what arrived together
   * (docs/dispatch.md#tasks).
   */
  async ingest(events: readonly OutsideEvent[]): Promise<readonly DispatchResult[]> {
    const groups = new Map<string, OutsideEvent[]>();
    for (const event of events) {
      const group = groups.get(event.target);
      if (group === undefined) groups.set(event.target, [event]);
      else group.push(event);
    }
    const results: DispatchResult[] = [];
    for (const [target, group] of groups) {
      results.push(
        await this.dispatch({
          kind: "batch",
          reason: `a message arrived in ${target}`,
          targets: [target],
          time: group[group.length - 1]?.time ?? this.clock(),
          content: group.map((event) => outsideMessageBlockOf(event)),
          events: group,
          source: group[0]?.source,
        }),
      );
    }
    return results;
  }

  /**
   * Open a window for a task, at a tier. There is no cap on windows: while the
   * backend reports rate limits the task waits in the queue, ordered by priority
   * and age, and is dispatched again when the limit clears
   * (docs/dispatch.md#backpressure).
   */
  private async openWindow(task: TaskInput, tier?: string): Promise<WindowRecord | null> {
    const rateLimit = await this.backend.rateLimits?.();
    const plan = await this.scheduler.admission({
      running: this.live().length,
      queued: [task],
      ...(rateLimit === undefined ? {} : { rateLimit }),
      now: this.clock(),
    });
    if (plan.wait || plan.open < 1) {
      this.held.push({ task, ...(tier === undefined ? {} : { tier }) });
      this.armRetry(plan.retryAfterMs);
      return null;
    }
    return this.open(task, tier);
  }

  /** Ask the backend about its rate limits again, and open what it lets open. */
  private armRetry(afterMs?: number): void {
    if (this.retryTimer !== undefined) return;
    this.retryTimer = this.timers.setTimeout(() => {
      this.retryTimer = undefined;
      void this.drainHeld();
    }, afterMs ?? DEFAULT_RETRY_MS);
  }

  /** Open the held windows the backend will take now, in the order they came. */
  private async drainHeld(): Promise<void> {
    while (this.held.length > 0) {
      const next = this.held[0] as { task: TaskInput; tier?: string };
      const rateLimit = await this.backend.rateLimits?.();
      const plan = await this.scheduler.admission({
        running: this.live().length,
        queued: [next.task],
        ...(rateLimit === undefined ? {} : { rateLimit }),
        now: this.clock(),
      });
      if (plan.wait || plan.open < 1) {
        this.armRetry(plan.retryAfterMs);
        return;
      }
      this.held.shift();
      await this.open(next.task, next.tier);
    }
  }

  /** The tasks whose scheduled time has come. */
  private async dispatchDue(tasks: readonly TaskInput[]): Promise<void> {
    for (const task of tasks) await this.dispatch(task);
  }

  /** One task's routing, for the host API and for a test. */
  async judgeDecisions(): Promise<readonly DecisionRecord[]> {
    return [...this.decisions];
  }

  /** Record one scheduled task, so it fires at its time. */
  async schedule(input: ScheduledTaskInput): Promise<TaskRef> {
    const ref = await this.scheduler.schedule(input);
    const stored = (await this.scheduler.list()).find((task) => task.ref === ref);
    await this.journal.append({
      kind: "schedule",
      // The whole schedule, so a restart restores what a firing dispatches.
      body: JSON.stringify(stored ?? { ref }),
      refs: [ref],
    });
    return ref;
  }

  /** Cancel one scheduled task. */
  async cancelSchedule(ref: TaskRef): Promise<void> {
    await this.scheduler.cancel(ref);
  }

  /** The scheduled tasks, soonest first. */
  async schedules(): Promise<readonly ScheduledTask[]> {
    return this.scheduler.list();
  }

  /** Pause insertion into a window without ending it. */
  async pause(window: WindowRef): Promise<void> {
    const record = this.windows.get(window);
    if (record === undefined || record.session === undefined) return;
    record.paused = true;
    await record.session.pause();
    this.board.update(window, { state: "paused" });
  }

  /** Resume a paused window, and let what waited for it in. */
  async resume(window: WindowRef): Promise<void> {
    const record = this.windows.get(window);
    if (record === undefined || record.session === undefined) return;
    record.paused = false;
    await record.session.resume();
    this.board.update(window, { state: record.state });
    await this.flush(record);
  }

  /**
   * Insert a delivery into a live window, at a tool-call boundary. The delivery
   * waits in the window's inbox; the insertion rules decide when it goes in
   * (docs/dispatch.md#insertion-timing).
   */
  async deliver(
    window: WindowRef,
    delivery: Delivery,
    options: { priority?: number; targets?: readonly Target[]; task?: TaskInput } = {},
  ): Promise<void> {
    const record = this.windows.get(window);
    if (record === undefined) {
      throw arborError({
        code: "not_found",
        rule: "window.not_found",
        message: `window: 没有窗口 ${window}`,
        nextAction: "用 windows.list 查看当前窗口。",
      });
    }
    if (record.state === "ended") {
      throw arborError({
        code: "refused",
        rule: "window.ended",
        message: `window: 窗口 ${window} 已结束`,
        nextAction: "把内容发给一个还在运行的窗口，或为它开一个新窗口。",
      });
    }
    this.nextQueueId += 1;
    record.inbox.push({
      id: `q${this.nextQueueId}`,
      kind: delivery.kind,
      targets: [...(options.targets ?? [])],
      priority: options.priority ?? 0,
      time: this.clock(),
      // Environment deltas and conversation updates are never held back.
      ...(delivery.kind === "environment_delta" || delivery.kind === "conversation_update"
        ? { unfiltered: true }
        : {}),
      delivery,
      ...(options.task === undefined ? {} : { task: options.task }),
    });
    await this.flush(record);
  }

  /**
   * Let what may enter a window in, now. The scheduler says which waiting inputs
   * may go in; the host steers those, queues the rest for after the run, holds
   * what the rules hold back, and dispatches again what a window past its final
   * usage reminder will never take.
   */
  private async flush(record: WindowRecord): Promise<void> {
    if (record.state === "ended" || record.paused || record.session === undefined) return;
    const plan = await this.scheduler.insertion({
      state: this.runtimeState(record),
      queued: record.inbox,
      now: this.clock(),
    });
    // The scheduler hands back the items it was given; the inbox holds them.
    const waiting = new Map(record.inbox.map((item) => [item.id, item]));
    const apply = async (items: readonly QueuedInput[], how: "steer" | "followUp" | "redispatch") => {
      for (const one of items) {
        const item = waiting.get(one.id);
        if (item === undefined) continue;
        removeFrom(record.inbox, item);
        if (how === "redispatch") {
          await this.redispatch(item);
          continue;
        }
        // A hook may change the delivery or drop it: a plugin that hides a note
        // from some windows does it here, before the block is steered in. With
        // no hook registered there is nothing to run, so the block goes in
        // without an extra hop.
        const allowed = this.hooks.empty
          ? { window: record.window, delivery: item.delivery }
          : await this.hooks.beforeDelivery({ window: record.window, delivery: item.delivery });
        if (allowed === null) continue;
        if (how === "steer") await record.session?.steer(allowed.delivery);
        else await record.session?.followUp(allowed.delivery);
      }
    };
    await apply(plan.insert, "steer");
    await apply(plan.followUp, "followUp");
    await apply(plan.redispatch, "redispatch");
  }

  /**
   * Dispatch a waiting input again, because the window it waited for will never
   * take it: it has had its final usage reminder
   * (docs/dispatch.md#insertion-timing). An inserted task is routed again from
   * the top; a delivery nobody will take any more is dropped.
   */
  private async redispatch(item: QueuedItem): Promise<void> {
    if (item.task === undefined) return;
    await this.dispatch(item.task);
  }

  /** The window's state as the insertion rules see it. */
  private runtimeState(record: WindowRecord): WindowRuntimeState {
    const entry = this.board.get(record.window);
    return {
      window: record.window,
      state: record.paused ? "paused" : record.state,
      startedAt: record.startedAt,
      ...(record.task === undefined ? {} : { task: record.task }),
      targets: entry?.targets ?? [],
      ...(record.currentTarget === undefined ? {} : { currentTarget: record.currentTarget }),
      paused: record.paused,
      protectionUntil: record.protectionUntil,
      finalReminderSent: record.finalReminderSent,
      usage: record.usage,
    };
  }

  /** End a window by hand, with a handoff when there is unfinished work. */
  async end(window: WindowRef, handoff?: Handoff): Promise<void> {
    const record = this.windows.get(window);
    if (record === undefined || record.session === undefined) return;
    await record.session.end(handoff, "model_ended");
  }

  /** The live windows, for the host API and `windows.list`. */
  live(): readonly WindowRecord[] {
    return [...this.windows.values()];
  }

  /** The board: one line per live window. */
  boardLines(): readonly BoardLine[] {
    return this.board.lines();
  }

  /** One query over the journal, the notes and the board (docs/tools.md). */
  async search(query: string, scope?: readonly string[]): Promise<SearchOutcome> {
    const wanted = scope ?? ["journal", "notes", "board"];
    const hits: SearchHit[] = [];
    const notes: { ref: Ref; title: string; summary: string }[] = [];
    const windows: { window: WindowRef; doing: string }[] = [];
    if (wanted.includes("journal")) {
      const page = await this.journal.search(query, { limit: 20 });
      hits.push(...page.items);
    }
    if (wanted.includes("notes") && this.options.notes !== undefined) {
      const page = await this.options.notes.search({ query });
      notes.push(...page.items.map((note) => ({ ref: note.ref, title: note.title, summary: note.summary })));
    }
    if (wanted.includes("board")) {
      for (const line of this.board.lines()) {
        if (line.doing.includes(query)) windows.push({ window: line.window, doing: line.doing });
      }
    }
    return {
      query,
      scope: wanted,
      hits,
      notes,
      windows,
      total: hits.length + notes.length + windows.length,
      nextCall: `search({ query: ${JSON.stringify(query)} })`,
    };
  }

  /** Release the host: end every window and stop draining effects. */
  async close(): Promise<void> {
    if (this.retryTimer !== undefined) {
      this.timers.clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
    this.held.length = 0;
    this.scheduler.close?.();
    for (const record of this.live()) {
      if (record.session === undefined) continue;
      await record.session.end(undefined, "host_restart");
    }
    // A service is resident, but it belongs to this host: the next one starts it
    // again from the item it installed (docs/environment.md#services).
    for (const item of this.view.items) {
      if (item.kind !== "service") continue;
      await this.options.supervisor?.stop(item.name).catch(() => {});
    }
    this.windows.clear();
  }

  // ---- the dispatch and coordination seams --------------------------------

  /** What the dispatcher may do here: the live windows, and the two actions. */
  private dispatchHost(): DispatchHost {
    const host = this;
    return {
      journal: this.journal,
      judge: this.judge,
      settings: this.current() ?? {},
      now: () => host.clock(),
      nextTask: () => host.refs.nextTask(),
      render: (blocks) => host.renderer.render(blocks),
      live: () => host.live(),
      boardLine: (window) => host.board.get(window),
      circulate: async (event) => host.coordinator.circulate(event),
      open: async (task, tier) => host.openWindow(task, tier),
      insert: async (record, task) => host.insert(record, task),
      logDecision: (record) => host.recordDecision(record),
    };
  }

  /** What the coordinator may do here. */
  private coordinationHost(): CoordinationHost {
    const host = this;
    return {
      journal: this.journal,
      dispatcher: this.dispatcher,
      now: () => host.clock(),
      nextMessage: () => host.refs.nextMessage(),
      live: () => host.live(),
      boardLine: (window) => host.board.get(window),
      // The coordinator only asks about windows it took from the live set.
      profile: async (window) => host.dispatcher.profile(host.windows.get(window) as WindowRecord),
      deliver: async (window, delivery, options) =>
        host.deliver(window, delivery, {
          ...(options.priority === undefined ? {} : { priority: options.priority }),
          ...(options.targets === undefined ? {} : { targets: options.targets }),
        }),
    };
  }

  /** Insert a task into a live window, as an inserted input. */
  private async insert(record: WindowRecord, task: Task): Promise<void> {
    for (const target of task.targets) this.board.touch(record.window, target);
    await this.deliver(record.window, this.dispatcher.deliveryOf(task), {
      priority: task.priority ?? 0,
      targets: task.targets,
      task,
    });
  }

  /** One judge decision, recorded so a threshold is tuned from real ones. */
  private recordDecision(record: DecisionRecord): void {
    this.decisions.push(record);
    void this.journal
      .append({
        kind: "judge_decision",
        body: JSON.stringify(this.scrub === undefined ? record : scrubRecord(record, this.scrub)),
      })
      .catch(() => {});
  }

  /** One judge request, as the judge itself reports it. */
  private judgeRequest = (log: JevDecisionLog): void => {
    void this.journal
      .append({
        kind: "judge_request",
        body: JSON.stringify(this.scrub === undefined ? log : (scrubJson(log, this.scrub) as JevDecisionLog)),
      })
      .catch(() => {});
  };

  // ---- the run loop -------------------------------------------------------

  /** Open one window's session and watch it until the window ends. */
  private async run(
    record: WindowRecord,
    input: { firstInput: string; epoch: PromptEpoch; limits: OpenWindowRequest["limits"]; continuation?: OpenWindowRequest["continuation"] },
  ): Promise<void> {
    let session: WindowSession;
    // The prompt a window opens with goes through `beforeModelRequest`, so a
    // plugin sees what the model will read before it reaches the backend. With
    // no hook registered the window opens without an extra hop.
    const asked = this.hooks.empty
      ? { system: input.epoch.system, memory: input.epoch.memory, envRevision: input.epoch.envRevision }
      : await this.modelRequest(record, input);
    if (asked === null) {
      await this.fail(record, arborError({
        code: "refused",
        rule: "model.request.refused",
        message: "window: 一个插件拒绝了这个窗口的模型请求",
        nextAction: "查看该插件的钩子记录，或换一个没有被拒绝的窗口。",
      }));
      return;
    }
    try {
      session = await this.backend.open({
        window: record.window,
        task: record.task,
        prompt: asked,
        tools: this.catalog.tools(),
        modules: this.catalog.modules(),
        model: await this.modelFor(record.tier),
        firstInput: input.firstInput,
        limits: input.limits,
        ...(input.continuation === undefined ? {} : { continuation: input.continuation }),
      });
    } catch (error) {
      await this.fail(record, error);
      return;
    }
    record.session = session;
    // What waited for the window while it was opening may go in now.
    await this.flush(record);
    const watching = this.watch(record, session);
    const outcome = await session.outcome();
    await watching;
    await this.settle(record, outcome.reason, outcome.handoff, outcome.usage);
  }

  /**
   * The prompt one window opens with, after `beforeModelRequest`. `null` means a
   * hook refused the request, so the window never reaches a model.
   */
  private async modelRequest(
    record: WindowRecord,
    input: { firstInput: string; epoch: PromptEpoch },
  ): Promise<RenderedPrompt | null> {
    try {
      const asked = await this.hooks.before("beforeModelRequest", {
        window: record.window,
        prompt: {
          system: input.epoch.system,
          memory: input.epoch.memory,
          envRevision: input.epoch.envRevision,
        },
        inputs: [dataBlock(input.firstInput)],
      });
      return asked.prompt;
    } catch {
      return null;
    }
  }

  /** Read a session's events until the window ends. */
  private async watch(record: WindowRecord, session: WindowSession): Promise<void> {
    try {
      for await (const event of session.events()) {
        this.arm(record);
        switch (event.kind) {
          case "usage":
            record.usage = event.usage;
            this.board.update(record.window, { usage: event.usage, state: "running" });
            await this.remind(record);
            break;
          case "steered":
            await this.recordDelivery(record.window, event.delivery);
            break;
          case "run_ended":
            record.state = record.ending ? "running" : "idle";
            this.board.update(record.window, { state: record.state });
            if (record.ending && record.session !== undefined) {
              await record.session.end(record.handoff, "model_ended");
            }
            break;
          default:
            break;
        }
      }
    } catch {
      // The session's stream closed with the window; the outcome carries why.
    }
  }

  /**
   * The reminder series (docs/windows.md#usage-reminders): at 15, 30 and 50 %
   * write down what a later window would need; at 60, 70 and 80 % also end the
   * window with a handoff; a final one at `window - 2 x reserve`. Only the
   * highest crossed tier is sent; the lower ones it jumped over are recorded as
   * sent with it.
   */
  private async remind(record: WindowRecord): Promise<void> {
    const tier = nextReminderTier(record.usage, record.remindersSent);
    if (tier === null) return;
    record.remindersSent = REMINDER_SERIES;
    if (tier.tier === "final") record.finalReminderSent = true;
    const time = this.clock();
    const delivery: Delivery = {
      kind: "reminder",
      refs: [],
      time,
      content: [
        reminderBlock({
          tier: tier.tier,
          index: REMINDER_TIERS.indexOf(tier) + 1,
          total: REMINDER_SERIES,
          used: record.usage.used,
          limit: record.usage.limit,
          percent: usedPercent(record.usage),
          time,
        }),
      ],
    };
    await this.journal.append({
      kind: "reminder",
      window: record.window,
      body: this.renderer.render([...delivery.content]),
      targets: [],
    });
    const session = record.session;
    if (session === undefined) return;
    if (record.state === "running") await session.steer(delivery);
    else await session.followUp(delivery);
    // A reminder changes what may still enter: after the final one, what is
    // waiting is dispatched again (docs/dispatch.md#insertion-timing).
    await this.flush(record);
    // The host ends the window by itself at its hard limit.
    if (atHardLimit(record.usage)) await session.end(undefined, "hard_limit");
  }

  /** The window ended: record it, then decide whether work goes on. */
  private async settle(
    record: WindowRecord,
    reason: WindowEndReason,
    handoff: Handoff | undefined,
    usage: TokenUsage,
  ): Promise<void> {
    this.disarm(record);
    record.state = "ended";
    record.usage = usage;
    const targets = this.board.get(record.window)?.targets ?? [];
    // A hook may change the handoff; a refusal is recorded with the end, and the
    // window still ends, because the model asked for it.
    const end = await this.hooks.windowEnd({ window: record.window, ...(handoff === undefined ? {} : { handoff }), reason });
    const wanted = end.context.handoff ?? handoff;
    await this.journal.append({
      kind: "window_end",
      window: record.window,
      body: hostBody({
        reason,
        used: usage.used,
        ...(wanted === undefined ? {} : { handoff: true }),
        ...(end.refused === undefined ? {} : { refused: end.refused.rule }),
      }),
      targets,
      ...(wanted === undefined ? {} : { refs: [...wanted.refs] }),
    });
    this.board.close(record.window);
    this.windows.delete(record.window);
    this.reads.delete(record.window);
    if (record.mount !== undefined) await record.mount.release().catch(() => {});
    const continues =
      wanted !== undefined || reason === "hard_limit" || reason === "host_restart";
    if (!continues) return;
    await this.continueWindow(record.window, {
      ...(wanted === undefined ? {} : { handoff: wanted }),
      midTaskReset: reason === "hard_limit",
      targets,
      ...(record.tier === undefined ? {} : { tier: record.tier }),
    });
  }

  /**
   * Open the continuation window. It forks the previous window's workspace and
   * keeps its watermarks, and its first input carries the previous window's ref
   * and handoff - or, after the hard limit, one host line saying the window was
   * reset mid-task.
   */
  private async continueWindow(
    previous: WindowRef,
    options: { handoff?: Handoff; midTaskReset?: boolean; targets?: readonly string[]; tier?: string },
  ): Promise<WindowRecord> {
    const window = this.refs.nextWindow();
    const taskRef = this.refs.nextTask();
    const reason = textOf(this.table, "continuation.reason", { window: previous });
    // A hook may change the handoff, or refuse the continuation.
    const continued = await this.hooks.before("windowContinue", {
      window,
      previous,
      ...(options.handoff === undefined ? {} : { handoff: options.handoff }),
      ...(options.midTaskReset === true ? { midTaskReset: true } : {}),
    });
    const epoch = await this.snapshots.epoch();
    const changes = await this.changesSince(epoch);
    const effects = await this.eventsOfKind(previous, "send");
    const openTasks = await this.taskOf(previous);
    const firstInput = this.renderer.render(
      firstInputBlocks({
        task: {
          ref: taskRef,
          kind: "batch",
          reason,
          time: this.clock(),
          targets: options.targets ?? [],
          content: [],
        },
        continuation: {
          previous,
          ...(continued.handoff === undefined ? {} : { handoff: continued.handoff }),
          ...(options.midTaskReset === true ? { midTaskReset: true } : {}),
          openTasks,
          effects,
        },
        ...(changes.length === 0 ? {} : { changes }),
      }),
    );
    await this.journal.append({
      kind: "window_start",
      window,
      body: hostBody({ task: taskRef, doing: reason, continuation: previous }),
      targets: [...(options.targets ?? [])],
      refs: [taskRef, previous],
    });
    const record = this.record(window, taskRef, reason, [...(options.targets ?? [])], options.tier);
    void this.run(record, {
      firstInput,
      epoch,
      limits: this.limits(),
      continuation: {
        previous,
        ...(continued.handoff === undefined ? {} : { handoff: continued.handoff }),
        ...(options.midTaskReset === true ? { midTaskReset: true } : {}),
      },
    });
    return record;
  }

  /** A window that never reached a model still ends, and its work goes on. */
  private async fail(record: WindowRecord, error: unknown): Promise<void> {
    this.disarm(record);
    record.state = "ended";
    await this.journal.append({
      kind: "window_end",
      window: record.window,
      body: hostBody({
        reason: "failed",
        error: error instanceof Error ? error.message : String(error),
      }),
    });
    this.board.close(record.window);
    this.windows.delete(record.window);
  }

  /** The task a window was opened for, so its continuation names it. */
  private async taskOf(window: WindowRef): Promise<TaskRef[]> {
    const page = await this.journal.list({ window, kinds: ["window_start"], limit: 1 });
    const body = page.items[0]?.body;
    if (body === undefined || body === null) return [];
    try {
      const parsed = JSON.parse(body) as { task?: string };
      return /^t\d+$/.test(parsed.task ?? "") ? [parsed.task as TaskRef] : [];
    } catch {
      return [];
    }
  }

  /** The effects a window already made, so a continuation never repeats one. */
  private async eventsOfKind(window: WindowRef, kind: string): Promise<EventRef[]> {
    const page = await this.journal.list({ window, kinds: [kind], limit: 50 });
    return page.items.map((event) => event.ref).reverse();
  }

  private async recordDelivery(window: WindowRef, delivery: Delivery): Promise<void> {
    await this.journal.append({
      kind: "delivery",
      window,
      body: this.renderer.render([...delivery.content]),
      refs: [...delivery.refs],
    });
  }

  /**
   * A service started, failed or stopped: recorded as an event with the service
   * as its target, so it is dispatched like any outside input
   * (docs/environment.md#services).
   */
  private async serviceState(status: ServiceStatus): Promise<void> {
    const event = await this.journal.append({
      kind: "service_state",
      body: hostBody({
        service: status.name,
        state: status.state,
        revision: status.revision,
        restarts: status.restarts,
        ...(status.lastError === undefined ? {} : { error: status.lastError.message }),
      }),
      targets: [`svc:${status.name}`],
    });
    // A failure is an input like any other: the windows that touched the service
    // are told about it (docs/environment.md#services).
    await this.coordinator.circulate(event);
    await this.hooks.after("serviceStateChange", { service: status.name, status: { ...status, refs: [event.ref] } });
  }

  // ---- the idle window ----------------------------------------------------

  /**
   * Keep an ended run open for a related input (docs/windows.md#lifecycle). The
   * timer is re-armed on every event, so a window that is working stays open and
   * one that has gone quiet ends.
   */
  private arm(record: WindowRecord): void {
    this.disarm(record);
    record.idleTimer = this.timers.setTimeout(() => {
      void this.idle(record);
    }, this.idleSeconds() * 1000);
  }

  private disarm(record: WindowRecord): void {
    if (record.idleTimer === undefined) return;
    this.timers.clearTimeout(record.idleTimer);
    record.idleTimer = undefined;
  }

  private async idle(record: WindowRecord): Promise<void> {
    if (record.state === "ended" || record.session === undefined) return;
    await record.session.end(undefined, "idle_timeout");
  }

  // ---- the service layer the tools call -----------------------------------

  private buildServices(): ToolServices {
    const host = this;
    return {
      table: this.table,
      journal: this.journal,
      ...(this.options.notes === undefined ? {} : { notes: this.options.notes }),
      ...(this.options.workspace === undefined ? {} : { workspace: this.options.workspace }),
      ...(this.options.environment === undefined ? {} : { environment: this.options.environment }),
      ...(this.options.supervisor === undefined ? {} : { supervisor: this.options.supervisor }),

      ensureWorkspace: async (window) => host.mountFor(window),
      endWindow: async (window, handoff) => host.endWindow(window, handoff),
      hasOpenWork: async (window) => host.hasOpenWork(window),
      writeNote: async (window, input) => host.writeNote(window, input),
      search: async (window, query, scope) => host.searchFor(window, query, scope),
      send: async (window, request) => host.send(window, request),

      board: async () => host.boardPage(),
      setBoardLine: async (window, doing) => host.setBoardLine(window, doing),
      expect: async (window, item, description) => host.expect(window, item, description),
      unexpect: async (window, ref) => host.unexpect(window, ref),

      windows: async () => host.liveWindows(),
      windowTranscript: async (window) => host.transcript(window),
      windowMessage: async (from, to, text, replyTo) => host.windowMessage(from, to, text, replyTo),
      broadcast: async (from, text) => host.broadcast(from, text),
      inbox: async (window) => host.inboxOf(window),

      envPaths: () => {
        const environment = this.options.environment;
        return environment === undefined
          ? undefined
          : { prefix: environment.mount, directory: environment.directory };
      },
      envCatalog: () => host.view,
      envItemAt: async (path) => host.itemAt(path),
      envRead: (window, item) => host.noteRead(window, item),
      reload: async (window, request) => host.reload(window, request),
      callMcp: async (server, fn, args) => {
        const environment = this.options.environment;
        if (environment === undefined) {
          throw arborError({
            code: "unavailable",
            rule: "env.absent",
            message: "环境：本主机没有配置环境",
            nextAction: "本主机没有配置环境。",
          });
        }
        return environment.call(server, fn, args);
      },
    };
  }

  /** The item a path under the mount belongs to, when it is one. */
  private async itemAt(path: string): Promise<EnvItem | undefined> {
    const mount = this.options.environment?.mount;
    if (mount === undefined) return undefined;
    const inside = path.startsWith(`${mount}/`) ? path.slice(mount.length + 1) : "";
    // The settings are one file at the root, not a directory of their own.
    if (inside === "settings.json") return this.view.items.find((item) => item.kind === "settings");
    const [kind, name] = inside.split("/");
    if (name === undefined) return undefined;
    const wanted = kind === "skills" ? "skill" : kind === "mcp" ? "mcp" : kind === "services" ? "service" : "settings";
    return this.view.items.find((item) => item.kind === wanted && (wanted === "settings" || item.name === name));
  }

  /** The window's own directory, created on first use. */
  private async mountFor(window: WindowRef): Promise<WorkspaceMount | undefined> {
    const workspace = this.options.workspace;
    if (workspace === undefined) return undefined;
    const record = this.windows.get(window);
    if (record?.mount !== undefined) return record.mount;
    const ref = await workspace.create(window);
    const mount = await workspace.mount(ref);
    if (record !== undefined) {
      record.mount = mount;
      record.workspaceRef = ref;
    }
    return mount;
  }

  /** `end`: the model ends the run, with a handoff when work is unfinished. */
  private async endWindow(window: WindowRef, handoff?: Handoff): Promise<ToolResult> {
    const record = this.windows.get(window);
    if (record === undefined) return this.refusal("window.not_found", "windows.notfound", { window });
    if (handoff === undefined && (await this.hasOpenWork(window))) {
      return this.refusal("end.handoff.required", "end.no_handoff");
    }
    record.ending = true;
    record.handoff = handoff;
    // A run that already ended leaves the window idle, so the host ends it now;
    // a run still going ends at the next boundary, the way the model asked.
    if (record.state === "idle" && record.session !== undefined) {
      await record.session.end(handoff, "model_ended");
    }
    return { callId: "", ok: true, content: textOf(this.table, "result.ended", { window }) };
  }

  /** True when the window is behind on a target it touched. */
  private async hasOpenWork(window: WindowRef): Promise<boolean> {
    const gaps = await this.journal.targetsBehind(window);
    return gaps.length > 0;
  }

  /**
   * One note write. The anchor is the host's: the window that wrote it, the
   * event the write is recorded at, and the refs the window cited
   * (docs/memory.md#anchors). The model never fills one in.
   */
  private async writeNote(window: WindowRef, input: NoteWriteInput): Promise<Note> {
    const notes = this.options.notes;
    if (notes === undefined) {
      throw arborError({
        code: "unavailable",
        rule: "notes.absent",
        message: "notes: 本主机没有配置笔记存储",
        nextAction: "本主机没有配置笔记存储。",
      });
    }
    const anchor: Anchor = { window, event: await this.lastEvent(window) };
    // A hook may change what the write carries; a refusal answers with the rule.
    const allowed = await this.hooks.before("beforeNoteWrite", { window, input });
    const note = await notes.write({
      ...allowed.input,
      anchor,
      refs: [...(input.refs ?? []), ...(await this.citedRefs(window))],
    });
    await this.hooks.after("afterNoteWrite", { window, input: allowed.input, revision: note.revision });
    // A revision is news about the note, so the windows working on it hear about
    // it (docs/coordination.md#notices).
    await this.circulateNewest("note_revision", note.id);
    return note;
  }

  /** The newest event of one kind on one target, so a write can circulate it. */
  private async circulateNewest(kind: string, target: string): Promise<void> {
    const page = await this.journal.list({ kinds: [kind], targets: [target], limit: 1 });
    const event = page.items[0];
    if (event === undefined) return;
    await this.coordinator.circulate(event);
  }

  /** The newest event a window wrote, for its next write's anchor. */
  private async lastEvent(window: WindowRef): Promise<EventRef> {
    const page = await this.journal.list({ window, limit: 1 });
    const last = page.items.at(-1);
    return last?.ref ?? ("r0" as EventRef);
  }

  /** The refs the window cited, for the write's evidence. */
  private async citedRefs(window: WindowRef): Promise<Ref[]> {
    const page = await this.journal.list({ window, kinds: ["tool_call"], limit: 1 });
    const last = page.items.at(-1);
    return last === undefined ? [] : [...last.refs];
  }

  private async searchFor(window: WindowRef, query: string, scope?: readonly string[]): Promise<SearchOutcome> {
    const found = await this.search(query, scope);
    for (const hit of found.hits) await this.see(window, hit.ref);
    return found;
  }

  /** A window saw an event, so its watermark moves forward. */
  private async see(window: WindowRef, ref: EventRef): Promise<void> {
    const event = await this.journal.get(ref);
    if (event === null) return;
    for (const target of event.targets) {
      await this.journal.advanceWatermark(window, target, event.seq);
    }
  }

  /** `send`: record the effect, queue it, and say when the window is behind. */
  private async send(
    window: WindowRef,
    request: { to: string; content: string; replyTo?: string; cites?: readonly Ref[] },
  ): Promise<{ event: EventRef; behind: number }> {
    const target = request.to.includes(":") ? request.to : `window:${request.to}`;
    const input: EffectInput = {
      kind: "send",
      target,
      content: [{ kind: "data", fields: { content: request.content } }],
      window,
      ...(request.replyTo === undefined ? {} : { replyTo: request.replyTo }),
      ...(request.cites === undefined ? {} : { cites: request.cites }),
    };
    const outcome = await this.effects.submit(input);
    await this.see(window, outcome.event);
    // A send is a new event on its target, so the windows in that conversation
    // stay current (docs/coordination.md#staying-current).
    const sent = await this.journal.get(outcome.event);
    if (sent !== null) await this.coordinator.circulate(sent);
    return outcome;
  }

  private async boardPage(): Promise<Page<BoardLine>> {
    const lines = this.boardLines();
    return { items: [...lines], total: lines.length, limit: lines.length, nextCall: "board.list()" };
  }

  private async setBoardLine(window: WindowRef, doing: string): Promise<void> {
    this.board.setDoing(window, doing);
    await this.journal.append({ kind: "board_line", window, body: hostBody({ doing }) });
  }

  private async expect(window: WindowRef, item?: string, description?: string): Promise<import("@arbor/interfaces").Expectation> {
    const ref = this.refs.nextMessage();
    const expectation = {
      kind: item === undefined ? ("described" as const) : ("exact" as const),
      ...(item === undefined ? {} : { item }),
      ...(description === undefined ? {} : { description }),
      ref,
    };
    this.board.addExpectation(window, expectation);
    await this.journal.append({
      kind: "board_expect",
      window,
      body: hostBody({ ...expectation }),
      refs: [ref],
    });
    return expectation;
  }

  private async unexpect(window: WindowRef, ref: Ref): Promise<void> {
    this.board.removeExpectation(window, ref);
  }

  private async liveWindows(): Promise<readonly LiveWindow[]> {
    return this.live().map((record) => {
      const entry = this.board.get(record.window);
      return {
        window: record.window,
        state: record.state,
        startedAt: record.startedAt,
        task: record.task,
        targets: entry?.targets ?? [],
        doing: entry?.doing ?? "",
        expects: entry?.expects ?? [],
        usage: record.usage,
      };
    });
  }

  /** A window's transcript, exactly as the model saw it. */
  private async transcript(window: WindowRef): Promise<readonly Event[]> {
    const page = await this.journal.list({ window, limit: 200 });
    return page.items;
  }

  /** A message to another live window. */
  private async windowMessage(from: WindowRef, to: WindowRef, text: string, replyTo?: Ref): Promise<MessageRef> {
    return this.coordinator.windowMessage(from, to, text, replyTo);
  }

  /** A message to every live window but this one. */
  private async broadcast(from: WindowRef, text: string): Promise<number> {
    return this.coordinator.broadcast(from, text);
  }

  /**
   * An environment delta to every live window, unfiltered and not held back by
   * the protection period (docs/coordination.md#broadcasts).
   */
  async broadcastEnvironment(delta: EnvDelta): Promise<number> {
    return this.coordinator.environmentDelta(delta);
  }

  private async inboxOf(window: WindowRef): Promise<{ ref: Ref; from: WindowRef; text: string }[]> {
    const record = this.windows.get(window);
    if (record === undefined) return [];
    const out: { ref: Ref; from: WindowRef; text: string }[] = [];
    for (const item of record.inbox) {
      const ref = item.delivery.refs[0];
      if (ref === undefined) continue;
      out.push({
        ref,
        from: item.delivery.from ?? window,
        text: this.renderer.render([...item.delivery.content]),
      });
    }
    return out;
  }

  private refusal(rule: string, key: string, args: Record<string, string | number> = {}): ToolResult {
    return {
      callId: "",
      ok: false,
      content: "",
      error: {
        rule,
        message: textOf(this.table, `refused.${key}`, args, key),
        nextAction: textOf(this.table, `next.${key}`, args) || undefined,
      },
    };
  }

  // ---- the window control the backend calls -------------------------------

  /**
   * Record one tool call before it runs, so a snapshot the call takes names the
   * event it happened at (docs/workspaces.md#what-the-framework-guarantees).
   */
  recordToolCall = async (window: WindowRef, call: ToolCall): Promise<EventRef | undefined> => {
    const record = this.windows.get(window);
    const event = await this.journal.append({
      kind: "tool_call",
      window,
      body: `${call.name} ${JSON.stringify(call.args)}`,
      targets: [],
    });
    record?.callEvents.set(call.callId, event.ref);
    return event.ref;
  };

  /**
   * Run one call through the tool groups - the same path a direct call takes -
   * then record its result and snapshot the directory the call changed.
   */
  runToolCall = async (window: WindowRef, call: ToolCall, at?: EventRef): Promise<ToolResult> => {
    const record = this.windows.get(window);
    const mount = record?.mount;
    const context: CallContext = callContext(window, {
      ...(record === undefined ? {} : { task: record.task }),
      ...(mount === undefined ? {} : { workspace: mount }),
      ...(at === undefined ? {} : { call: at }),
      ...(this.options.environment === undefined ? {} : { envRevision: await this.options.environment.revision() }),
    });
    // A hook may change the call or refuse it; a refusal answers in the core's
    // error shape, exactly like any other rule the host enforces. With no hook
    // registered the call runs without an extra hop.
    const allowed: ToolCallContext | Error = this.hooks.empty
      ? { window, call }
      : await this.hooks
          .before("beforeToolCall", { window, call })
          .catch((error: unknown) => (error instanceof Error ? error : new Error(String(error))));
    let result: ToolResult;
    if (allowed instanceof Error) {
      result = this.refusalOf(call, allowed);
    } else {
      result = await this.catalog.call(allowed.call, context).catch((error: unknown) => this.refusalOf(call, error));
    }
    if (!this.hooks.empty) await this.hooks.after("afterToolCall", { window, call, result });
    const changed = record?.mount ?? (await this.mountFor(window));
    let snapshot: SnapshotRef | null = null;
    if (changed !== undefined && record?.workspaceRef !== undefined && this.options.workspace !== undefined) {
      const handle = await this.options.workspace.snapshot(record.workspaceRef, at);
      snapshot = handle.ref;
    }
    await this.journal.append({
      kind: "tool_result",
      window,
      body: result.content === "" ? refusalText(result) : result.content,
      targets: [],
      ...(at === undefined ? {} : { refs: [at] }),
      snapshot,
    });
    return result;
  };

  /** One refusal, from a hook or from a call that threw, as a tool result. */
  private refusalOf(call: ToolCall, error: unknown): ToolResult {
    const info = error as { rule?: string; message?: string; nextAction?: string };
    return {
      callId: call.callId,
      ok: false,
      content: "",
      error: {
        rule: info.rule ?? "tool.failed",
        message: info.message ?? (error instanceof Error ? error.message : String(error)),
        ...(info.nextAction === undefined ? {} : { nextAction: info.nextAction }),
      },
    };
  }

  /** True once the window should end after the current turn. */
  endRequested = (window: WindowRef): boolean => {
    return this.windows.get(window)?.ending === true;
  };

  // ---- settings -----------------------------------------------------------

  /** The settings the host runs with: the environment's, or the seed it opened with. */
  private current(): Settings | undefined {
    return this.settings ?? this.options.settings;
  }

  private contextTokens(): number {
    return this.current()?.window?.contextTokens ?? DEFAULT_CONTEXT_TOKENS;
  }

  private reserveTokens(): number {
    return this.current()?.window?.reserveTokens ?? DEFAULT_RESERVE_TOKENS;
  }

  private idleSeconds(): number {
    return this.current()?.window?.idleSeconds ?? DEFAULT_IDLE_SECONDS;
  }

  private limits(): OpenWindowRequest["limits"] {
    return {
      contextTokens: this.contextTokens(),
      reserveTokens: this.reserveTokens(),
      idleSeconds: this.idleSeconds(),
    };
  }

  /**
   * The model a new window gets. Settings map each tier to a model from the
   * backend's catalog; a window that keeps its tier - a continuation - resolves
   * the same one (docs/dispatch.md#model-tiers). Without a mapping the host takes
   * the first model the backend can run, so a window opens even before the judge
   * and the settings exist.
   */
  private async modelFor(tier?: string): Promise<string> {
    const tiers = this.current()?.modelTiers ?? {};
    for (const wanted of [tier, this.current()?.defaultTier]) {
      if (wanted === undefined) continue;
      const mapped = tiers[wanted];
      if (mapped !== undefined) return mapped;
    }
    const first = Object.values(tiers)[0];
    if (first !== undefined) return first;
    if (this.options.defaultModel !== undefined) return this.options.defaultModel;
    if (this.fallbackModel === undefined) {
      const catalog = await this.backend.models();
      this.fallbackModel = catalog[0]?.id;
    }
    return this.fallbackModel ?? "default";
  }

  /** The board lines related to a task's targets. */
  private relatedLines(targets: readonly string[]): readonly BoardLine[] {
    return this.board.lines().filter((line) => line.targets.some((target) => targets.includes(target)));
  }

  /** Open a window's record and its board line. */
  private record(
    window: WindowRef,
    task: TaskRef,
    doing: string,
    targets: readonly string[],
    tier?: string,
  ): WindowRecord {
    const entry: BoardEntry = {
      window,
      doing,
      targets: [...targets],
      expects: [],
      state: "running",
      usage: { used: 0, limit: this.contextTokens(), reserve: this.reserveTokens() },
      task,
      startedAt: this.clock(),
    };
    const record: WindowRecord = {
      window,
      task,
      state: "running",
      startedAt: entry.startedAt,
      usage: entry.usage,
      remindersSent: 0,
      ending: false,
      paused: false,
      ...(tier === undefined ? {} : { tier }),
      ...(targets[0] === undefined ? {} : { currentTarget: targets[0] }),
      callEvents: new Map(),
      inbox: [],
      protectionUntil: this.clock() + (this.current()?.window?.protectionSeconds ?? DEFAULT_PROTECTION_SECONDS) * 1000,
      finalReminderSent: false,
    };
    this.windows.set(window, record);
    this.board.open(entry);
    for (const target of targets) this.board.touch(window, target);
    return record;
  }
}

/** What a refusal records: the rule and the one line the model reads. */
function refusalText(result: ToolResult): string {
  const error = result.error;
  if (error === undefined) return "";
  return `${error.rule} ${error.message}${error.nextAction === undefined ? "" : ` ${error.nextAction}`}`;
}

/** Take one item out of a window's inbox. */
function removeFrom(inbox: QueuedItem[], item: QueuedItem): void {
  const index = inbox.indexOf(item);
  if (index >= 0) inbox.splice(index, 1);
}

/** One outside event, as the input block it arrives as. */
function outsideMessageBlockOf(event: OutsideEvent): Block {
  return outsideMessageBlock({
    ...(event.external === undefined ? {} : { external: event.external }),
    source: event.source,
    time: event.time,
    ...(event.replyTo === undefined ? {} : { replyTo: event.replyTo }),
    content: [...event.content],
  });
}

/**
 * The default judge: Jev (docs/dispatch.md#the-default-judge). The key is read
 * per request, so one that appears later applies to the next decision, and a
 * host without one falls back on every decision's own rule.
 */
function defaultJudge(
  settings: Settings | undefined,
  scrub: ((text: string) => string) | undefined,
  onDecision: (log: JevDecisionLog) => void,
): Judge {
  return new Jev({
    ...(scrub === undefined ? {} : { scrub }),
    ...(settings?.judge?.maxCandidates === undefined ? {} : { maxItems: settings.judge.maxCandidates }),
    onDecision,
  });
}

/**
 * A scrub over every string that leaves the host, built from the secrets a
 * configuration names - never their values
 * (docs/architecture.md#data-placement). Every judge request goes through it on
 * the way out, and every decision log records the scrubbed form.
 */
function scrubOf(settings: Settings | undefined): ((text: string) => string) | undefined {
  const named = (settings?.secrets ?? []).flatMap((name) => {
    const value = process.env[name];
    return value === undefined || value === "" ? [] : [{ name, value }];
  });
  if (named.length === 0) return undefined;
  return (text: string) => {
    let out = text;
    for (const secret of named) out = out.split(secret.value).join(`[hidden:${secret.name}]`);
    return out;
  };
}

/** The same scrub over one decision record, on the way to the journal. */
function scrubRecord(record: DecisionRecord, scrub: (text: string) => string): DecisionRecord {
  return {
    ...record,
    state: scrubJson(record.state, scrub),
    ...(record.answer === undefined ? {} : { answer: scrubJson(record.answer, scrub) as DecisionRecord["answer"] }),
  };
}

export { Board, type BoardEntry, EffectQueue, HookRunner, HookedJournal, RefAllocator, SnapshotBuilder };
export type { LiveWindow, PromptEpoch, SearchOutcome, ToolServices };

/** What the host gives the backend about the window it is running. */
export interface WindowControl {
  recordToolCall(window: WindowRef, call: ToolCall): Promise<EventRef | undefined>;
  runToolCall(window: WindowRef, call: ToolCall, at?: EventRef): Promise<ToolResult>;
  endRequested(window: WindowRef): boolean;
}
