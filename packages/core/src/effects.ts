/**
 * The effect queue: one per host, so every effect runs exactly once and in the
 * order it was made, and effects on one target are serial
 * (docs/coordination.md#effects).
 *
 * An effect takes place when it is made and cannot be rolled back, so each one
 * is recorded as an event before it runs. A continuation and a restart never
 * repeat it: the event is the record that it happened.
 */

import type { Effect, EffectExecutor, EffectResult, EventRef, Ref, Target, WindowRef } from "@4fu/arbor-interfaces";
import type { Journal } from "@4fu/arbor-interfaces";
import type { Block } from "@4fu/arbor-interfaces";
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
}

export class EffectQueue {
  private readonly journal: Journal;
  private executors: readonly EffectExecutor[];
  private readonly hooks: HookRunner | undefined;
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
    this.queue.push({
      event: event.ref,
      kind: input.kind,
      target: input.target,
      ...(input.to === undefined ? {} : { to: input.to }),
      content: input.content,
      ...(input.replyTo === undefined ? {} : { replyTo: input.replyTo as Effect["replyTo"] }),
      ...(input.cites === undefined ? {} : { cites: input.cites }),
      madeBy: input.window,
      time: event.time,
    });
    void this.drain();
    return { event: event.ref, behind: await this.behind(input.window, input.target) };
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
      for (const effect of effects) {
        await this.journal.append({
          kind: "effect_result",
          window: effect.madeBy,
          body: `dropped ${reason}`,
          targets: [effect.target],
          refs: [effect.event],
        });
      }
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
      await this.journal.append({
        kind: "effect_result",
        window: effect.madeBy,
        body: `dropped ${outcome.error.message}`,
        targets: [effect.target],
        refs: [effect.event],
      });
      return;
    }
    const executor = this.executors.find((one) => one.can(effect));
    if (executor === undefined) {
      // No executor owns this effect yet: it stays recorded, and a plugin that
      // plugs one in carries it out.
      this.unowned.push(effect);
      return;
    }
    const result: EffectResult = await executor.run(effect);
    await this.journal.append({
      kind: "effect_result",
      window: effect.madeBy,
      body: result.ok ? "ok" : (result.error?.message ?? "failed"),
      targets: [effect.target],
      refs: [effect.event],
      ...(result.external === undefined ? {} : { external: result.external }),
    });
  }
}

function blockText(block: Block): string {
  const content = block.fields.content;
  return typeof content === "string" ? content : "";
}
