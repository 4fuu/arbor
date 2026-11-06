/**
 * The environment modules: `env`, `services`, and one module per installed MCP
 * server (docs/tools.md#modules, docs/environment.md).
 *
 * A module whose backing feature is not configured is absent, so `env` and
 * `services` appear only when the host has an environment and a supervisor. A
 * capability is never a direct tool: an MCP server arrives as a module of its
 * own, declared with the functions it listed when it was validated, and reaches
 * a live window through an environment delta.
 */

import type {
  CallContext,
  EnvItem,
  TextTable,
  EnvItemRef,
  ModuleSpec,
  ToolCall,
  ToolGroup,
  ToolResult,
} from "@4fu/arbor-interfaces";
import { textOf } from "@4fu/arbor-prompt";
import type { ToolServices } from "../host.ts";
import { moduleSpec } from "../host.ts";

export class EnvModuleGroup implements ToolGroup {
  readonly id = "modules.env";

  private readonly services: ToolServices;

  constructor(services: ToolServices) {
    this.services = services;
  }

  tools(): readonly [] {
    return [];
  }

  /** The modules this group declares: `env`, `services` and every MCP server. */
  modules(): readonly ModuleSpec[] {
    if (this.services.environment === undefined) return [];
    const catalog = this.services.envCatalog();
    const table = this.services.table;
    const modules: ModuleSpec[] = [moduleSpec(table, "env", [
      { name: "env.list", signature: "env.list()" },
      { name: "env.history", signature: "env.history(item?)" },
    ])];
    if (this.services.supervisor !== undefined) {
      modules.push(
        moduleSpec(table, "services", [
          { name: "services.list", signature: "services.list()" },
          { name: "services.status", signature: "services.status(name)" },
          { name: "services.logs", signature: "services.logs(name, tail?)" },
        ]),
      );
    }
    for (const module of catalog.modules) modules.push(module);
    return modules;
  }

  async call(request: ToolCall, _context: CallContext): Promise<ToolResult> {
    if (this.services.environment === undefined) return this.absent(request);
    switch (request.name) {
      case "env.list":
        return this.list(request);
      case "env.history":
        return this.history(request);
      case "services.list":
        return this.services_(request);
      case "services.status":
        return this.status(request);
      case "services.logs":
        return this.logs(request);
      default:
        return this.server(request);
    }
  }

  /** `env.list`: the items and their revisions, one line each. */
  private async list(request: ToolCall): Promise<ToolResult> {
    const table = this.services.table;
    const items = (await this.services.environment?.list()) ?? [];
    const lines = items.map((item) => itemLine(item, table));
    return this.answer(request, lines);
  }

  /** `env.history(item?)`: one item's revisions, or the environment's. */
  private async history(request: ToolCall): Promise<ToolResult> {
    const table = this.services.table;
    const item = stringArg(request.args, "item");
    const revisions = (await this.services.environment?.history(item === "" ? undefined : (item as EnvItemRef))) ?? [];
    const lines = revisions.map((revision) =>
      textOf(table, "result.env.history", {
        ref: revision.ref,
        window: revision.window ?? "",
        time: revision.time,
        changes: revision.changes
          .map((change) => `${change.change === "added" ? "+" : change.change === "removed" ? "-" : "~"}${change.item.name}`)
          .join(", "),
      }),
    );
    return this.answer(request, lines);
  }

  /** `services.list`: the services and their state. */
  private async services_(request: ToolCall): Promise<ToolResult> {
    const table = this.services.table;
    const supervisor = this.services.supervisor;
    if (supervisor === undefined) return this.absent(request);
    const items = (await this.services.environment?.list()) ?? [];
    const lines: string[] = [];
    for (const item of items) {
      if (item.kind !== "service") continue;
      const status = await supervisor.status(item.name).catch(() => null);
      if (status === null) {
        lines.push(textOf(table, "result.services.item", { name: item.name, state: "stopped", revision: item.revision, restarts: 0 }));
        continue;
      }
      lines.push(
        textOf(table, "result.services.item", {
          name: status.name,
          state: status.state,
          revision: status.revision,
          restarts: status.restarts,
        }),
      );
    }
    return this.answer(request, lines);
  }

  /** `services.status(name)`: one service's real numbers. */
  private async status(request: ToolCall): Promise<ToolResult> {
    const table = this.services.table;
    const supervisor = this.services.supervisor;
    if (supervisor === undefined) return this.absent(request);
    const name = stringArg(request.args, "name");
    const found = await supervisor.status(name).catch(() => null);
    if (found === null) return this.missing(request, name);
    return this.answer(request, [
      textOf(table, "result.services.status", {
        name: found.name,
        state: found.state,
        revision: found.revision,
        ports: found.ports.join(", "),
        restarts: found.restarts,
        since: found.since,
      }),
      ...(found.lastError === undefined ? [] : [`${found.lastError.rule} ${found.lastError.message}`]),
      ...(found.refs.length === 0 ? [] : [textOf(table, "error.refs", { refs: found.refs.join(", ") })]),
    ]);
  }

  /** `services.logs(name)`: the tail of a service's own output. */
  private async logs(request: ToolCall): Promise<ToolResult> {
    const table = this.services.table;
    const supervisor = this.services.supervisor;
    if (supervisor === undefined) return this.absent(request);
    const name = stringArg(request.args, "name");
    const tail = numberArg(request.args, "tail");
    const page = await supervisor.logs(name, tail === undefined ? undefined : { tail }).catch(() => null);
    if (page === null) return this.missing(request, name);
    return this.answer(request, [
      textOf(table, "result.services.logs", { name: page.name, lines: page.total }),
      ...page.items,
    ]);
  }

  /**
   * One call into an MCP server: `weather.forecast({ city })` from a script.
   * A function a delta removed is refused with the ref of the change that
   * removed it, so the model knows where the answer is.
   */
  private async server(request: ToolCall): Promise<ToolResult> {
    const dot = request.name.indexOf(".");
    const server = dot === -1 ? "" : request.name.slice(0, dot);
    if (server === "") return this.notOwned(request);
    const catalog = this.services.envCatalog();
    if (!catalog.modules.some((module) => module.name === server)) return this.notOwned(request);
    try {
      const content = await this.services.callMcp(server, request.name, request.args);
      return { callId: request.callId, ok: true, content };
    } catch (error: unknown) {
      const info = error as { rule?: string; message?: string; nextAction?: string };
      return {
        callId: request.callId,
        ok: false,
        content: "",
        error: {
          rule: info.rule ?? "mcp.call.failed",
          message: info.message ?? String(error),
          ...(info.nextAction === undefined ? {} : { nextAction: info.nextAction }),
        },
      };
    }
  }

  /** One environment item's line: its ref, its name and its description. */
  private answer(request: ToolCall, lines: readonly string[]): ToolResult {
    const table = this.services.table;
    const body = lines.length === 0 ? textOf(table, "result.search.empty") : lines.join("\n");
    const total = textOf(table, "result.search.total", { total: lines.length });
    return { callId: request.callId, ok: true, content: `${body}\n${total}` };
  }

  private missing(request: ToolCall, name: string): ToolResult {
    return {
      callId: request.callId,
      ok: false,
      content: "",
      error: {
        rule: "service.notfound",
        message: textOf(this.services.table, "refused.service.notfound", { name }),
        nextAction: textOf(this.services.table, "next.service.notfound"),
      },
    };
  }

  private absent(request: ToolCall): ToolResult {
    return {
      callId: request.callId,
      ok: false,
      content: "",
      error: {
        rule: "env.absent",
        message: textOf(this.services.table, "refused.env.absent"),
        nextAction: textOf(this.services.table, "next.env.absent"),
      },
    };
  }

  private notOwned(request: ToolCall): ToolResult {
    return {
      callId: request.callId,
      ok: false,
      content: "",
      error: {
        rule: "module.function.unknown",
        message: textOf(this.services.table, "refused.unknown_function", { module: "env", name: request.name }),
        nextAction: textOf(this.services.table, "next.unknown_function"),
      },
    };
  }
}

/** One item's line, in the shape `<env>` uses, so a list reads like the prompt. */
function itemLine(item: EnvItem, table: TextTable): string {
  return textOf(table, "result.env.item", {
    ref: item.ref,
    name: item.name,
    description: item.description,
  });
}

function stringArg(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  return typeof value === "string" ? value : "";
}

function numberArg(args: Record<string, unknown>, name: string): number | undefined {
  const value = args[name];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
