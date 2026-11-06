/**
 * A minimal MCP client over stdio: one server process, newline-delimited
 * JSON-RPC 2.0 (docs/environment.md#using-a-skill-or-a-server).
 *
 * arbor needs three things from a server - start it, list its functions, call
 * one - so this is the whole protocol it speaks: `initialize`,
 * `notifications/initialized`, `tools/list` and `tools/call`. A server that
 * answers those is usable; anything else an MCP server can do stays with the
 * model, which reads and reinstalls the server like any environment item.
 *
 * A secret is named by the configuration and its value comes from the host, so
 * a server never holds one and none is written anywhere.
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import { arborError } from "@4fu/arbor-errors";
import type { FunctionSpec } from "@4fu/arbor-interfaces";
import { childEnvironment } from "@4fu/arbor-tools";

/** The MCP protocol version this client speaks. */
const PROTOCOL_VERSION = "2024-11-05";

/** How long one request waits for an answer. */
const DEFAULT_TIMEOUT_MS = 20000;

export interface StdioServerOptions {
  /** The item's name, which the module and its functions are named after. */
  name: string;
  /** The directory the command runs in: the item's own directory. */
  dir: string;
  command: string;
  args?: readonly string[];
  env?: Record<string, string>;
  /** The names of the secrets it uses; their values come from `secretOf`. */
  secrets?: readonly string[];
  /** Where a secret's value comes from. A configuration names one, never holds it. */
  secretOf?: (name: string) => string | undefined;
  timeoutMs?: number;
}

/** One function a server lists, in the shape the catalog declares. */
export interface ServerFunction {
  name: string;
  description: string;
  signature: string;
}

export class StdioMcpServer {
  private readonly options: StdioServerOptions;
  private readonly timeoutMs: number;
  private readonly child: ReturnType<typeof spawn>;
  private readonly lines: ReturnType<typeof createInterface>;
  private readonly stderr: string[] = [];
  private nextId = 1;
  private readonly waiting = new Map<number, { resolve: (value: unknown) => void; reject: (error: unknown) => void }>();
  private closed = false;

  private constructor(options: StdioServerOptions) {
    this.options = options;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const secrets: Record<string, string> = {};
    for (const name of options.secrets ?? []) {
      const value = options.secretOf?.(name);
      if (value !== undefined && value !== "") secrets[name] = value;
    }
    this.child = spawn(options.command, [...(options.args ?? [])], {
      cwd: options.dir,
      // A server gets the host's environment, its own directory, its own `env`
      // and the secrets it names (docs/environment.md#what-a-subprocess-gets).
      env: childEnvironment({ workspace: options.dir, env: options.env, secrets }),
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stderr?.on("data", (chunk: Buffer) => {
      this.stderr.push(chunk.toString("utf8"));
      if (this.stderr.length > 50) this.stderr.shift();
    });
    this.child.on("error", (error: Error) => this.failAll(error));
    this.child.on("exit", (code) => this.failAll(new Error(`the server exited with code ${code ?? "null"}`)));
    this.lines = createInterface({ input: this.child.stdout as Readable });
    this.lines.on("line", (line) => this.answer(line));
  }

  /** Start a server and complete the MCP handshake. */
  static async start(options: StdioServerOptions): Promise<StdioMcpServer> {
    const server = new StdioMcpServer(options);
    try {
      await server.request("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "arbor", version: "0.0.0" },
      });
      server.notify("notifications/initialized", {});
      return server;
    } catch (error: unknown) {
      await server.close();
      throw error;
    }
  }

  /** The functions this server lists, in the shape the catalog declares. */
  async functions(): Promise<readonly FunctionSpec[]> {
    const result = (await this.request("tools/list", {})) as { tools?: unknown };
    const tools = Array.isArray(result.tools) ? (result.tools as unknown[]) : [];
    return tools.map((tool) => this.functionOf(tool));
  }

  /** Call one function and answer with its text. */
  async call(fn: string, args: Record<string, unknown>): Promise<string> {
    const name = fn.startsWith(`${this.options.name}.`) ? fn.slice(this.options.name.length + 1) : fn;
    const result = (await this.request("tools/call", { name, arguments: args })) as {
      content?: unknown;
      isError?: boolean;
    };
    if (result.isError === true) {
      throw arborError({
        code: "refused",
        rule: "mcp.call.failed",
        message: `${this.options.name}.${name} 调用失败`,
        nextAction: "检查参数后用 tool_describe 核对签名，再调用一次。",
        details: { server: this.options.name, function: name },
      });
    }
    const content = Array.isArray(result.content) ? (result.content as unknown[]) : [];
    return content
      .map((part) => {
        const block = part as { type?: string; text?: string };
        return block.type === "text" ? (block.text ?? "") : "";
      })
      .filter((text) => text !== "")
      .join("\n");
  }

  /** Stop the server. A stopped server is started again on the next call. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.lines.close();
    this.child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      if (this.child.exitCode !== null || this.child.signalCode !== null) {
        resolve();
        return;
      }
      this.child.once("exit", () => resolve());
      setTimeout(() => {
        this.child.kill("SIGKILL");
        resolve();
      }, 2000).unref();
    });
  }

  private functionOf(tool: unknown): FunctionSpec {
    const spec = tool as { name?: string; description?: string; inputSchema?: { properties?: Record<string, unknown>; required?: unknown } };
    const name = spec.name ?? "";
    const properties = spec.inputSchema?.properties ?? {};
    const required = new Set(
      Array.isArray(spec.inputSchema?.required) ? (spec.inputSchema?.required as string[]) : [],
    );
    const parameters = Object.keys(properties).map((key) => `${key}${required.has(key) ? "" : "?"}`);
    return {
      name: `${this.options.name}.${name}`,
      signature: `${this.options.name}.${name}(${parameters.join(", ")})`,
      description: spec.description ?? "",
    };
  }

  private notify(method: string, params: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  private async request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId;
    this.nextId += 1;
    const answer = new Promise<unknown>((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(
          arborError({
            code: "unavailable",
            rule: "mcp.server.timeout",
            message: `MCP 服务器 ${this.options.name} 没有在 ${this.timeoutMs} ms 内回答 ${method}`,
            nextAction: "检查服务器是否卡住；修好后用 reload 重新安装它。",
            details: { server: this.options.name, method },
          }),
        );
      }, this.timeoutMs);
      timer.unref();
    });
    this.send({ jsonrpc: "2.0", id, method, params });
    return answer;
  }

  private send(message: Record<string, unknown>): void {
    if (this.closed || this.child.stdin?.destroyed === true) {
      throw arborError({
        code: "unavailable",
        rule: "mcp.server.closed",
        message: `MCP 服务器 ${this.options.name} 已停止`,
        nextAction: "用 reload 重新安装该服务器。",
        details: { server: this.options.name },
      });
    }
    this.child.stdin?.write(`${JSON.stringify(message)}\n`);
  }

  private answer(line: string): void {
    if (line.trim() === "") return;
    let message: { id?: number; result?: unknown; error?: { message?: string } };
    try {
      message = JSON.parse(line) as typeof message;
    } catch {
      return;
    }
    const pending = message.id === undefined ? undefined : this.waiting.get(message.id);
    if (pending === undefined) return;
    this.waiting.delete(message.id as number);
    if (message.error !== undefined) {
      pending.reject(
        arborError({
          code: "refused",
          rule: "mcp.server.error",
          message: `MCP 服务器 ${this.options.name}：${message.error.message ?? "未知错误"}`,
          nextAction: "按错误修正服务器或参数后重试。",
          details: { server: this.options.name },
        }),
      );
      return;
    }
    pending.resolve(message.result);
  }

  /** A server that died leaves no request hanging. */
  private failAll(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const [, pending] of this.waiting) {
      pending.reject(
        arborError({
          code: "unavailable",
          rule: "mcp.server.died",
          message: `MCP 服务器 ${this.options.name} 已退出：${error.message}`,
          nextAction: "查看服务器输出，修好后用 reload 重新安装。",
          details: { server: this.options.name, stderr: this.stderr.join("") },
        }),
      );
    }
    this.waiting.clear();
  }
}
