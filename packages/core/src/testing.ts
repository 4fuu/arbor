/**
 * A scripted backend and a manual clock, so the window lifecycle is tested
 * without a model and without waiting for one.
 *
 * The backend implements `AgentBackend` and answers with the steps a test
 * scripts: a tool call, a piece of text, or a usage report. It drives the same
 * path a real backend does - the host's tool control, the event stream, the
 * outcome - so the lifecycle under test is the real one.
 */

import type {
  AgentBackend,
  Delivery,
  ModelInfo,
  OpenWindowRequest,
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
import type { EventRef } from "@arbor/interfaces";

/** One step of a scripted run. */
export type Step =
  | { tool: string; args?: Record<string, unknown>; result?: Partial<ToolResult> }
  | { text: string }
  | { usage: TokenUsage };

/** The host's window control, which the backend calls the same way pi does. */
export interface ScriptedControl {
  recordToolCall(window: WindowRef, call: ToolCall): Promise<EventRef | undefined>;
  runToolCall(window: WindowRef, call: ToolCall, at?: EventRef): Promise<ToolResult>;
  endRequested(window: WindowRef): boolean;
}

/** Let the host's watchers run, so a test observes what it recorded. */
export function turn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Timers a test fires by hand. */
export class ManualTimers {
  private next = 1;
  private readonly pending = new Map<number, () => void>();

  setTimeout(handler: () => void, _ms: number): { id: unknown } {
    const id = this.next;
    this.next += 1;
    this.pending.set(id, handler);
    return { id };
  }

  clearTimeout(timer: { id: unknown }): void {
    this.pending.delete(Number(timer.id));
  }

  /** How many timers are waiting. */
  get size(): number {
    return this.pending.size;
  }

  /** Fire every waiting timer. */
  fireAll(): void {
    const handlers = [...this.pending.values()];
    this.pending.clear();
    for (const handler of handlers) handler();
  }
}

class ScriptedSession implements WindowSession {
  readonly window: WindowSession["window"];

  private readonly backend: ScriptedBackend;
  private current: WindowState = "running";
  private current_: TokenUsage;
  private readonly stream: WindowEvent[] = [];
  private readonly waiting: (() => void)[] = [];
  private readonly outcomePromise: Promise<WindowOutcome>;
  private readonly resolveOutcome: (outcome: WindowOutcome) => void;
  private readonly runDone: Promise<void>;
  private readonly resolveRun: () => void;
  private ended = false;
  /** The run's steps are used up, or the window ended. */
  settled = false;

  constructor(backend: ScriptedBackend, window: string, usage: TokenUsage) {
    this.backend = backend;
    this.window = window as WindowSession["window"];
    this.current_ = usage;
    let resolveOutcome: (outcome: WindowOutcome) => void = () => {};
    let resolveRun: () => void = () => {};
    this.outcomePromise = new Promise<WindowOutcome>((resolve) => {
      resolveOutcome = resolve;
    });
    this.runDone = new Promise<void>((resolve) => {
      resolveRun = resolve;
    });
    this.resolveOutcome = resolveOutcome;
    this.resolveRun = resolveRun;
  }

  get state(): WindowState {
    return this.current;
  }

  async steer(delivery: Delivery): Promise<void> {
    this.push({ kind: "steered", delivery });
    if (this.current === "idle") void this.backend.play(this);
  }

  async followUp(delivery: Delivery): Promise<void> {
    this.push({ kind: "steered", delivery });
  }

  async end(handoff?: unknown, reason: WindowEndReason = "model_ended"): Promise<void> {
    if (this.ended) return;
    this.settled = true;
    this.ended = true;
    this.current = "ended";
    const outcome: WindowOutcome = {
      window: this.window as WindowOutcome["window"],
      reason,
      ...(handoff === undefined ? {} : { handoff: handoff as WindowOutcome["handoff"] }),
      usage: this.current_,
    };
    this.push({ kind: "ended", outcome });
    this.resolveOutcome(outcome);
    this.finishRun();
  }

  async pause(): Promise<void> {
    this.current = "paused";
  }

  async resume(): Promise<void> {
    this.current = "running";
  }

  usage(): TokenUsage {
    return this.current_;
  }

  events(): AsyncIterable<WindowEvent> {
    return this.drain();
  }

  outcome(): Promise<WindowOutcome> {
    return this.outcomePromise;
  }

  /** The run's steps are used up. */
  runFinished(): Promise<void> {
    return this.runDone;
  }

  push(event: WindowEvent): void {
    this.stream.push(event);
    this.flush();
  }

  setUsage(usage: TokenUsage): void {
    this.current_ = usage;
    this.push({ kind: "usage", usage });
  }

  /** The run ended; the window stays open for a related input. */
  runEnded(): void {
    this.settled = true;
    if (this.current === "ended") return;
    this.current = "idle";
    this.push({
      kind: "run_ended",
      outcome: {
        window: this.window as WindowOutcome["window"],
        reason: "model_ended",
        usage: this.current_,
      },
    });
    this.finishRun();
  }

  private finishRun(): void {
    this.settled = true;
    this.resolveRun();
    this.flush();
  }

  private async *drain(): AsyncGenerator<WindowEvent> {
    for (;;) {
      const next = this.stream.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (this.current === "ended") return;
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
  }

  private flush(): void {
    while (this.waiting.length > 0 && (this.stream.length > 0 || this.state === "ended")) {
      this.waiting.shift()?.();
    }
  }
}

/** A backend that answers with the steps a test scripts. */
export class ScriptedBackend implements AgentBackend {
  readonly name = "scripted";

  /** Every window the host opened, in order. */
  readonly opened: OpenWindowRequest[] = [];

  private steps: Step[] = [];
  private control: ScriptedControl | undefined;
  private readonly sessions = new Set<ScriptedSession>();

  /** Hand the backend the host's window control. */
  attach(control: ScriptedControl): void {
    this.control = control;
  }

  /** Script the next run's steps. */
  script(steps: readonly Step[]): void {
    this.steps = [...steps];
  }

  async models(): Promise<ModelInfo[]> {
    return [{ id: "scripted-1", provider: "scripted", images: true }];
  }

  async login(): Promise<never> {
    throw new Error("the scripted backend has no providers");
  }

  async open(request: OpenWindowRequest): Promise<WindowSession> {
    this.opened.push(request);
    const session = new ScriptedSession(this, request.window, {
      used: 0,
      limit: request.limits.contextTokens,
      reserve: request.limits.reserveTokens,
    });
    this.sessions.add(session);
    void this.play(session);
    return session;
  }

  /** Run the scripted steps, then report that the run ended. */
  async play(session: ScriptedSession): Promise<void> {
    if (this.control === undefined) return;
    const steps = this.steps;
    this.steps = [];
    for (const step of steps) {
      if (session.state === "ended") return;
      if ("tool" in step) {
        const call: ToolCall = {
          name: step.tool,
          args: step.args ?? {},
          callId: `call_${this.opened.length}_${step.tool}`,
        };
        const at = await this.control.recordToolCall(session.window, call);
        const result = await this.control.runToolCall(session.window, call, at);
        session.push({ kind: "tool_call", call });
        session.push({ kind: "tool_result", call, result });
        continue;
      }
      if ("usage" in step) {
        session.setUsage(step.usage);
        continue;
      }
      session.push({ kind: "appended", event: step.text });
    }
    session.runEnded();
  }

  /**
   * Resolves when every scripted run has used up its steps and the host has
   * seen the events it produced. A window is opened asynchronously, so this
   * waits for the session to exist before it waits for the run.
   */
  async finished(): Promise<void> {
    for (let attempt = 0; attempt < 500; attempt += 1) {
      if (this.steps.length === 0) {
        const busy = [...this.sessions].filter((session) => !session.settled);
        if (busy.length === 0) {
          await turn();
          await turn();
          return;
        }
      }
      await turn();
    }
    throw new Error("the scripted run never finished");
  }
}
