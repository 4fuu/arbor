/**
 * One running window, owned by pi (docs/windows.md#lifecycle).
 *
 * The host sees only the core's shapes: it inserts deliveries at a tool-call
 * boundary through pi's steering, queues follow-ups for after the run, ends the
 * run, and reads tool calls, results and usage as they happen. Nothing pi owns
 * crosses the interface.
 */

import type { Agent, AgentEvent } from "@earendil-works/pi-agent-core";
import type { Usage as PiUsage } from "@earendil-works/pi-ai";
import type {
  Delivery,
  Handoff,
  TokenUsage,
  ToolCall,
  ToolResult,
  WindowEndReason,
  WindowEvent,
  WindowOutcome,
  WindowRef,
  WindowSession,
  WindowState,
} from "@arbor/interfaces";
import { arborError } from "@arbor/errors";
import type { Renderer } from "@arbor/prompt";
import { renderDelivery } from "@arbor/prompt";

export interface PiSessionOptions {
  agent: Agent;
  window: WindowRef;
  renderer: Renderer;
  limits: { limit: number; reserve: number };
  /** The full results, keyed by call id, so the host reads the core's shape. */
  results?: Map<string, ToolResult>;
  /** The first turn, already started by the backend. */
  run: Promise<void>;
}

/** A queue of window events the host drains as they happen. */
class EventQueue {
  private readonly pending: WindowEvent[] = [];
  private readonly waiting: (() => void)[] = [];
  private closed = false;

  push(event: WindowEvent): void {
    this.pending.push(event);
    this.flush();
  }

  close(): void {
    this.closed = true;
    this.flush();
  }

  async *drain(): AsyncGenerator<WindowEvent> {
    for (;;) {
      const next = this.pending.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (this.closed) return;
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
  }

  private flush(): void {
    while (this.waiting.length > 0 && (this.pending.length > 0 || this.closed)) {
      this.waiting.shift()?.();
    }
  }
}

export class PiWindowSession implements WindowSession {
  readonly window: WindowRef;

  private readonly agent: Agent;
  private readonly renderer: Renderer;
  private readonly stream = new EventQueue();
  private readonly outcomePromise: Promise<WindowOutcome>;
  private resolveOutcome: (outcome: WindowOutcome) => void = () => {};
  private unsubscribe: (() => void) | undefined;
  private ended = false;
  private paused = false;
  private current: TokenUsage;
  private readonly results: Map<string, ToolResult>;

  constructor(options: PiSessionOptions) {
    this.window = options.window;
    this.agent = options.agent;
    this.renderer = options.renderer;
    this.results = options.results ?? new Map();
    this.current = { used: 0, limit: options.limits.limit, reserve: options.limits.reserve };
    this.outcomePromise = new Promise<WindowOutcome>((resolve) => {
      this.resolveOutcome = resolve;
    });
    this.unsubscribe = this.agent.subscribe((event) => this.onAgentEvent(event));
    void options.run.then(
      () => this.settle("model_ended"),
      (error: unknown) => this.settle("failed", error),
    );
  }

  get state(): WindowState {
    if (this.ended) return "ended";
    if (this.paused) return "paused";
    return this.agent.state.isStreaming ? "running" : "idle";
  }

  async steer(delivery: Delivery): Promise<void> {
    if (this.ended) {
      throw arborError({
        code: "refused",
        rule: "window.ended",
        message: `窗口 ${this.window} 已结束，无法再插入内容。`,
        nextAction: "把内容发给一个还在运行的窗口，或为它开一个新窗口。",
      });
    }
    this.enqueue(delivery, "steer");
    if (!this.agent.state.isStreaming) await this.continue_();
    this.stream.push({ kind: "steered", delivery });
  }

  async followUp(delivery: Delivery): Promise<void> {
    if (this.ended) return;
    this.enqueue(delivery, "followUp");
  }

  async end(handoff?: Handoff, reason: WindowEndReason = "model_ended"): Promise<void> {
    if (this.ended) return;
    this.agent.abort();
    this.settle(reason, undefined, handoff);
  }

  async pause(): Promise<void> {
    this.paused = true;
  }

  async resume(): Promise<void> {
    this.paused = false;
  }

  usage(): TokenUsage {
    return this.current;
  }

  events(): AsyncIterable<WindowEvent> {
    return this.stream.drain();
  }

  outcome(): Promise<WindowOutcome> {
    return this.outcomePromise;
  }

  private enqueue(delivery: Delivery, how: "steer" | "followUp"): void {
    const text = renderDelivery(delivery, this.renderer);
    const message = { role: "user" as const, content: [{ type: "text" as const, text }], timestamp: Date.now() };
    if (how === "steer") this.agent.steer(message);
    else this.agent.followUp(message);
  }

  /** Continue an idle window, so a queued delivery is picked up. */
  private async continue_(): Promise<void> {
    try {
      await this.agent.continue();
    } catch {
      // Nothing queued any more, or the run already moved on.
    }
  }

  private onAgentEvent(event: AgentEvent): void {
    switch (event.type) {
      case "tool_execution_start":
        this.stream.push({
          kind: "tool_call",
          call: callOf(event.toolName, event.args, event.toolCallId),
        });
        break;
      case "tool_execution_end":
        this.stream.push({
          kind: "tool_result",
          call: callOf(event.toolName, {}, event.toolCallId),
          result: this.resultOf(event),
        });
        break;
      case "message_end":
        if (event.message.role === "assistant") this.trackUsage(event.message.usage);
        break;
      default:
        break;
    }
  }

  /**
   * The window's footprint: the last request's input, cache read and cache
   * write. A running total would resend the context on every turn and cross
   * the reminder tiers within a few turns.
   */
  private trackUsage(usage: PiUsage | undefined): void {
    if (usage === undefined) return;
    const used = usage.input + usage.cacheRead + usage.cacheWrite;
    if (used <= this.current.used) return;
    this.current = { ...this.current, used };
    this.stream.push({ kind: "usage", usage: this.current });
  }

  /** The core's result, kept by the backend when the call was made. */
  private resultOf(event: Extract<AgentEvent, { type: "tool_execution_end" }>): ToolResult {
    const kept = this.results.get(event.toolCallId);
    if (kept !== undefined) return kept;
    const content = ((event.result?.content ?? []) as readonly { type: string; text?: string }[])
      .map((block) => (block.type === "text" ? (block.text ?? "") : `[${block.type}]`))
      .join("\n");
    const isError = event.isError === true;
    return {
      callId: event.toolCallId,
      ok: isError === false,
      content,
      ...(isError ? { error: { rule: "tool.execution", message: content.slice(0, 500) } } : {}),
    };
  }

  private settle(reason: WindowEndReason, error?: unknown, handoff?: Handoff): void {
    if (this.ended) return;
    this.ended = true;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    const outcome: WindowOutcome = {
      window: this.window,
      reason,
      ...(handoff === undefined ? {} : { handoff }),
      usage: this.current,
      ...(error === undefined ? {} : { error: error instanceof Error ? error.message : String(error) }),
    };
    this.stream.push({ kind: "ended", outcome });
    this.stream.close();
    this.resolveOutcome(outcome);
  }
}

function callOf(name: string, args: unknown, callId: string): ToolCall {
  return { name, args: (args ?? {}) as Record<string, unknown>, callId };
}


