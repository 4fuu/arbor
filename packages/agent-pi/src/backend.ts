/**
 * The default `AgentBackend`: pi-agent-core in process
 * (docs/architecture.md#interfaces).
 *
 * arbor uses pi's `Agent` with its own system prompt: pi's default coding
 * prompt, context files and skills never reach the model
 * (docs/prompting.md#no-built-in-pi-prompt). Reminders and deliveries are
 * user-role text inside inputs, never system messages in the middle of a
 * window, because some providers fold those into the leading system prompt and
 * that breaks the cached prefix.
 *
 * No pi type crosses the interface. The backend takes the core's
 * `OpenWindowRequest`, hands back the core's `WindowSession`, and reports the
 * core's models, usage and outcomes. Everything it needs from the host - the
 * catalog, the renderer, the call path - arrives through its options.
 */

import { Agent } from "@earendil-works/pi-agent-core";
import type { Api, Model as PiModel, Models } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type {
  AgentBackend,
  LoginRequest,
  LoginResult,
  ModelInfo,
  OpenWindowRequest,
  ToolCall,
  ToolResult,
  WindowSession,
} from "@arbor/interfaces";
import { arborError } from "@arbor/errors";
import { Renderer } from "@arbor/prompt";
import { PiWindowSession } from "./session.ts";
import { piTool } from "./tools.ts";

/** What the host gives the backend about the window it is running. */
export interface WindowControl {
  /** Record one call at an event, before it runs. */
  recordToolCall(window: string, call: ToolCall): Promise<string | undefined>;
  /** Run one call through the host's tool groups, the same path a direct call takes. */
  runToolCall(window: string, call: ToolCall, at?: string): Promise<ToolResult>;
  /** True once the window should end after the current turn. */
  endRequested(window: string): boolean;
}

export interface PiBackendOptions {
  /** pi's model runtime. Defaults to every built-in provider. */
  models?: Models;
  /** The one renderer, for deliveries steered into a window. */
  renderer?: Renderer;
  control?: WindowControl;
  /** The name this backend reports. */
  name?: string;
}

export class PiAgentBackend implements AgentBackend {
  readonly name: string;

  private readonly runtime: Models;
  private readonly renderer: Renderer;
  private control: WindowControl | undefined;

  constructor(options: PiBackendOptions = {}) {
    this.name = options.name ?? "pi";
    this.runtime = options.models ?? builtinModels();
    this.renderer = options.renderer ?? new Renderer();
    this.control = options.control;
  }

  /**
   * Take the host's window control. A backend that runs windows in process
   * needs it, and the host builds it after the backend exists, so the two are
   * joined here rather than through a constructor argument.
   */
  attachControl(control: WindowControl): void {
    this.control = control;
  }

  /** The catalog this backend can run. Only models that take images. */
  async models(): Promise<ModelInfo[]> {
    const found: ModelInfo[] = [];
    for (const model of this.runtime.getModels()) {
      if (!model.input.includes("image")) continue;
      found.push({ id: model.id, provider: model.provider, name: model.name, images: true });
    }
    return found;
  }

  /**
   * Log in to a provider. A key is never passed here: the request names a
   * secret, and the deployment hands the value to pi outside arbor
   * (docs/environment.md#what-the-model-can-change).
   */
  async login(request: LoginRequest): Promise<LoginResult> {
    const provider = this.runtime.getProvider(request.provider);
    if (provider === undefined) {
      return {
        provider: request.provider,
        state: "failed",
        models: [],
        error: `provider ${request.provider} is not registered`,
      };
    }
    const check = await this.runtime.checkAuth(request.provider);
    if (check !== undefined) {
      return { provider: request.provider, state: "logged-in", models: this.modelsOf(request.provider) };
    }
    return {
      provider: request.provider,
      state: "logged-out",
      models: this.modelsOf(request.provider),
      error:
        request.secret === undefined
          ? `provider ${request.provider} has no credential; name the secret that holds its key`
          : `provider ${request.provider} has no credential; configure the secret ${request.secret}`,
    };
  }

  /** Open one window and start its first turn. */
  async open(request: OpenWindowRequest): Promise<WindowSession> {
    const model = this.modelOf(request.model);
    if (model === undefined) {
      throw arborError({
        code: "not_found",
        rule: "backend.model.unknown",
        message: `backend: 模型 ${request.model} 不在目录中`,
        nextAction: "使用 backend.models() 列出的模型 id，或在设置中把该档位映射到另一个模型。",
      });
    }
    const results = new Map<string, ToolResult>();
    const agent = new Agent({
      streamFn: (piModel, context, options) => this.runtime.streamSimple(piModel, context, options),
      getApiKey: async (provider: string) => {
        const auth = await this.runtime.getAuth(provider);
        return auth?.auth.apiKey;
      },
      initialState: {
        systemPrompt: systemPromptOf(request),
        model,
        tools: request.tools.map((tool) =>
          piTool(tool, (args, callId) => this.callTool(request.window, tool.name, args, callId, results), this.renderer),
        ),
      },
      steeringMode: "all",
      followUpMode: "all",
      finishTurn: () =>
        this.control?.endRequested(request.window) === true ? { action: "end" } : undefined,
    });
    const first = request.firstInput ?? "";
    const run =
      first === ""
        ? Promise.resolve()
        : agent.prompt(first).then(
            () => undefined,
            () => undefined,
          );
    return new PiWindowSession({
      agent,
      window: request.window,
      renderer: this.renderer,
      limits: { limit: request.limits.contextTokens, reserve: request.limits.reserveTokens },
      results,
      run,
    });
  }

  /**
   * One direct tool call. The call is recorded at its event before it runs, and
   * the call itself goes through the host's tool groups - the same path a direct
   * call takes (docs/tools.md#rules).
   */
  private async callTool(
    window: string,
    name: string,
    args: Record<string, unknown>,
    callId: string,
    results: Map<string, ToolResult>,
  ): Promise<ToolResult> {
    const call: ToolCall = { name, args, callId };
    if (this.control === undefined) {
      return {
        callId,
        ok: false,
        content: "",
        error: {
          rule: "backend.call_path.missing",
          message: `backend: 没有提供 ${name} 的调用路径`,
          nextAction: "在 host 中注册工具组。",
        },
      };
    }
    let at: string | undefined;
    try {
      at = await this.control.recordToolCall(window, call);
    } catch {
      at = undefined;
    }
    const result = await this.control.runToolCall(window, call, at);
    results.set(callId, result);
    return result;
  }

  /** The model a request names, from the catalog. */
  private modelOf(id: string): PiModel<Api> | undefined {
    const wanted = id.includes("/") ? id.slice(id.indexOf("/") + 1) : id;
    return this.runtime.getModels().find((model) => model.id === wanted);
  }

  private modelsOf(provider: string): ModelInfo[] {
    return this.runtime
      .getModels(provider)
      .filter((model) => model.input.includes("image"))
      .map((model) => ({ id: model.id, provider: model.provider, name: model.name, images: true }));
  }
}

/** The frozen prefix: the system prompt, then the memory snapshot. */
function systemPromptOf(request: OpenWindowRequest): string {
  const memory = request.prompt.memory.trim();
  return memory === "" ? request.prompt.system : `${request.prompt.system}\n\n${memory}`;
}
