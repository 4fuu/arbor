/**
 * One running window, owned by pi (docs/windows.md#lifecycle).
 *
 * The host sees only the core's shapes: it inserts deliveries at a tool-call
 * boundary through pi's steering, queues follow-ups for after the run, ends the
 * run, and reads tool calls, results and usage as they happen. Nothing pi owns
 * crosses the interface.
 *
 * What the model is writing while it runs travels the same way: pi's
 * `message_update` carries its own text and tool-call argument deltas, and this
 * session reports them as the core's `StreamEvent`, so a host surface can show a
 * window's output - above all what it is about to `send` - before the call is
 * even complete (docs/windows.md#streaming).
 */

import type { Agent, AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import { ToolCallArgumentsStream } from "@earendil-works/pi-ai";
import type { AssistantMessage, Usage as PiUsage } from "@earendil-works/pi-ai";
import type {
  Delivery,
  DirectToolSpec,
  Handoff,
  StreamEvent,
  TokenUsage,
  ToolCall,
  ToolResult,
  WindowEndReason,
  WindowEvent,
  WindowOutcome,
  WindowRef,
  WindowSession,
  WindowState,
} from "@4fu/arbor-interfaces";
import { arborError } from "@4fu/arbor-errors";
import type { Renderer } from "@4fu/arbor-prompt";
import { renderDelivery } from "@4fu/arbor-prompt";

export interface PiSessionOptions {
  agent: Agent;
  window: WindowRef;
  renderer: Renderer;
  limits: { limit: number; reserve: number };
  /** The full results, keyed by call id, so the host reads the core's shape. */
  results?: Map<string, ToolResult>;
  /** The first turn, already started by the backend. */
  run: Promise<void>;
  /**
   * Replace the tools this window declares, when the host's set changed while
   * the window runs. The backend owns the call path, so it builds them
   * (docs/tools.md#external-tools-that-change).
   */
  refreshTools?: (tools: readonly DirectToolSpec[]) => void;
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
  /**
   * The arguments of the tool call being written, by content index. pi reports
   * them as JSON text in pieces, and a call still being written is not valid
   * JSON yet, so they are read with pi's own tolerant parser.
   */
  private readonly writing = new Map<number, ToolCallArgumentsStream>();
  /**
   * How this window's declared tools are replaced when the host's set changes.
   * The backend owns the call path, so it builds them
   * (docs/tools.md#external-tools-that-change).
   */
  private readonly refresh: ((tools: readonly DirectToolSpec[]) => void) | undefined;

  constructor(options: PiSessionOptions) {
    this.window = options.window;
    this.agent = options.agent;
    this.refresh = options.refreshTools;
    this.renderer = options.renderer;
    this.results = options.results ?? new Map();
    this.current = { used: 0, limit: options.limits.limit, reserve: options.limits.reserve };
    this.outcomePromise = new Promise<WindowOutcome>((resolve) => {
      this.resolveOutcome = resolve;
    });
    this.unsubscribe = this.agent.subscribe((event) => this.onAgentEvent(event));
    // A finished run is not a finished window: the window stays open for a
    // related input until the host ends it (docs/windows.md#lifecycle).
    void options.run.catch((error: unknown) => this.settle("failed", error));
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

  /**
   * The tools this window may call changed. pi keeps its declaration on the
   * agent's own state, which may be replaced while the window runs, so a tool
   * that appeared is callable from the next model request and one that was
   * removed is not - and the window's prefix is never rebuilt for it
   * (docs/tools.md#external-tools-that-change).
   */
  refreshTools(tools: readonly DirectToolSpec[]): void {
    if (this.ended) return;
    this.refresh?.(tools);
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
      case "message_start":
        // A new response numbers its content blocks from zero again.
        this.writing.clear();
        break;
      case "message_update": {
        const delta = this.deltaOf(event);
        if (delta !== undefined) this.stream.push(delta);
        break;
      }
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
        if (event.message.role === "assistant") {
          this.trackUsage(event.message.usage);
          // What the model said in this turn, as one event on the window's
          // record: the host journals it, so `windows.show` replays it and a
          // continuation reads what its predecessor said. A message that only
          // carries tool calls says nothing and records nothing.
          const text = assistantText(event.message);
          if (text !== "") this.stream.push({ kind: "appended", event: text });
        }
        break;
      case "agent_end":
        this.stream.push({ kind: "run_ended", outcome: this.outcomeOf("model_ended") });
        break;
      default:
        break;
    }
  }

  /**
   * One delta of what the model is writing, or nothing when this event is not
   * one. pi's `message_update` carries the provider's own event: `text_delta`
   * for assistant text, `toolcall_delta` for the arguments of a tool call as
   * they are written. What stands so far is what the delta reports, so a
   * surface that shows a window's output never reassembles the pieces itself
   * (docs/windows.md#streaming).
   */
  private deltaOf(event: Extract<AgentEvent, { type: "message_update" }>): StreamEvent | undefined {
    const inner = event.assistantMessageEvent;
    if (inner.type === "text_delta") return { kind: "text_delta", delta: inner.delta };
    // A provider reports the tool call's name and id on the chunk that opens it,
    // which need not carry any argument text yet.
    if (inner.type !== "toolcall_delta" || inner.delta === "") return undefined;
    const block = writingCall(event.message, inner.contentIndex);
    if (block === undefined) return undefined;
    let arguments_ = this.writing.get(inner.contentIndex);
    if (arguments_ === undefined) {
      arguments_ = new ToolCallArgumentsStream();
      this.writing.set(inner.contentIndex, arguments_);
    }
    return {
      kind: "tool_call_delta",
      call: { name: block.name, args: arguments_.append(inner.delta), callId: block.id },
    };
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

  /** The outcome as it stands, for a run that ended. */
  private outcomeOf(reason: WindowEndReason, handoff?: Handoff): WindowOutcome {
    return {
      window: this.window,
      reason,
      ...(handoff === undefined ? {} : { handoff }),
      usage: this.current,
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

/** The text one assistant message carries, without its tool calls. */
function assistantText(message: AssistantMessage): string {
  return message.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("\n");
}

/**
 * The tool call block at one content index of a message still being written.
 * pi keeps the partial message's blocks in place, so the block a delta belongs
 * to is the one at its own index; its name and id may still be filling in.
 */
function writingCall(message: AgentMessage, index: number): { name: string; id: string } | undefined {
  if (message.role !== "assistant") return undefined;
  const block = message.content[index];
  return block !== undefined && block.type === "toolCall" ? block : undefined;
}
