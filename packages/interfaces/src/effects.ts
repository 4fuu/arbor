/**
 * The `EffectExecutor` interface and the effect queue's shapes
 * (docs/architecture.md#interfaces, docs/coordination.md#effects).
 *
 * An effect takes place when it is made and cannot be rolled back. So every
 * effect goes through one queue per host, which paces effects and executes
 * each exactly once, in the order made; effects on one target are serial. Each
 * effect is recorded as an event, so continuations and restarts never repeat
 * it.
 */

import type { Block } from "./blocks.ts";
import type { ExternalRef, Ref, Target, WindowRef } from "./refs.ts";
import type { ArborErrorInfo } from "@4fu/arbor-errors";

export type EffectKind = "send" | (string & {});

/** One queued effect, as the host hands it to an executor. */
export interface Effect {
  /** The event that recorded it, so a continuation never repeats it. */
  event: Ref;
  kind: EffectKind;
  target: Target;
  /** The outside address, for a send. */
  to?: string;
  content: readonly Block[];
  /** The outside message it answers. */
  replyTo?: ExternalRef;
  cites?: readonly Ref[];
  madeBy: WindowRef;
  time: number;
}

export interface EffectResult {
  ok: boolean;
  /** The native id the outside world gave it, for the event's `external`. */
  external?: ExternalRef;
  error?: ArborErrorInfo;
}

export interface EffectExecutor {
  readonly id: string;

  /**
   * Whether this executor owns the effect. One that does not refuses it.
   *
   * It answers from the effect's kind and target alone - never from its event
   * ref, its time or its content - so the queue can ask it about an effect that
   * has not been recorded yet.
   */
  can(effect: Effect): boolean;

  /** Carry the effect out. Called once per effect, by the queue. */
  run(effect: Effect): Promise<EffectResult>;
}
