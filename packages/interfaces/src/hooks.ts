/**
 * Hooks: how a deployment or a plugin adds policy without replacing a module
 * (docs/architecture.md#hooks).
 *
 * The framework sets no policy of its own. Each hook can observe, change or
 * refuse, and refuses in the core's error shape, so the model always reads the
 * same kind of refusal. Permissions, privacy review, budgets and approvals are
 * built from these.
 */

import type { ArborErrorInfo } from "@4fu/arbor-errors";
import type { Delivery, RenderedPrompt, StreamEvent, ToolCall, ToolResult } from "./agent.ts";
import type { Block } from "./blocks.ts";
import type { Event, EventInput } from "./events.ts";
import type { Effect } from "./effects.ts";
import type { EnvDraft, EnvRevision } from "./environment.ts";
import type { JudgeAnswer, JudgeRequest } from "./judge.ts";
import type { NoteWriteInput } from "./notes.ts";
import type { TaskInput } from "./task.ts";
import type { ServiceStatus } from "./supervisor.ts";
import type { WindowRef } from "./refs.ts";
import type { Handoff } from "./windows.ts";

/** What a hook answers. `context` carries what it changed. */
export type HookOutcome<T> =
  | { allow: true; context?: T }
  | { allow: false; error: ArborErrorInfo };

export interface AppendContext {
  input: EventInput;
  event?: Event;
}

export interface DispatchContext {
  task: TaskInput;
  /** The judge's answer, when the judge decided. */
  answer?: JudgeAnswer;
  /** The window the task went to, or `null` when a new window opens. */
  window?: WindowRef | null;
}

export interface JudgeContext {
  request: JudgeRequest;
  answer?: JudgeAnswer;
  /** The state the judge saw, after scrubbing. */
  scrubbed?: boolean;
}

export interface WindowStartContext {
  window: WindowRef;
  task: TaskInput;
  continuation?: { previous: WindowRef; handoff?: Handoff };
}

export interface WindowEndContext {
  window: WindowRef;
  handoff?: Handoff;
  reason: string;
}

export interface WindowContinueContext {
  window: WindowRef;
  previous: WindowRef;
  handoff?: Handoff;
  /** Set after the hard limit: the window was reset mid-task. */
  midTaskReset?: boolean;
}

export interface ModelRequestContext {
  window: WindowRef;
  prompt: RenderedPrompt;
  inputs: readonly Block[];
}

export interface DeliveryContext {
  window: WindowRef;
  delivery: Delivery;
}

/**
 * One delta of a window's live output, as the model writes it. What a window
 * says to the outside is the `content` argument of the `send` direct tool, so a
 * surface that shows a window's output live reads `tool_call_delta`
 * (docs/windows.md#streaming).
 */
export interface WindowStreamContext {
  window: WindowRef;
  event: StreamEvent;
}

export interface ToolCallContext {
  window: WindowRef;
  call: ToolCall;
  result?: ToolResult;
}

/** What `beforeEffect` answers: release, hold for approval, or drop. */
export type EffectOutcome =
  | { action: "release" }
  | { action: "hold"; approval?: string }
  | { action: "drop"; error: ArborErrorInfo };

/** An effect the host holds until an approval releases or drops it. */
export interface EffectHold {
  effect: Effect;
  release(): Promise<void>;
  drop(reason: string): Promise<void>;
}

export interface EffectContext {
  effect: Effect;
  /** The executor that owns it. */
  executor?: string;
}

export interface NoteWriteContext {
  window: WindowRef;
  input: NoteWriteInput;
  /** The revision that was written, for `afterNoteWrite`. */
  revision?: number;
}

export interface ReloadContext {
  window: WindowRef;
  drafts: readonly EnvDraft[];
  remove?: readonly string[];
  revision?: EnvRevision;
}

export interface ServiceStateContext {
  service: string;
  status: ServiceStatus;
}

export interface Hooks {
  beforeAppend?(context: AppendContext): Promise<HookOutcome<AppendContext>> | HookOutcome<AppendContext>;
  afterAppend?(context: AppendContext): Promise<void> | void;

  beforeDispatch?(context: DispatchContext): Promise<HookOutcome<DispatchContext>> | HookOutcome<DispatchContext>;
  afterDispatch?(context: DispatchContext): Promise<void> | void;

  beforeJudge?(context: JudgeContext): Promise<HookOutcome<JudgeContext>> | HookOutcome<JudgeContext>;
  afterJudge?(context: JudgeContext): Promise<void> | void;

  windowStart?(context: WindowStartContext): Promise<HookOutcome<WindowStartContext>> | HookOutcome<WindowStartContext>;
  windowEnd?(context: WindowEndContext): Promise<HookOutcome<WindowEndContext>> | HookOutcome<WindowEndContext>;
  windowContinue?(context: WindowContinueContext): Promise<HookOutcome<WindowContinueContext>> | HookOutcome<WindowContinueContext>;

  beforeModelRequest?(context: ModelRequestContext): Promise<HookOutcome<ModelRequestContext>> | HookOutcome<ModelRequestContext>;

  beforeDelivery?(context: DeliveryContext): Promise<HookOutcome<DeliveryContext>> | HookOutcome<DeliveryContext>;

  /**
   * One delta of a window's live output. Observation only, and best-effort: it
   * can neither change nor refuse anything, it is not waited for, and a hook
   * that throws or is slow loses its deltas rather than the window
   * (docs/windows.md#streaming).
   */
  windowStream?(context: WindowStreamContext): Promise<void> | void;

  beforeToolCall?(context: ToolCallContext): Promise<HookOutcome<ToolCallContext>> | HookOutcome<ToolCallContext>;
  afterToolCall?(context: ToolCallContext): Promise<void> | void;

  beforeEffect?(context: EffectContext): Promise<EffectOutcome> | EffectOutcome;

  beforeNoteWrite?(context: NoteWriteContext): Promise<HookOutcome<NoteWriteContext>> | HookOutcome<NoteWriteContext>;
  afterNoteWrite?(context: NoteWriteContext): Promise<void> | void;

  beforeReload?(context: ReloadContext): Promise<HookOutcome<ReloadContext>> | HookOutcome<ReloadContext>;
  afterReload?(context: ReloadContext): Promise<void> | void;

  serviceStateChange?(context: ServiceStateContext): Promise<void> | void;
}

/** A held effect, for an approval surface built on `beforeEffect`. */
export interface HeldEffect extends EffectHold {}
