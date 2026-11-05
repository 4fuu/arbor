/**
 * The `AgentBackend` interface: run one window - send the prompt and the tools
 * to a model, stream tool calls, accept inputs inserted once a turn's tool
 * calls finish, report token usage, list the models it can run and log in to
 * their providers (docs/architecture.md#interfaces).
 *
 * arbor uses pi-agent-core's `Agent` with its own system prompt: pi's default
 * coding prompt, context files and skills never reach the model
 * (docs/prompting.md#no-built-in-pi-prompt).
 */

import type { Block } from "./blocks.ts";
import type { TaskRef, Ref, WindowRef } from "./refs.ts";
import type { Handoff, TokenUsage, WindowState } from "./windows.ts";

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

/** What the host inserts into a running window at a tool-call boundary. */
export interface Delivery {
  kind:
    | "inserted_task"
    | "conversation_update"
    | "notice"
    | "broadcast"
    | "window_message"
    | "environment_delta"
    /** A host usage reminder, appended to an input (docs/windows.md#usage-reminders). */
    | "reminder";
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

  /** Insert at the next tool-call boundary, through the backend's steering. */
  steer(delivery: Delivery): Promise<void>;

  /** Queue for after the run ends. */
  followUp(delivery: Delivery): Promise<void>;

  /** End the run. With a handoff the host opens a continuation. */
  end(handoff?: Handoff, reason?: WindowEndReason): Promise<void>;

  /** Pause insertion without ending the window. */
  pause(): Promise<void>;
  resume(): Promise<void>;

  usage(): TokenUsage;

  /** Tool calls, results and appends as they happen. */
  events(): AsyncIterable<WindowEvent>;

  /** Resolves when the window ends, with why. */
  outcome(): Promise<WindowOutcome>;
}

/** What a backend streams while a window runs. */
export type WindowEvent =
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

  /** Open one window and start its first turn. */
  open(request: OpenWindowRequest): Promise<WindowSession>;
}

/** Declared to the model and called in the turn (docs/tools.md#direct-tools). */
export interface DirectToolSpec {
  name: string;
  /** What it does and when to use it; side effects. 1 to 4 sentences. */
  description: string;
  parameters: Record<string, ParameterSpec>;
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
  /** Stable fields, bounded, in the core's error shape when it failed. */
  content: string;
  error?: { rule: string; message: string; nextAction?: string; refs?: readonly Ref[] };
}
