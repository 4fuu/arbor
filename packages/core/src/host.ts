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
  Channel,
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
  ExternalTool,
  Handoff,
  Journal,
  Judge,
  MessageRef,
  ModelInfo,
  Note,
  NoteRef,
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
  ScheduledTaskUpdate,
  ServiceStatus,
  Settings,
  StreamEvent,
  Supervisor,
  Task,
  TaskInput,
  TaskKind,
  TaskRef,
  TaskSource,
  Target,
  TextTable,
  ToolCall,
  ToolGroup,
  ToolResult,
  TokenUsage,
  OutsideEvent,
  Unsubscribe,
  WindowEndReason,
  WindowRef,
  ToolCallContext,
  WindowRuntimeState,
  SearchHit,
  WindowSession,
  WindowState,
  Workspace,
  WorkspaceMount,
} from "@4fu/arbor-interfaces";
import { arborError } from "@4fu/arbor-errors";
import { isAbsolute, join } from "node:path";
import { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT } from "@4fu/arbor-interfaces";
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
} from "@4fu/arbor-prompt";
import { Jev } from "@4fu/arbor-judge-jev";
import type { JevDecisionLog } from "@4fu/arbor-judge-jev";
import {
  callContext,
  type EnvCatalog,
  type ExternalToolRefusal,
  type LiveWindow,
  type ReloadOutcome,
  type SearchOutcome,
  type TaskRecord,
  type ToolServices,
  type TaskSummary,
} from "@4fu/arbor-tools";
import { ToolCatalog } from "@4fu/arbor-tools";
import { Board, hostBody, readString, type BoardEntry } from "./board.ts";
import { Coordinator, type CoordinationHost } from "./coordination.ts";
import { Dispatcher, type DecisionRecord, type DispatchHost, type DispatchResult } from "./dispatch.ts";
import { EffectQueue, type EffectInput, type EffectQueueOptions } from "./effects.ts";
import { HookRunner } from "./hooks.ts";
import { HookedJournal } from "./hooked-journal.ts";
import { RefAllocator } from "./refs.ts";
import { DEFAULT_RETRY_MS, RuleScheduler } from "./scheduler.ts";
import { hostCredentialNames, SecretScrub } from "./scrub.ts";
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

/**
 * How many of the newest task events a lookup by task ref searches. A task ref
 * is not an event ref, so the record is found among the task events the host
 * wrote; the bound keeps one lookup inside one page, the way the restart
 * recovery reads the schedules it restores.
 */
const MAX_TASK_LOOKUP = MAX_PAGE_LIMIT;

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
  /**
   * Set when this window is the continuation of one whose model call failed.
   * One interrupted continuation is enough: a model service that stays down
   * must not chain windows for ever (docs/windows.md#model-failures).
   */
  interrupted?: boolean;
  /** The target it is working on now, for the protection period. */
  currentTarget?: Target;
  /** The workspace mount, once the window touched files. */
  mount?: WorkspaceMount;
  /** The event each tool call was recorded at. */
  callEvents: Map<string, EventRef>;
  /** The window's session, once it is running. */
  session?: WindowSession;
  /** The window's run, from opening to its end, so `close` can wait for it. */
  running?: Promise<void>;
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
  /**
   * Where a secret's value comes from, for the names `settings.secrets` gives.
   * Defaults to `process.env`; a deployment that holds its secrets elsewhere
   * resolves them here (docs/architecture.md#data-placement).
   */
  secretOf?: (name: string) => string | undefined;
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
  /** True once `close` released this host, so nothing new opens a session. */
  private closed = false;
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
  private readonly secrets: SecretScrub;
  /** Where a named secret's value comes from. `process.env` by default. */
  private readonly secretOf: (name: string) => string | undefined;
  /** The queue id of the next input that waits for a window. */
  private nextQueueId = 0;
  /**
   * The chains whose last window ended and whose directory is waiting out the
   * retention period, by the window the chain started from.
   */
  private readonly retentionTimers = new Map<WindowRef, Timer>();
  /** The plugins this host runs, in the order they registered. */
  private readonly plugins: Plugin[] = [];
  /** The channels those plugins registered, in the order they registered. */
  private readonly registeredChannels: Channel[] = [];
  /** The task sources those plugins registered, in the order they registered. */
  private readonly registeredTaskSources: TaskSource[] = [];
  /** The push sources the host took, so `close` lets them go. */
  private readonly subscriptions: Unsubscribe[] = [];
  /**
   * The live output each window is handing on, so its deltas stay in order and
   * are never waited for (docs/windows.md#streaming).
   */
  private readonly streaming = new Map<WindowRef, Promise<void>>();
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
    // A host's own copy of the framework's table: the workspace implementation
    // and every plugin merge their own strings into the table this host renders
    // with, and one host's strings must never reach another's - the directory
    // workspace and the ovnfs workspace restate the same keys with their own
    // wording (docs/workspaces.md#prompt-text).
    this.table = options.table ?? { ...zhTextTable };
    this.renderer = options.renderer ?? new Renderer({ table: this.table });
    this.clock = options.now ?? (() => Date.now());
    this.timers = options.timers ?? systemTimers;
    this.refs = new RefAllocator();
    this.board = new Board();
    this.settings = options.settings;
    this.secretOf = options.secretOf ?? ((name: string) => process.env[name]);
    this.secrets = new SecretScrub(this.table);
    this.refreshSecrets(this.settings);
    const effects: EffectQueueOptions = {
      hooks: this.hooks,
      table: this.table,
      // An effect's result goes back to the window that made it, and to the
      // other windows in the conversation (docs/coordination.md#effects).
      onResult: async (event) => {
        await this.coordinator.circulate(event);
      },
    };
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
    this.judge = options.judge ?? defaultJudge(options.settings, this.secrets, this.judgeRequest);
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
    // The workspace implementation contributes its own prompt section - the
    // method the model follows for changing files - rendered in its own tag, so
    // a host that fell back to another implementation shows that one's instead
    // (docs/workspaces.md).
    this.addWorkspaceSection();
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
   * The workspace implementation's own prompt section, if it contributes one,
   * registered the way a plugin's is: its block kinds on the renderer, its
   * fixed strings merged into the table (docs/workspaces.md#prompt-text).
   *
   * The strings are merged into the host's own table as well as the renderer's,
   * because the layers the core renders itself - a continuation's first input,
   * a refusal - read the implementation's wording when it has one, and fall
   * back to nothing when it has none.
   */
  private addWorkspaceSection(): void {
    const section = this.options.workspace?.promptSection?.(this.table);
    if (section === undefined) return;
    this.sections.push(section);
    for (const spec of section.blocks) this.renderer.register(spec);
    if (section.text !== undefined) {
      this.renderer.extend(section.text);
      Object.assign(this.table, section.text);
    }
  }

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
    // A channel is an outside source: the host takes its push source at `start`
    // and ingests what arrives (docs/dispatch.md#tasks). A channel a deployment
    // only uses as a sink is simply never subscribed to.
    for (const channel of plugin.adapters?.channels ?? []) this.registeredChannels.push(channel);
    // A task source claims the outside events of the source it names, and
    // batches them its own way - so a burst of messages becomes the one task
    // the source says it is, and the host does no debouncing of its own
    // (docs/dispatch.md#tasks). One with a push source of its own is subscribed
    // at `start`, exactly the way a channel is.
    for (const source of plugin.adapters?.taskSources ?? []) this.registeredTaskSources.push(source);
    // The plugin's own direct tools, declared to the model and called in the
    // turn (docs/tools.md#external-tools). A name the model already has is not
    // registered, and the collision is recorded with its rule.
    this.registerExternal(plugin.tools ?? [], plugin.name);
    // A plugin's items arrive in `/env` on the next load, so its abilities reach
    // live windows as a delta and new ones through their prefix.
    this.loading = undefined;
  }

  /**
   * Direct tools declared from outside the core: a plugin's own, or the ones a
   * backend injects from the harness the host is embedded in
   * (docs/tools.md#external-tools). Both take the same shape and reach the
   * model the same way, so there is one path and not two.
   *
   * A name the model already has is not registered - a core tool always wins,
   * and so does the tool that arrived first. That is recorded with its rule
   * rather than thrown: the operator sees which tool of which source was left
   * out, and the window keeps working.
   */
  private registerExternal(tools: readonly ExternalTool[], source: string): void {
    if (tools.length === 0) return;
    this.recordRefusals(this.catalog.external(tools, source));
  }

  /** One journal event per tool that was not registered, with the rule. */
  private recordRefusals(refused: readonly ExternalToolRefusal[]): void {
    for (const one of refused) {
      void this.journal
        .append({
          kind: "tool_registration",
          window: null,
          body: hostBody({ source: one.source, tool: one.name, rule: one.rule }),
          targets: [],
        })
        .catch(() => {});
    }
  }

  /** The plugins this host runs, in the order they registered. */
  registered(): readonly Plugin[] {
    return [...this.plugins];
  }

  /** The channels the plugins registered, in the order they registered. */
  channels(): readonly Channel[] {
    return [...this.registeredChannels];
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
    this.loading ??= this.loadHost();
    await this.loading;
  }

  /** What the host loads once, before the first window opens. */
  private async loadHost(): Promise<void> {
    // The tools a backend injects from the harness the host is embedded in are
    // declared to the model like any other direct tool
    // (docs/tools.md#external-tools). They are read once, here, so the first
    // window opens with them.
    const injected = this.backend.externalTools === undefined ? [] : await this.backend.externalTools();
    this.registerExternal(injected, this.backend.name);
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
    // The settings name the secrets, and the model may change them: the scrub
    // is refreshed with them, so a name that appears or disappears takes effect
    // (docs/architecture.md#data-placement).
    this.refreshSecrets(this.settings);
  }

  /** Read the named secrets again, so a settings change reaches the scrub. */
  private refreshSecrets(settings: Settings | undefined): void {
    // The configured names, and every host variable that looks like a
    // credential: a child process inherits the host's environment, so those
    // are as reachable as a configured one (docs/architecture.md#secret-values).
    const host = hostCredentialNames(process.env);
    const names = [...new Set([...(settings?.secrets ?? []), ...host])];
    const hostNames = new Set(host);
    this.secrets.refresh(names, (name) => this.secretOf(name) ?? (hostNames.has(name) ? process.env[name] : undefined));
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
        message: textOf(this.table, "refused.env.absent"),
        nextAction: textOf(this.table, "next.env.absent"),
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
   * when the host stopped, and every window a `close` stopped, the way the hard
   * limit does (docs/windows.md#restart). Effects already made are not made
   * again.
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
    // A window `close` stopped comes back here: its own end is the record of the
    // stop, and the reason it carries is what tells the two apart. Every other
    // end is final, and the continuation it opened - when it opened one - is
    // already in the journal as its own `window_start`.
    const finished = new Set(
      ended.items
        .filter((event) => event.window !== null && readString(event, "reason") !== "host_restart")
        .map((event) => event.window as WindowRef),
    );
    for (const event of started.items) {
      if (event.window === null || finished.has(event.window)) continue;
      await this.continueWindow(event.window, { midTaskReset: true });
    }
    // A chain whose last window ended before this restart keeps its directory
    // for the retention period that end started, not one this restart starts:
    // the journal says when the chain's last window ended, so a restart in the
    // middle of the period still reclaims on time
    // (docs/workspaces.md#lifecycle).
    const continued = new Set<WindowRef>();
    for (const event of started.items) {
      if (event.window === null) continue;
      const previous = continuedWindow(event.body);
      if (previous !== undefined) continued.add(previous);
    }
    for (const event of ended.items) {
      // A window another window continues is not its chain's last, and one a
      // `close` stopped comes back as the continuation this start opened.
      if (event.window === null || continued.has(event.window)) continue;
      if (readString(event, "reason") === "host_restart") continue;
      await this.retire(event.window, event.time);
    }
    // The scheduled tasks come back from the journal, so a restart does not
    // lose a schedule that has not fired yet. The records are replayed in
    // order, so a cancellation the journal recorded after a schedule's own
    // record leaves nothing to restore.
    const schedules = await this.journal.list({ kinds: ["schedule"], limit: 200 });
    const restored = new Map<TaskRef, ScheduledTask>();
    for (const event of schedules.items) {
      if (event.body === null) continue;
      let parsed: (ScheduledTask & { cancelled?: unknown }) | null;
      try {
        parsed = JSON.parse(event.body) as ScheduledTask & { cancelled?: unknown };
      } catch {
        continue;
      }
      if (parsed === null || typeof parsed.ref !== "string") continue;
      if (parsed.cancelled === true) {
        restored.delete(parsed.ref as TaskRef);
        continue;
      }
      restored.set(parsed.ref as TaskRef, parsed);
    }
    await this.scheduler.restore?.([...restored.values()]);
    // A plugin's channel is an outside source, so the host takes its push source
    // and ingests what arrives (docs/dispatch.md#tasks). A channel without one
    // is a sink a deployment polls, or one nothing pushes to. A task source's
    // own push source is taken the same way.
    this.subscribePushSources();
  }

  /**
   * Take every registered channel's and task source's push source. What arrives
   * is outside traffic, so it goes through `ingest` exactly as a task source's
   * does: one task per conversation, and the events recorded before anything
   * routes (docs/dispatch.md#tasks).
   */
  private subscribePushSources(): void {
    for (const channel of this.registeredChannels) {
      if (channel.subscribe === undefined) continue;
      this.subscriptions.push(channel.subscribe(this.onOutside));
    }
    for (const source of this.registeredTaskSources) {
      if (source.subscribe === undefined) continue;
      this.subscriptions.push(source.subscribe(this.onOutside));
    }
  }

  /** What arrived from a push source: outside traffic, so it goes through `ingest`. */
  private readonly onOutside = async (events: readonly OutsideEvent[]): Promise<void> => {
    if (events.length === 0) return;
    await this.ingest(events);
  };

  /** Let every push source go. What they recorded stays in the journal. */
  private async unsubscribePushSources(): Promise<void> {
    for (const unsubscribe of this.subscriptions.splice(0)) await unsubscribe();
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
    this.launch(record, { firstInput, epoch, limits: this.limits() });
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
   * Outside events in, tasks out. A task source claims the events of the source
   * it names, and the host turns those into tasks with the source's own
   * `toTasks` - so the batching and the debouncing stay the source's business
   * and never the host's (docs/dispatch.md#tasks). What no source claims keeps
   * the host's own grouping: one task per target, which is the host's debouncing
   * for a source that hands events over as they arrive.
   */
  async ingest(events: readonly OutsideEvent[]): Promise<readonly DispatchResult[]> {
    const claimed = new Map<TaskSource, OutsideEvent[]>();
    const unclaimed: OutsideEvent[] = [];
    for (const event of events) {
      const source = this.registeredTaskSources.find((one) => one.id === event.source);
      if (source === undefined) {
        unclaimed.push(event);
        continue;
      }
      const group = claimed.get(source);
      if (group === undefined) claimed.set(source, [event]);
      else group.push(event);
    }
    const results: DispatchResult[] = [];
    for (const [source, group] of claimed) {
      for (const task of source.toTasks(group)) {
        // The source knows its own reason and its own batching; the host only
        // names the source that made the task when the task does not.
        results.push(await this.dispatch({ ...task, source: task.source ?? source.id }));
      }
    }
    for (const task of this.groupedTasks(unclaimed)) results.push(await this.dispatch(task));
    return results;
  }

  /**
   * The host's own grouping of what arrived together: one task per target, for
   * the events no task source claimed (docs/dispatch.md#tasks).
   */
  private groupedTasks(events: readonly OutsideEvent[]): readonly TaskInput[] {
    const groups = new Map<string, OutsideEvent[]>();
    for (const event of events) {
      const group = groups.get(event.target);
      if (group === undefined) groups.set(event.target, [event]);
      else group.push(event);
    }
    return [...groups].map(([target, group]) => ({
      kind: "batch" as const,
      reason: `a message arrived in ${target}`,
      targets: [target],
      time: group[group.length - 1]?.time ?? this.clock(),
      content: group.map((event) => outsideMessageBlockOf(event)),
      events: group,
      source: group[0]?.source,
    }));
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
    // Recorded, so a restart does not restore a schedule that was cancelled.
    await this.journal.append({
      kind: "schedule",
      body: JSON.stringify({ ref, cancelled: true }),
      refs: [ref],
    });
  }

  /**
   * Change one scheduled task: its name, its first time, its repeat rule, its
   * skip periods, its targets or what a firing dispatches. Null when the ref
   * names no schedule, which is what the `schedule` module reports
   * (docs/tools.md#modules).
   */
  async updateSchedule(ref: TaskRef, changes: ScheduledTaskUpdate): Promise<ScheduledTask | null> {
    const updated = await this.scheduler.update(ref, changes);
    if (updated === null) return null;
    // The whole schedule, so a restart restores what a firing dispatches now.
    await this.journal.append({ kind: "schedule", body: JSON.stringify(updated), refs: [ref] });
    return updated;
  }

  /** The scheduled tasks, soonest first. */
  async schedules(): Promise<readonly ScheduledTask[]> {
    return this.scheduler.list();
  }

  /**
   * The tasks the host dispatched, newest first, as the `tasks` module lists
   * them (docs/tools.md#modules). A task is the record the dispatcher wrote
   * before anything decided about it, so its ref names the batch and the
   * outside events it was made of from the start (docs/dispatch.md#tasks).
   */
  async tasks(limit?: number): Promise<readonly TaskSummary[]> {
    const wanted = Math.max(1, Math.min(MAX_PAGE_LIMIT, limit ?? DEFAULT_PAGE_LIMIT));
    const counted = await this.journal.list({ kinds: ["task"], limit: 1 });
    const page = await this.journal.list({
      kinds: ["task"],
      limit: wanted,
      offset: Math.max(0, counted.total - wanted),
    });
    const summaries: TaskSummary[] = [];
    for (const event of page.items) {
      const summary = summaryOf(event);
      if (summary !== undefined) summaries.push(summary);
    }
    return summaries.reverse();
  }

  /**
   * The tasks the refs name, each with the outside events it batched, as the
   * `tasks` module shows them. A ref that names no task is left out, the way a
   * journal read leaves out a ref that names no event.
   */
  async task(refs: readonly TaskRef[]): Promise<readonly TaskRecord[]> {
    const recorded = await this.journal.list({ kinds: ["task"], limit: MAX_TASK_LOOKUP });
    const found: TaskRecord[] = [];
    for (const ref of refs) {
      const event = recorded.items.find((one) => taskOf(one.body)?.ref === ref);
      if (event === undefined) continue;
      const summary = summaryOf(event);
      if (summary === undefined) continue;
      found.push({ ...summary, events: await this.batched(event) });
    }
    return found;
  }

  /** The outside events a task event says its batch was made of. */
  private async batched(event: Event): Promise<readonly Event[]> {
    const refs = event.links
      .filter((link) => link.kind === "origin")
      .map((link) => link.to as EventRef);
    return this.journal.getMany(refs);
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
        message: textOf(this.table, "refused.windows.notfound", { window }),
        nextAction: textOf(this.table, "next.windows.notfound"),
      });
    }
    if (record.state === "ended") {
      throw arborError({
        code: "refused",
        rule: "window.ended",
        message: textOf(this.table, "refused.windows.ended", { window }),
        nextAction: textOf(this.table, "next.windows.ended"),
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

  /**
   * Release the host: stop every window, stop draining effects, let the
   * channels' push sources and the services go.
   *
   * Stopping a window is all this does. No continuation is opened and no new
   * turn starts, so closing a host changes nothing the journal does not already
   * hold: each stopped window is recorded with `host_restart`, and the next
   * `start` continues it from there (docs/windows.md#restart).
   */
  async close(): Promise<void> {
    if (this.retryTimer !== undefined) {
      this.timers.clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
    // A closed host reclaims nothing: a chain's retention deadline is counted
    // from the end the journal recorded, and the next `start` picks it up from
    // there (docs/workspaces.md#lifecycle).
    for (const timer of this.retentionTimers.values()) this.timers.clearTimeout(timer);
    this.retentionTimers.clear();
    this.held.length = 0;
    this.closed = true;
    this.scheduler.close?.();
    await this.unsubscribePushSources();
    const stopping = this.live();
    for (const record of stopping) {
      if (record.session === undefined) continue;
      await record.session.end(undefined, "host_restart");
    }
    // Each window's end is recorded by its own run, so the host waits for it: a
    // `close` leaves every window it stopped in the journal, and the next
    // `start` reads them from there.
    for (const record of stopping) {
      if (record.running === undefined) continue;
      await record.running;
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
      hooks: this.hooks,
      // The state a judge is asked about is scrubbed first: it carries outside
      // text and tool output, and a credential can hide in either.
      scrub: (state) => (this.secrets.active ? this.secrets.applyJson(state) : state),
      // A hook refused the window or the act: the rule is recorded, so the
      // journal says why nothing was routed, and the task is answered as
      // unrouted rather than thrown back at the push source.
      refuse: async (task, error) => {
        await this.journal.append({
          kind: "dispatch",
          body: hostBody({
            task: task.ref,
            route: "refused",
            rule: error.rule,
            ...(error.message === undefined ? {} : { message: error.message }),
          }),
          targets: [...task.targets],
          refs: [task.ref],
        });
      },
      now: () => host.clock(),
      nextTask: () => host.refs.nextTask(),
      render: (blocks) => host.renderer.render(blocks),
      live: () => host.live(),
      boardLine: (window) => host.board.get(window),
      circulate: async (event) => host.coordinator.circulate(event),
      open: async (task, tier) => host.openWindow(task, tier),
      insert: async (record, task) => host.insert(record, task),
      logDecision: (record) => host.recordDecision(record),
      // A plugin's criteria for its own inputs reach the judge as part of the
      // question, the way the plugin surface describes
      // (docs/architecture.md#plugins).
      criteria: (decision) =>
        host
          .judgeCriteria()
          .filter((one) => one.decision === decision)
          .flatMap((one) => one.criteria),
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
        body: JSON.stringify(this.secrets.active ? scrubRecord(record, this.secrets) : record),
      })
      .catch(() => {});
  }

  /** One judge request, as the judge itself reports it. */
  private judgeRequest = (log: JevDecisionLog): void => {
    void this.journal
      .append({
        kind: "judge_request",
        body: JSON.stringify(this.secrets.active ? (this.secrets.applyJson(log) as JevDecisionLog) : log),
      })
      .catch(() => {});
  };

  // ---- the run loop -------------------------------------------------------

  /**
   * Start one window's run and keep it on the record, so `close` waits for the
   * end each window records before the host is released.
   */
  private launch(
    record: WindowRecord,
    input: { firstInput: string; epoch: PromptEpoch; limits: OpenWindowRequest["limits"]; continuation?: OpenWindowRequest["continuation"] },
  ): void {
    const running = this.run(record, input);
    record.running = running;
    void running.catch(() => {});
  }

  /** Open one window's session and watch it until the window ends. */
  private async run(
    record: WindowRecord,
    input: { firstInput: string; epoch: PromptEpoch; limits: OpenWindowRequest["limits"]; continuation?: OpenWindowRequest["continuation"] },
  ): Promise<void> {
    // A window still opening when the host closed never reaches a model: the
    // host was released, so the window is stopped where it stands and its stop
    // is recorded like any other (docs/windows.md#restart).
    if (this.closed) {
      await this.stop(record);
      return;
    }
    let session: WindowSession;
    // The prompt a window opens with goes through `beforeModelRequest`, so a
    // plugin sees what the model will read before it reaches the backend, and
    // may change the inputs the first turn is built from. With no hook
    // registered the window opens without an extra hop.
    const asked = this.hooks.empty ? null : await this.modelRequest(record, input);
    if (asked === null && !this.hooks.empty) {
      await this.fail(record, arborError({
        code: "refused",
        rule: "model.request.refused",
        message: textOf(this.table, "refused.model.request.refused"),
        nextAction: textOf(this.table, "next.model.request.refused"),
      }));
      return;
    }
    // What the hook answered with is used: a changed `inputs` is rendered into
    // the window's first input, so a plugin can add to it. The host's own
    // inputs are left as they were built, so nothing is re-rendered for a hook
    // that did not touch them.
    const firstInput =
      asked !== null && asked.inputs !== asked.built ? this.renderer.render(asked.inputs) : input.firstInput;
    try {
      session = await this.backend.open({
        window: record.window,
        task: record.task,
        prompt: asked?.prompt ?? {
          system: input.epoch.system,
          memory: input.epoch.memory,
          envRevision: input.epoch.envRevision,
        },
        tools: this.catalog.tools(),
        modules: this.catalog.modules(),
        model: await this.modelFor(record.tier),
        firstInput,
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
   * hook refused the request, so the window never reaches a model. `built` is
   * the inputs the host itself built, so the caller can tell a hook's change
   * from the host's own.
   */
  private async modelRequest(
    record: WindowRecord,
    input: { firstInput: string; epoch: PromptEpoch },
  ): Promise<{ prompt: RenderedPrompt; inputs: readonly Block[]; built: readonly Block[] } | null> {
    const built: readonly Block[] = [dataBlock(input.firstInput)];
    try {
      const asked = await this.hooks.before("beforeModelRequest", {
        window: record.window,
        prompt: {
          system: input.epoch.system,
          memory: input.epoch.memory,
          envRevision: input.epoch.envRevision,
        },
        inputs: built,
      });
      return { prompt: asked.prompt, inputs: asked.inputs, built };
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
          case "text_delta":
          case "tool_call_delta":
            // Live output is handed on without being waited for: a surface that
            // shows it must never hold up the window's own events.
            this.streamOut(record.window, event);
            break;
          case "usage":
            record.usage = event.usage;
            this.board.update(record.window, { usage: event.usage, state: "running" });
            await this.remind(record);
            break;
          case "steered":
            await this.recordDelivery(record.window, event.delivery);
            break;
          case "appended":
            // What the model wrote in its turn: recorded, so the window's
            // transcript holds it and a continuation can read what its
            // predecessor said (docs/journal.md).
            await this.recordText(record.window, event.event);
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
   * One delta of a window's live output, out to the code that watches it. The
   * deltas of one window stay in order, and none of them is waited for: the
   * stream is best-effort and ephemeral, so a hook that throws or is slow loses
   * its own deltas and never the window (docs/windows.md#streaming).
   */
  private streamOut(window: WindowRef, event: StreamEvent): void {
    if (this.hooks.empty) return;
    const handed = (this.streaming.get(window) ?? Promise.resolve())
      .then(() => this.hooks.after("windowStream", { window, event }))
      .then(
        () => undefined,
        () => undefined,
      )
      .catch(() => {});
    this.streaming.set(window, handed);
    void handed.then(() => {
      if (this.streaming.get(window) === handed) this.streaming.delete(window);
    });
  }

  /**
   * The reminder series (docs/windows.md#usage-reminders): seven tiers, each
   * with its own instruction, from 15 % of the window to the final one at
   * `window - 2 x reserve`. Only the highest crossed tier is sent; the lower
   * ones it jumped over are recorded as sent with it, so a window that crosses
   * several thresholds in one step still hears every tier, in order.
   */
  private async remind(record: WindowRecord): Promise<void> {
    const tier = nextReminderTier(record.usage, record.remindersSent);
    if (tier === null) return;
    record.remindersSent = REMINDER_TIERS.indexOf(tier) + 1;
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
    await this.release(record);
    // A window a `close` stopped goes on at the next `start`, not here: closing
    // a host starts no new turn (docs/windows.md#restart).
    const continues =
      wanted !== undefined ||
      reason === "hard_limit" ||
      // A window whose model call failed goes on once: its own continuation
      // carries the interruption, and one is enough, so a model service that
      // stays down does not chain windows for ever.
      (reason === "failed" && record.interrupted !== true);
    // The chain's last window ended: its directory waits out the retention
    // period and is then reclaimed (docs/workspaces.md#lifecycle).
    if (!continues) {
      await this.retire(record.window, this.clock());
      return;
    }
    await this.continueWindow(record.window, {
      ...(wanted === undefined ? {} : { handoff: wanted }),
      midTaskReset: reason === "hard_limit",
      // A window whose model call failed has steps that stand and nothing that
      // says where it stopped, so the continuation is told it was interrupted.
      interrupted: reason === "failed",
      targets,
      ...(record.tier === undefined ? {} : { tier: record.tier }),
    });
  }

  /**
   * Open the continuation window. It keeps its watermarks, and its first input
   * carries the previous window's ref and handoff - or, after the hard limit,
   * one host line saying the window was reset mid-task.
   */
  private async continueWindow(
    previous: WindowRef,
    options: {
      handoff?: Handoff;
      midTaskReset?: boolean;
      interrupted?: boolean;
      targets?: readonly string[];
      tier?: string;
    },
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
    // The predecessor chain's open checkouts, so a continuation sees them by name
    // and can continue working in them or apply them (docs/workspaces.md).
    const checkouts = await this.options.workspace?.checkouts?.(previous) ?? [];
    const checkoutBlock =
      checkouts.length === 0
        ? []
        : [
            dataBlock(
              textOf(this.table, "continuation.checkouts", {
                checkouts: checkouts.map((one) => `${one.name}${one.dirty ? textOf(this.table, "continuation.checkout.dirty") : ""}`).join("、"),
              }),
            ),
          ];
    // The persistent directories the chain created, so a continuation finds them
    // by name and keeps working in them (docs/workspaces.md#persistent-directories).
    // The wording is the implementation's own; an implementation that keeps none
    // has no line to give and the block is simply not there.
    const keeps = await this.options.workspace?.keeps?.(previous) ?? [];
    const keepLine =
      keeps.length === 0
        ? ""
        : textOf(this.table, "continuation.keeps", {
            keeps: keeps.map((one) => `${one.name} ${one.path}`).join("、"),
          });
    const keepBlock = keepLine === "" ? [] : [dataBlock(keepLine)];
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
          ...(options.interrupted === true ? { interrupted: true } : {}),
          openTasks,
          effects,
        },
        ...(changes.length === 0 && checkoutBlock.length === 0 && keepBlock.length === 0
          ? {}
          : { changes: [...changes, ...checkoutBlock, ...keepBlock] }),
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
    // The continuation of a failed window is itself the interrupted one, so the
    // chain stops there rather than following a model service that stays down.
    if (options.interrupted === true) record.interrupted = true;
    this.launch(record, {
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

  /**
   * Stop one window without a continuation: the end a `close` records. It is
   * what the next `start` reads to know the window was stopped rather than
   * finished (docs/windows.md#restart).
   */
  private async stop(record: WindowRecord): Promise<void> {
    this.disarm(record);
    record.state = "ended";
    await this.journal.append({
      kind: "window_end",
      window: record.window,
      body: hostBody({ reason: "host_restart", used: record.usage.used }),
      targets: this.board.get(record.window)?.targets ?? [],
    });
    this.board.close(record.window);
    await this.release(record);
  }

  /**
   * Drop one ended window's own state: its record, what it read of the
   * environment and the mount it held. The board line is closed by the caller,
   * which knows the targets the end is recorded with.
   */
  private async release(record: WindowRecord): Promise<void> {
    this.windows.delete(record.window);
    this.reads.delete(record.window);
    if (record.mount !== undefined) await record.mount.release().catch(() => {});
  }

  /**
   * A chain's last window ended: its directory stays where it is for the
   * retention period, and the host reclaims it once that has passed. A restart
   * keeps the deadline, because the end it is counted from is in the journal
   * (docs/workspaces.md#lifecycle). This is a setting, not a task for a model:
   * with no `workspaces.retentionMs` nothing is reclaimed.
   */
  private async retire(window: WindowRef, endedAt: number): Promise<void> {
    const workspace = this.options.workspace;
    const retentionMs = this.retentionMs();
    if (workspace === undefined || retentionMs === undefined) return;
    const root = await this.chainRoot(window);
    if (this.retentionTimers.has(root)) return;
    const ref = await workspace.refOf(root);
    // A chain no window ever touched files in has no directory to reclaim.
    if (ref === undefined) return;
    this.retentionTimers.set(
      root,
      this.timers.setTimeout(() => {
        this.retentionTimers.delete(root);
        void workspace.reclaim(ref).catch(() => {});
      }, Math.max(0, endedAt + retentionMs - this.clock())),
    );
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
    await this.retire(record.window, this.clock());
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
   * What the model wrote in its own turn, as one event on the window's record
   * (docs/journal.md). It is not sent anywhere - only `send` reaches the
   * outside - so the record is the one place it stands, and a continuation
   * reads it there. The scrub applies like it does to every other string the
   * host writes.
   */
  private async recordText(window: WindowRef, text: string): Promise<void> {
    if (text === "") return;
    await this.journal.append({
      kind: "assistant",
      window,
      body: this.secrets.active ? this.secrets.apply(text) : text,
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

      channels: () => host.channels(),

      windows: async () => host.liveWindows(),
      windowTranscript: async (window) => host.transcript(window),
      windowMessage: async (from, to, text, replyTo) => host.windowMessage(from, to, text, replyTo),
      broadcast: async (from, text) => host.broadcast(from, text),
      inbox: async (window) => host.inboxOf(window),

      tasks: async (limit) => host.tasks(limit),
      task: async (refs) => host.task(refs),
      schedules: async () => host.schedules(),
      schedule: async (input) => host.schedule(input),
      updateSchedule: async (ref, changes) => host.updateSchedule(ref, changes),
      cancelSchedule: async (ref) => host.cancelSchedule(ref),

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
            message: textOf(this.table, "refused.env.absent"),
            nextAction: textOf(this.table, "next.env.absent"),
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

  /**
   * The window's own directory, created on first use. A continuation works in
   * its predecessor's directory in place, under the same ref, so the mount is
   * the chain's (docs/workspaces.md#what-the-framework-guarantees).
   */
  private async mountFor(window: WindowRef): Promise<WorkspaceMount | undefined> {
    const workspace = this.options.workspace;
    if (workspace === undefined) return undefined;
    const record = this.windows.get(window);
    if (record?.mount !== undefined) return record.mount;
    const ref = await workspace.create(await this.chainRoot(window));
    const mount = await workspace.mount(ref);
    if (record !== undefined) record.mount = mount;
    return mount;
  }

  /**
   * The window whose directory a window works in: its own, or the one its
   * chain started from. Every continuation records the window it continues, so
   * the chain is in the journal and a restart recovers which directory a
   * continuation uses (docs/windows.md#restart).
   */
  private async chainRoot(window: WindowRef): Promise<WindowRef> {
    let current = window;
    // A window's number only grows, so the walk cannot cycle; the bound only
    // stops a corrupt journal from walking for ever.
    for (let depth = 0; depth < 1000; depth += 1) {
      const page = await this.journal.list({ window: current, kinds: ["window_start"], limit: 1 });
      const previous = continuedWindow(page.items[0]?.body);
      if (previous === undefined) return current;
      current = previous;
    }
    return current;
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

  /** True when the window is behind on a target it touched, or holds a checkout with changes not yet applied back. */
  private async hasOpenWork(window: WindowRef): Promise<boolean> {
    const gaps = await this.journal.targetsBehind(window);
    if (gaps.length > 0) return true;
    const checkouts = await this.options.workspace?.checkouts?.(window);
    return checkouts?.some((checkout) => checkout.dirty) ?? false;
  }

  /**
   * One note write. The anchor is the host's: the window that wrote it, the
   * event the write is recorded at, and the refs the window cited - which are
   * the write's evidence as well, so credit for the active set flows through
   * them (docs/memory.md#anchors). The model never fills one in.
   */
  private async writeNote(window: WindowRef, input: NoteWriteInput): Promise<Note> {
    const notes = this.options.notes;
    if (notes === undefined) {
      throw arborError({
        code: "unavailable",
        rule: "notes.absent",
        message: textOf(this.table, "refused.notes.absent"),
        nextAction: textOf(this.table, "next.notes.absent"),
      });
    }
    const anchor: Anchor = { window, event: await this.lastEvent(window) };
    // A hook may change what the write carries; a refusal answers with the rule.
    const allowed = await this.hooks.before("beforeNoteWrite", { window, input });
    const cited = [...(allowed.input.refs ?? []), ...(await this.citedRefs(window))];
    const note = await notes.write({
      ...allowed.input,
      refs: cited,
      anchor: cited.length === 0 ? anchor : { ...anchor, evidence: cited },
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
    // A secret value never leaves the host: the content is checked before the
    // effect is recorded, so nothing is queued and nothing is sent.
    const secret = this.secrets.secretIn(request.content);
    if (secret !== undefined) {
      throw arborError({
        code: "refused",
        rule: "send.secret",
        message: textOf(this.table, "refused.send.secret", { name: secret.name }),
        nextAction: textOf(this.table, "next.send.secret", { name: secret.name }),
      });
    }
    const input: EffectInput = {
      kind: "send",
      target,
      content: [{ kind: "data", fields: { content: request.content } }],
      window,
      ...(request.replyTo === undefined ? {} : { replyTo: request.replyTo }),
      ...(request.cites === undefined ? {} : { cites: request.cites }),
    };
    // A send writes on its target, so the window has touched that conversation
    // and hears what comes back on it - above all its own effect's result
    // (docs/coordination.md#staying-current). The touch stands before the
    // effect is queued, because the queue carries the effect out at once.
    this.board.touch(window, target);
    const outcome = await this.effects.submit(input);
    await this.see(window, outcome.event);
    // A send that cites notes is a use of them: the store cannot see it, so
    // the host records it (docs/memory.md#the-active-set).
    await this.citeNotes(window, outcome.event, request.cites ?? []);
    // A send is a new event on its target, so the windows in that conversation
    // stay current (docs/coordination.md#staying-current).
    const sent = await this.journal.get(outcome.event);
    if (sent !== null) await this.coordinator.circulate(sent);
    return outcome;
  }

  /**
   * The notes a send cited, recorded as used. A note is `n012`, with or without
   * a revision; anything else is a ref of another kind and is left alone.
   */
  private async citeNotes(window: WindowRef, event: EventRef, cites: readonly Ref[]): Promise<void> {
    const notes = this.options.notes;
    if (notes === undefined) return;
    for (const cite of cites) {
      if (!/^n\d+(@\d+)?$/.test(cite)) continue;
      await notes.recordUse({ ref: cite as NoteRef, kind: "cite", window, event });
    }
  }

  private async boardPage(): Promise<Page<BoardLine>> {
    const lines = this.boardLines();
    return { items: [...lines], total: lines.length, limit: lines.length, nextCall: "board.list()" };
  }

  private async setBoardLine(window: WindowRef, doing: string): Promise<void> {
    this.board.setDoing(window, doing);
    await this.journal.append({ kind: "board_line", window, body: hostBody({ doing }) });
  }

  private async expect(window: WindowRef, item?: string, description?: string): Promise<import("@4fu/arbor-interfaces").Expectation> {
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

  /** Record one tool call before it runs, at its own event. */
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
   * then record its result.
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
    let ran = call;
    if (allowed instanceof Error) {
      result = this.refusalOf(call, allowed);
    } else {
      ran = allowed.call;
      result = await this.catalog.call(ran, context).catch((error: unknown) => this.refusalOf(call, error));
    }
    if (!this.hooks.empty) {
      const seen = await this.hooks.after("afterToolCall", { window, call, result });
      // What an after hook answered with is used: it may rewrite the result,
      // and what the window records and what the model read both follow it.
      if (seen.result !== undefined) result = seen.result;
    }
    const scrubbed = this.scrubResult(result);
    await this.journal.append({
      kind: "tool_result",
      window,
      body: scrubbed.content === "" ? refusalText(scrubbed) : scrubbed.content,
      targets: [],
      ...(at === undefined ? {} : { refs: [at] }),
    });
    return scrubbed;
  };

  /**
   * One tool result with every secret value replaced, before it is recorded and
   * before it goes back to the backend: a command that echoes a credential, a
   * configuration file a window read and an MCP server that answers with one
   * all come through here (docs/architecture.md#data-placement).
   */
  private scrubResult(result: ToolResult): ToolResult {
    if (!this.secrets.active) return result;
    const error = result.error;
    return {
      ...result,
      content: this.secrets.apply(result.content),
      ...(error === undefined
        ? {}
        : {
            error: {
              ...error,
              message: this.secrets.apply(error.message),
              ...(error.nextAction === undefined ? {} : { nextAction: this.secrets.apply(error.nextAction) }),
            },
          }),
    };
  }

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

  /**
   * How long a chain's directory is kept after its last window ended, before
   * the host reclaims it. `undefined` when the setting names no period, and
   * then nothing is ever reclaimed (docs/workspaces.md#lifecycle).
   */
  private retentionMs(): number | undefined {
    const retentionMs = this.current()?.workspaces?.retentionMs;
    return typeof retentionMs === "number" && retentionMs > 0 ? retentionMs : undefined;
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

/** The window a `window_start` event continues, when it continues one. */
function continuedWindow(body: string | null | undefined): WindowRef | undefined {
  if (body === undefined || body === null) return undefined;
  try {
    const parsed = JSON.parse(body) as { continuation?: unknown };
    const previous = parsed.continuation;
    return typeof previous === "string" && /^c\d+$/.test(previous) ? (previous as WindowRef) : undefined;
  } catch {
    return undefined;
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

/**
 * What one task event records: the task it names, what kind of task it is, why
 * it is one and the source that made it (docs/dispatch.md#tasks). The dispatcher
 * writes this body before anything decides about the task, so the record is
 * there whatever the routing decided.
 */
function taskOf(body: string | null): { ref: TaskRef; kind: TaskKind; reason: string; source?: string } | null {
  if (body === null) return null;
  try {
    const parsed = JSON.parse(body) as { task?: unknown; kind?: unknown; reason?: unknown; source?: unknown };
    if (typeof parsed.task !== "string" || !/^t\d+$/.test(parsed.task)) return null;
    if (typeof parsed.reason !== "string") return null;
    return {
      ref: parsed.task as TaskRef,
      kind: typeof parsed.kind === "string" ? (parsed.kind as TaskKind) : "batch",
      reason: parsed.reason,
      ...(typeof parsed.source === "string" ? { source: parsed.source } : {}),
    };
  } catch {
    return null;
  }
}

/** One task event as the record the `tasks` module reads. */
function summaryOf(event: Event): TaskSummary | undefined {
  const task = taskOf(event.body);
  if (task === null) return undefined;
  return {
    ref: task.ref,
    kind: task.kind,
    reason: task.reason,
    targets: [...event.targets],
    time: event.time,
    ...(task.source === undefined ? {} : { source: task.source }),
  };
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
  secrets: SecretScrub,
  onDecision: (log: JevDecisionLog) => void,
): Judge {
  return new Jev({
    ...(secrets.active ? { scrub: (text: string) => secrets.apply(text) } : {}),
    ...(settings?.judge?.maxCandidates === undefined ? {} : { maxItems: settings.judge.maxCandidates }),
    onDecision,
  });
}

/** The same scrub over one decision record, on the way to the journal. */
function scrubRecord(record: DecisionRecord, secrets: SecretScrub): DecisionRecord {
  return {
    ...record,
    state: secrets.applyJson(record.state),
    ...(record.answer === undefined ? {} : { answer: secrets.applyJson(record.answer) as DecisionRecord["answer"] }),
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
