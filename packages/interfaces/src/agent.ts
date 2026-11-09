/**
 * The `AgentBackend` interface: run one window - send the prompt and the tools
 * to a model, stream tool calls and what the model is writing, accept inputs
 * inserted once a turn's tool calls finish, report token usage, list the models
 * it can run and log in to their providers (docs/architecture.md#interfaces).
 *
 * arbor uses pi-agent-core's `Agent` with its own system prompt: pi's default
 * coding prompt, context files and skills never reach the model
 * (docs/prompting.md#no-built-in-pi-prompt).
 */

import type { Block } from "./blocks.ts";
import type { ExternalTool } from "./tools.ts";
import type { TaskRef, Ref, WindowRef } from "./refs.ts";
import type { Handoff, TokenUsage, WindowState } from "./windows.ts";
import type { RateLimitState } from "./scheduler.ts";

/**
 * One JSON Schema object, carried as it was declared.
 *
 * A tool declared from outside the core - a plugin's own, or a harness's
 * through a backend - hands its parameters over in the JSON Schema that
 * harness already speaks, and that schema is what the model reads, verbatim
 * (docs/tools.md#external-tools). Deriving one from a summary would drop what
 * the schema says and what the summary cannot: `enum`, `items`, `oneOf`,
 * `additionalProperties`, a nested object's own properties.
 */
export type JSONSchema = Record<string, unknown>;

/** One model the backend can run. Only models that take images are offered. */
export interface ModelInfo {
  id: string;
  provider: string;
  /** The tier settings map this model to, when the backend knows one. */
  tier?: string;
  name?: string;
  images: boolean;
}

export type LoginState = "logged-in" | "logged-out" | "failed";

export interface LoginRequest {
  provider: string;
  /** The name of a secret; a configuration never holds a secret's value. */
  secret?: string;
}

export interface LoginResult {
  provider: string;
  state: LoginState;
  models: ModelInfo[];
  error?: string;
}

/** The prompt a window is opened with: the frozen prefix of its epoch. */
export interface RenderedPrompt {
  /** `<identity>`, `<agent>`, `<tools>`, `<modules>`, `<env>`, plugin sections. */
  system: string;
  /** The active notes, by summary. */
  memory: string;
  /** The environment revision the prompt was rendered against. */
  envRevision: string;
}

/** What a window is opened for. */
export interface OpenWindowRequest {
  window: WindowRef;
  task: TaskRef;
  prompt: RenderedPrompt;
  tools: readonly DirectToolSpec[];
  modules: readonly ModuleSpec[];
  /** The model the tier maps to, resolved from the backend's catalog. */
  model: string;
  /**
   * The first input, already rendered by the host's one renderer: the task,
   * the board lines related to it and, for a continuation, the previous
   * window's ref and handoff (docs/prompting.md#layers).
   */
  firstInput?: string;
  /** The workspace mounted for this window, when it has one. */
  workspace?: string;
  limits: WindowLimits;
  continuation?: ContinuationInfo;
}

export interface WindowLimits {
  /** The context window's token budget. */
  contextTokens: number;
  /** Tokens held back from the model, for the final reminder. */
  reserveTokens: number;
  /** How long an ended run stays open for a related input, in seconds. */
  idleSeconds: number;
}

/** A continuation's first input carries these. */
export interface ContinuationInfo {
  previous: WindowRef;
  handoff?: Handoff;
  /** Set after the hard limit: the window was reset mid-task. */
  midTaskReset?: boolean;
}

/**
 * What a delivery is to the turn it enters
 * (docs/dispatch.md#insertion-timing).
 *
 * - **context** - what the window's own prompt or its surroundings now hold: a
 *   prompt delta, a tools delta, an environment delta, a broadcast. The model
 *   reads it with its next request and it never starts a turn: steering one
 *   into a quiet window leaves the window quiet, and the block waits for the
 *   next turn that is already coming.
 * - **input** - something for the window to act on: an inserted task, a
 *   conversation update, a notice, a window message, a reminder. A related
 *   input is what continues an idle window, so the host steers it in and the
 *   backend starts a turn when the window is idle.
 */
export type DeliveryRole = "context" | "input";

/**
 * What the host inserts into a running window at a tool-call boundary.
 *
 * ## What each kind expects from a backend
 *
 * Every delivery is one input block, and the host says when the model must
 * read it by the call it hands the delivery to: `WindowSession.steer` for one
 * that goes in at the next step boundary, `WindowSession.followUp` for one that
 * becomes the input of the next turn. The rule is the same for every kind - the
 * insertion rules decide, not the kind
 * (docs/dispatch.md#insertion-timing) - with two things a backend can rely on:
 *
 * - **What a window can call is never held back.** A conversation update, an
 *   environment delta, a prompt delta and a tools delta always come through
 *   `steer`, in the protection period and after it, because they change what
 *   the window would otherwise do next.
 * - **A reminder is the kind the host times itself.** While the window runs it
 *   is steered in at the next boundary; once the run has ended it is queued as
 *   a follow-up, so it is the input of the window's next turn.
 *
 * What a delivery is to the turn it enters rides on it as `role`, so a backend
 * never has to work it out from the kind: a **context** delivery is read by the
 * next turn and must never start one, and an **input** delivery is what
 * continues a quiet window. Steering a delta into a quiet window that then runs
 * a turn of its own is the bug this field exists to prevent: the window would
 * act on a change to its own prompt before anything asked it to.
 *
 * A backend that is not pi maps the two calls onto whatever its own loop
 * offers - DeepSeek Harness's `agent.inject` for a step boundary and its
 * steering for the next turn - and the rest of the contract is the same: the
 * block is one user-role input, in order, exactly once, and the turn the
 * window is in is never ended by it.
 */
export interface Delivery {
  kind:
    | "inserted_task"
    | "conversation_update"
    | "notice"
    | "broadcast"
    | "window_message"
    | "environment_delta"
    /**
     * A plugin's prompt section changed since this window's prefix was built:
     * the lines that changed, and nothing that did not
     * (docs/prompting.md#plugin-sections-that-change).
     */
    | "prompt_delta"
    /**
     * The direct tools declared from outside the core changed while this window
     * runs: a harness registered one, or a plugin's set moved. The delta names
     * what was added and what was removed, and the window may call the new ones
     * from its next tool call on (docs/tools.md#external-tools-that-change).
     */
    | "tools_delta"
    /** A host usage reminder, appended to an input (docs/windows.md#usage-reminders). */
    | "reminder";
  /**
   * What this delivery is to the turn it enters: context the window reads with
   * its next request and that never starts a turn, or input the window acts on
   * and that continues it when it is idle. The host marks every delivery it
   * makes; a backend relies on the mark rather than on the kind.
   */
  role: DeliveryRole;
  /** The window it comes from, for a notice, a broadcast or a window message. */
  from?: WindowRef;
  refs: readonly Ref[];
  time: number;
  content: readonly Block[];
}

/** One running window, owned by the backend. */
export interface WindowSession {
  readonly window: WindowRef;
  readonly state: WindowState;

  /**
   * Insert at the next tool-call boundary, through the backend's steering.
   *
   * A **step boundary** is the moment every tool call of the current turn has
   * finished and the next model request has not gone out yet. The delivery
   * becomes one user-role input the model reads with that request. It is never
   * a system message in the middle of a window - some providers fold those into
   * the leading system prompt and that breaks the cached prefix
   * (docs/prompting.md#no-built-in-pi-prompt) - and it never rewrites the
   * window's prefix.
   *
   * What a backend must do:
   *
   * - deliver the block in the order the host handed its deliveries over, and
   *   deliver each one exactly once;
   * - keep the turn going: the model is not stopped, not asked to confirm, and
   *   not told the input is special - it is one more input;
   * - start a turn when the window is idle and the delivery is **input**,
   *   because that is what a related input wants
   *   (docs/dispatch.md#insertion-timing); the host only steers into a window
   *   it has not ended and has not paused, so a delivery never arrives for one
   *   of those;
   * - leave a quiet window quiet for a **context** delivery: it is read by the
   *   next turn and must never start one, so the block waits for a turn that is
   *   already coming;
   * - resolve once the delivery is queued, not once the model has read it: the
   *   host never waits for the model, and a slow model is not a slow steer.
   *
   * A window that has ended refuses in the core's error shape, rule
   * `window.ended`; the host never steers into one.
   */
  steer(delivery: Delivery): Promise<void>;

  /**
   * Queue for after the run ends: the delivery becomes the input of the
   * window's next turn.
   *
   * What a backend must do:
   *
   * - hold it out of the turn the window is in - the model must not read it
   *   mid-turn, which is what separates this call from `steer`;
   * - deliver it as the input of the next turn, in order and exactly once, when
   *   the window runs again;
   * - keep it queued while the window sits idle, and drop it when the window
   *   ends, because an ended window is never reopened
   *   (docs/windows.md#lifecycle).
   *
   * The host uses this only for an **input** delivery that belongs after the
   * run: the reminder of a window whose run has already ended, and whatever a
   * `Scheduler` places there (docs/dispatch.md#insertion-timing). A context
   * delivery never goes here: it is steered, and read by the next turn.
   */
  followUp(delivery: Delivery): Promise<void>;

  /**
   * The direct tools this window may call changed: the host registered what a
   * backend or a plugin declared since this window opened
   * (docs/tools.md#external-tools-that-change).
   *
   * A backend that can change a running window's declared tools replaces them
   * here, so a tool that appeared is callable in this window and one that was
   * removed is not. A backend that cannot leaves the declaration it opened
   * with: the window still learns the change from the `tools_delta` it is
   * steered, and a call still runs through the host's catalog, which holds the
   * current set. Optional; the host asks only of a session that has it.
   */
  refreshTools?(tools: readonly DirectToolSpec[]): Promise<void> | void;

  /** End the run. With a handoff the host opens a continuation. */
  end(handoff?: Handoff, reason?: WindowEndReason): Promise<void>;

  /** Pause insertion without ending the window. */
  pause(): Promise<void>;
  resume(): Promise<void>;

  usage(): TokenUsage;

  /** Tool calls, results and what the model is writing, as they happen. */
  events(): AsyncIterable<WindowEvent>;

  /** Resolves when the window ends, with why. */
  outcome(): Promise<WindowOutcome>;
}

/**
 * What a window is writing while it runs, one delta at a time
 * (docs/windows.md#streaming).
 *
 * Streams are best-effort and ephemeral: they are not journaled, and the
 * journal's durable events stay the only record. A backend that cannot report
 * deltas never emits them, and a consumer that misses one keeps going - the
 * next delta carries what stands so far.
 */
export type StreamEvent =
  /** Assistant text, as the model writes it. */
  | { kind: "text_delta"; delta: string }
  /**
   * One tool call's arguments, as the model writes them. `call.args` is what
   * has been decoded so far and is best-effort: a call still being written is
   * not valid JSON yet, so a string argument holds the characters written so
   * far - which is what makes `send`'s content visible while the model is
   * still writing it (docs/tools.md#direct-tools). The durable `tool_call`
   * event carries the complete arguments, once.
   */
  | { kind: "tool_call_delta"; call: ToolCall };

/** What a backend streams while a window runs. */
export type WindowEvent =
  | StreamEvent
  | { kind: "tool_call"; call: ToolCall }
  | { kind: "tool_result"; call: ToolCall; result: ToolResult }
  | { kind: "appended"; event: string }
  | { kind: "steered"; delivery: Delivery }
  | { kind: "usage"; usage: TokenUsage }
  /** The run ended. The window stays open for a related input (docs/windows.md#lifecycle). */
  | { kind: "run_ended"; outcome: WindowOutcome }
  | { kind: "ended"; outcome: WindowOutcome };

export type WindowEndReason =
  | "model_ended"
  | "idle_timeout"
  | "hard_limit"
  | "host_restart"
  | "paused"
  | "failed";

export interface WindowOutcome {
  window: WindowRef;
  reason: WindowEndReason;
  handoff?: Handoff;
  usage: TokenUsage;
  error?: string;
}

export interface AgentBackend {
  readonly name: string;

  /** The catalog the backend can run. Only models that take images are offered. */
  models(): Promise<ModelInfo[]>;

  login(request: LoginRequest): Promise<LoginResult>;

  /**
   * The backend's rate limits, when it reports any. There is no cap on windows;
   * how many run at once is bounded by the backend, so new windows wait in a
   * queue while it is limited (docs/dispatch.md#backpressure). A backend that
   * reports nothing is never limited.
   */
  rateLimits?(): Promise<RateLimitState> | RateLimitState;

  /**
   * Direct tools the backend injects from outside arbor: the tools an outside
   * harness registered, which a host embedded in that harness hands in here
   * (docs/tools.md#external-tools). They are declared to the model and called
   * in the turn like any other direct tool.
   *
   * The set is refreshable: the host reads it again before every window opens
   * and at every step boundary, so a tool the harness registers - or drops -
   * while the host runs reaches the model without a restart
   * (docs/tools.md#external-tools-that-change). A backend that wants the change
   * to land the moment it happens rather than at the next boundary calls
   * `Arbor.refreshExternalTools` from its own signal.
   */
  externalTools?(): readonly ExternalTool[] | Promise<readonly ExternalTool[]>;

  /** Open one window and start its first turn. */
  open(request: OpenWindowRequest): Promise<WindowSession>;
}

/** Declared to the model and called in the turn (docs/tools.md#direct-tools). */
export interface DirectToolSpec {
  name: string;
  /** What it does and when to use it; side effects. 1 to 4 sentences. */
  description: string;
  /** The parameters in arbor's own declaration shape. */
  parameters: Record<string, ParameterSpec>;
  /**
   * The parameters as the JSON Schema an outside harness declared them, carried
   * verbatim: `enum`, `items`, `oneOf`, `additionalProperties`, a nested
   * object's own properties, all of it. What the model reads when the tool has
   * one, and what the `<tools>` line and `tool_search` show
   * (docs/tools.md#external-tools). Arbor's own tools declare none: their
   * `parameters` are the declaration.
   */
  schema?: JSONSchema;
  /**
   * Who declares it, when it is not the core's own: a plugin's name, or a
   * backend's. The tools list says where such a tool comes from, so the model
   * knows whose it is (docs/tools.md#external-tools).
   */
  source?: string;
}

/** Called from a script in `code_exec` (docs/tools.md#modules). */
export interface ModuleSpec {
  name: string;
  /** What the module can do, never a function name. */
  description: string;
  functions: readonly FunctionSpec[];
}

export interface FunctionSpec {
  /** `module.function`. */
  name: string;
  signature: string;
  description: string;
}

export interface ParameterSpec {
  type: "string" | "number" | "boolean" | "ref" | "refs" | "blocks" | "object" | "array";
  description: string;
  required?: boolean;
  default?: unknown;
}

/** One direct tool or module call, as the backend reports it. */
export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
  callId: string;
}

export interface ToolResult {
  callId: string;
  ok: boolean;
  /**
   * Stable fields, bounded, in the core's error shape when it failed.
   *
   * A refusal carries its own wording here as well as in `error`: the rule, the
   * message and the next action, in the one form the journal records a refusal
   * with. So an embedding that writes its own log passes the result through as
   * it stands instead of reassembling the three parts, and what the record
   * holds is what the caller was handed.
   */
  content: string;
  /**
   * The tool that was called, as the prompt names it. A refusal carries it so
   * the error line starts with the tool name; the catalog fills it on the way
   * out, so a group that leaves it out still names the call.
   */
  tool?: string;
  error?: { rule: string; message: string; nextAction?: string; refs?: readonly Ref[] };
}
