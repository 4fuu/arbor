/**
 * The effect queue: one per host, so every effect runs exactly once and in the
 * order it was made, and effects on one target are serial
 * (docs/coordination.md#effects).
 *
 * An effect takes place when it is made and cannot be rolled back, so each one
 * is recorded as an event before it runs. A continuation and a restart never
 * repeat it: the event is the record that it happened.
 *
 * An effect no registered executor owns stays recorded and waits for a plugin
 * that plugs one in. The host asks `owns` before it records anything, so a
 * window's own `send` is refused at its call instead - with the rule and the
 * next action - and a `send` in the journal is always one an executor owned when
 * it was made.
 */

import type {
  Effect,
  EffectExecutor,
  Event,
  EventRef,
  ExternalRef,
  Ref,
  Target,
  TextTable,
  WindowRef,
} from "@4fu/arbor-interfaces";
import type { Journal } from "@4fu/arbor-interfaces";
import type { Block } from "@4fu/arbor-interfaces";
import { textOf, zhTextTable } from "@4fu/arbor-prompt";
import type { HookRunner } from "./hooks.ts";

/** What a `send` hands the queue. */
export interface EffectInput {
  kind: string;
  target: Target;
  to?: string;
  content: readonly Block[];
  replyTo?: string;
  cites?: readonly Ref[];
  window: WindowRef;
}

export interface EffectOutcome {
  /** The event that recorded the effect. */
  event: EventRef;
  /** Events on the target the window has not seen yet. */
  behind: number;
}

export interface EffectQueueOptions {
  /** Hooks, from a plugin: an effect can be held for an approval or dropped. */
  hooks?: HookRunner;
  /** The fixed strings the result event records. */
  table?: TextTable;
  /**
   * Called with each effect's result event, so the host circulates it: the
   * window that made the effect hears whether it was carried out
   * (docs/coordination.md#effects).
   */
  onResult?: (event: Event) => void | Promise<void>;
}

export class EffectQueue {
  private readonly journal: Journal;
  private executors: readonly EffectExecutor[];
  private readonly hooks: HookRunner | undefined;
  private readonly table: TextTable;
  private readonly onResult: ((event: Event) => void | Promise<void>) | undefined;
  private readonly queue: Effect[] = [];
  /** Effects no executor owns yet. They stay recorded and wait for a plugin. */
  private readonly unowned: Effect[] = [];
  /** Effects a hook held for an approval, by the approval it named. */
  private readonly held = new Map<string, Effect[]>();
  private readonly running = new Set<Target>();
  private draining = false;

  constructor(journal: Journal, executors: readonly EffectExecutor[] = [], options: EffectQueueOptions = {}) {
    this.journal = journal;
    this.executors = executors;
    this.hooks = options.hooks;
    this.table = options.table ?? zhTextTable;
    this.onResult = options.onResult;
  }

  /** Record one effect and queue it. The effect is not carried out yet. */
  async submit(input: EffectInput): Promise<EffectOutcome> {
    const event = await this.journal.append({
      kind: "send",
      window: input.window,
      body: input.content.map((block) => blockText(block)).join("\n"),
      targets: [input.target],
      refs: [
        ...(input.replyTo === undefined ? [] : [input.replyTo as Ref]),
        ...(input.cites ?? []),
      ],
    });
    this.queue.push(effectOf(input, event.ref, event.time));
    void this.drain();
    return { event: event.ref, behind: await this.behind(input.window, input.target) };
  }

  /**
   * Whether any registered executor owns an effect of this shape.
   *
   * The host asks before it records one, so a window hears at its own call
   * that nothing will carry its effect out - with the rule and the next action
   * - instead of recording a send that goes nowhere in silence
   * (docs/coordination.md#effects).
   */
  owns(input: EffectInput): boolean {
    // The event ref and the time are placeholders: an executor answers from the
    // effect's kind and target, so the question can be asked before one exists.
    return this.executors.some((executor) => executor.can(effectOf(input, "r0" as EventRef, 0)));
  }

  /** How many events on the target the window has not seen yet. */
  private async behind(window: WindowRef, target: Target): Promise<number> {
    const gaps = await this.journal.targetsBehind(window);
    return gaps.filter((gap) => gap.target === target).reduce((total, gap) => total + gap.count, 0);
  }

  /** Carry the queued effects out, one target at a time. */
  async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      for (;;) {
        const next = this.queue.find((effect) => !this.running.has(effect.target));
        if (next === undefined) break;
        this.running.add(next.target);
        this.queue.splice(this.queue.indexOf(next), 1);
        try {
          await this.run(next);
        } finally {
          this.running.delete(next.target);
        }
      }
    } finally {
      this.draining = false;
    }
  }

  /** How many effects are still waiting, including the ones nobody owns. */
  pending(): number {
    return this.queue.length + this.unowned.length + this.heldCount();
  }

  /** How many effects a hook is holding for an approval. */
  heldCount(): number {
    let total = 0;
    for (const effects of this.held.values()) total += effects.length;
    return total;
  }

  /**
   * Release the effects an approval held. `approval` names what the hook held
   * them for; without one, everything held is released.
   */
  async release(approval?: string): Promise<number> {
    const keys = approval === undefined ? [...this.held.keys()] : [approval];
    let released = 0;
    for (const key of keys) {
      const effects = this.held.get(key);
      if (effects === undefined) continue;
      this.held.delete(key);
      this.queue.push(...effects);
      released += effects.length;
    }
    if (released > 0) void this.drain();
    return released;
  }

  /** Drop the effects an approval held, recording that they will not happen. */
  async drop(approval: string | undefined, reason: string): Promise<number> {
    const keys = approval === undefined ? [...this.held.keys()] : [approval];
    let dropped = 0;
    for (const key of keys) {
      const effects = this.held.get(key);
      if (effects === undefined) continue;
      this.held.delete(key);
      dropped += effects.length;
      for (const effect of effects) await this.record(effect, { ok: false, error: reason });
    }
    return dropped;
  }

  /** Register an executor that arrived after the effects it owns were made. */
  addExecutor(executor: EffectExecutor): void {
    this.executors = [...this.executors, executor];
    const ready = this.unowned.filter((effect) => executor.can(effect));
    this.unowned.splice(0, this.unowned.length, ...this.unowned.filter((effect) => !executor.can(effect)));
    this.queue.push(...ready);
    void this.drain();
  }

  private async run(effect: Effect): Promise<void> {
    const outcome = this.hooks === undefined ? { action: "release" as const } : await this.hooks.beforeEffect({ effect });
    if (outcome.action === "hold") {
      const key = outcome.approval ?? effect.event;
      const held = this.held.get(key);
      if (held === undefined) this.held.set(key, [effect]);
      else held.push(effect);
      return;
    }
    if (outcome.action === "drop") {
      await this.record(effect, { ok: false, error: outcome.error.message });
      return;
    }
    const executor = this.executors.find((one) => one.can(effect));
    if (executor === undefined) {
      // No executor owns this effect yet: it stays recorded, and a plugin that
      // plugs one in carries it out.
      this.unowned.push(effect);
      return;
    }
    const result = await executor.run(effect);
    await this.record(effect, {
      ok: result.ok,
      ...(result.error === undefined ? {} : { error: result.error.message }),
      ...(result.external === undefined ? {} : { external: result.external }),
    });
  }

  /**
   * One effect's result, as an event on its target. The body is the one fixed
   * line the text table holds, so the window that made the effect reads the
   * same words whether the channel took it or the executor failed
   * (docs/coordination.md#effects).
   */
  private async record(
    effect: Effect,
    result: { ok: boolean; error?: string; external?: ExternalRef },
  ): Promise<void> {
    const body = textOf(
      this.table,
      result.ok ? "result.effect.ok" : "result.effect.failed",
      result.ok ? { ref: effect.event } : { ref: effect.event, reason: result.error ?? "" },
    );
    const event = await this.journal.append({
      kind: "effect_result",
      window: effect.madeBy,
      body,
      targets: [effect.target],
      refs: [effect.event],
      ...(result.external === undefined ? {} : { external: result.external }),
    });
    // The result goes back out, so the window that made the effect hears it.
    await this.onResult?.(event);
  }
}

function blockText(block: Block): string {
  const content = block.fields.content;
  return typeof content === "string" ? content : "";
}

/** The queued effect one input becomes, once the journal has named it. */
function effectOf(input: EffectInput, event: EventRef, time: number): Effect {
  return {
    event,
    kind: input.kind,
    target: input.target,
    ...(input.to === undefined ? {} : { to: input.to }),
    content: input.content,
    ...(input.replyTo === undefined ? {} : { replyTo: input.replyTo as Effect["replyTo"] }),
    ...(input.cites === undefined ? {} : { cites: input.cites }),
    madeBy: input.window,
    time,
  };
}
