/**
 * Hooks: how a deployment or a plugin adds policy without replacing a module
 * (docs/architecture.md#hooks).
 *
 * The framework sets no policy of its own. Every hook can observe, change or
 * refuse, and refuses in the core's error shape, so the model always reads the
 * same kind of refusal. The hooks run in the order their plugins registered,
 * each one seeing what the one before it changed, and the first refusal stops
 * the rest.
 *
 * What a refusal does is the point's own:
 *
 * | Point | A refusal |
 * | --- | --- |
 * | append, note write, reload, tool call, dispatch, judge | throws, so the caller answers with the rule |
 * | window start, model request | throws, so the window never opens |
 * | window continue | throws, so the work stops where it is |
 * | delivery | drops the delivery; the window never sees the block |
 * | effect | holds it for an approval, or drops it |
 * | window end | is recorded with the window's end; a window the model ended is not held open by a hook |
 */

import { arborError, type ArborErrorInfo } from "@4fu/arbor-errors";
import type {
  AppendContext,
  DeliveryContext,
  DispatchContext,
  EffectContext,
  EffectOutcome,
  Event,
  EventInput,
  HookOutcome,
  Hooks,
  JudgeContext,
  ModelRequestContext,
  NoteWriteContext,
  ReloadContext,
  ServiceStateContext,
  ToolCallContext,
  WindowContinueContext,
  WindowEndContext,
  WindowStartContext,
  WindowStreamContext,
} from "@4fu/arbor-interfaces";

/** The context each hook runs with, by its name. */
type HookContexts = {
  beforeAppend: AppendContext;
  afterAppend: AppendContext;
  beforeDispatch: DispatchContext;
  afterDispatch: DispatchContext;
  beforeJudge: JudgeContext;
  afterJudge: JudgeContext;
  windowStart: WindowStartContext;
  windowEnd: WindowEndContext;
  windowContinue: WindowContinueContext;
  beforeModelRequest: ModelRequestContext;
  beforeDelivery: DeliveryContext;
  windowStream: WindowStreamContext;
  beforeToolCall: ToolCallContext;
  afterToolCall: ToolCallContext;
  beforeNoteWrite: NoteWriteContext;
  afterNoteWrite: NoteWriteContext;
  beforeReload: ReloadContext;
  afterReload: ReloadContext;
  serviceStateChange: ServiceStateContext;
};

/** A hook name, which is also the name of the context it runs with. */
export type HookPoint = keyof HookContexts;

/** The context one hook point runs with. */
export type HookContextOf<P extends HookPoint> = HookContexts[P];

/** What a window end's hook answers with: the context, and any refusal. */
export interface WindowEndOutcome {
  context: WindowEndContext;
  refused?: ArborErrorInfo;
}

export class HookRunner {
  private readonly hooks: Hooks[] = [];

  /** Register one plugin's hooks. Later registrations run after earlier ones. */
  register(hooks: Hooks): void {
    this.hooks.push(hooks);
  }

  /** How many plugins registered hooks. */
  get registered(): number {
    return this.hooks.length;
  }

  /**
   * True when nothing registered a hook, so a caller on the hot path may skip
   * the call instead of paying for a promise it does not need.
   */
  get empty(): boolean {
    return this.hooks.length === 0;
  }

  /**
   * Before one hook point. Each hook sees what the one before it changed; the
   * first refusal throws in the core's error shape.
   */
  async before<P extends HookPoint>(point: P, context: HookContextOf<P>): Promise<HookContextOf<P>> {
    let current = context;
    for (const hooks of this.hooks) {
      const hook = hooks[point] as
        | ((value: HookContextOf<P>) => HookOutcome<HookContextOf<P>> | Promise<HookOutcome<HookContextOf<P>>>)
        | undefined;
      if (hook === undefined) continue;
      const outcome = await hook(current);
      if (outcome.allow) {
        current = { ...current, ...(outcome.context ?? {}) };
        continue;
      }
      throw arborError(outcome.error);
    }
    return current;
  }

  /** After one hook point. An after hook observes and cannot change anything. */
  async after<P extends HookPoint>(point: P, context: HookContextOf<P>): Promise<void> {
    for (const hooks of this.hooks) {
      const hook = hooks[point] as ((value: HookContextOf<P>) => void | Promise<void>) | undefined;
      if (hook === undefined) continue;
      await hook(context);
    }
  }

  /**
   * Before and after every journal event. A refusal throws, so the caller
   * answers with the rule that refused the write.
   */
  async append(input: EventInput, append: (input: EventInput) => Promise<Event>): Promise<Event> {
    const context = await this.before("beforeAppend", { input });
    const event = await append(context.input);
    await this.after("afterAppend", { ...context, event });
    return event;
  }

  /**
   * Before a delivery is steered into a window. A refusal drops it: the window
   * never sees the block. A hook may also change the delivery, which is how one
   * hides a note from some windows.
   */
  async beforeDelivery(context: DeliveryContext): Promise<DeliveryContext | null> {
    try {
      return await this.before("beforeDelivery", context);
    } catch {
      return null;
    }
  }

  /** A window ends. A refusal is recorded with the end; the window still ends. */
  async windowEnd(context: WindowEndContext): Promise<WindowEndOutcome> {
    try {
      return { context: await this.before("windowEnd", context) };
    } catch (error: unknown) {
      const info = error as ArborErrorInfo;
      if (info.rule === undefined) throw error;
      return { context, refused: info };
    }
  }

  /**
   * Before an effect leaves the queue. A hook may hold it for an approval; the
   * host releases or drops it later, through the effect queue
   * (docs/coordination.md#effects).
   */
  async beforeEffect(context: EffectContext): Promise<EffectOutcome> {
    for (const hooks of this.hooks) {
      const hook = hooks.beforeEffect;
      if (hook === undefined) continue;
      const outcome = await hook(context);
      if (outcome.action !== "release") return outcome;
    }
    return { action: "release" };
  }
}
