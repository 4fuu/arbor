/**
 * The environment tools: `reload` (docs/tools.md#direct-tools,
 * docs/environment.md#changing-the-environment).
 *
 * Changing the environment is a decision, so it is one direct call. The three
 * steps a model takes - copy, edit, `reload` - are the model's; the host's are
 * validation, the revision check, replacing the item as a whole, recording an
 * environment revision and broadcasting the delta to every live window.
 *
 * Every rule lives in the refusal the model meets, and every refusal names the
 * section of the built-in skill that covers it, so the loop closes without a
 * rule written into the prompt.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  CallContext,
  DirectToolSpec,
  EnvDraft,
  EnvItemKind,
  EnvItemName,
  EnvItemRef,
  ToolCall,
  ToolGroup,
  ToolResult,
  WindowRef,
  WorkspaceMount,
} from "@arbor/interfaces";
import { textOf } from "@arbor/prompt";
import type { ReloadOutcome, ToolServices } from "../host.ts";
import { refused, toolSpec } from "../host.ts";

export class EnvToolGroup implements ToolGroup {
  readonly id = "env";

  private readonly services: ToolServices;

  constructor(services: ToolServices) {
    this.services = services;
  }

  tools(): readonly DirectToolSpec[] {
    if (this.services.environment === undefined) return [];
    const table = this.services.table;
    return [
      toolSpec(table, "reload", {
        install: { type: "array" },
        remove: { type: "array" },
      }),
    ];
  }

  modules(): readonly [] {
    return [];
  }

  async call(request: ToolCall, context: CallContext): Promise<ToolResult> {
    if (this.services.environment === undefined) return this.absent();
    switch (request.name) {
      case "reload":
        return this.reload(request, context.window, context.workspace);
      default:
        return this.notOwned(request);
    }
  }

  /**
   * `reload(install?, remove?)`. `install` names drafts in the window's
   * workspace; `remove` names items. Both are optional, but not both empty.
   */
  private async reload(request: ToolCall, window: WindowRef, workspace?: WorkspaceMount): Promise<ToolResult> {
    const table = this.services.table;
    const install = listArg(request.args, "install");
    const remove = stringsArg(request.args, "remove");
    if (install.length === 0 && remove.length === 0) return this.refusal(request, "empty");

    if (workspace === undefined && install.length > 0) {
      return this.refusal(request, "workspace");
    }
    const drafts: EnvDraft[] = [];
    for (const entry of install) {
      const draft = await this.draftOf(entry, workspace as WorkspaceMount);
      if (typeof draft === "string") return this.refusal(request, "draft", { path: pathOf(entry) });
      drafts.push(draft.draft);
    }
    let outcome: ReloadOutcome;
    try {
      outcome = await this.services.reload(window, { drafts, remove: remove as readonly (EnvItemRef | EnvItemName)[] });
    } catch (error: unknown) {
      return this.refusalOf(request, error);
    }
    const lines = [textOf(table, "result.env.revision", { revision: outcome.revision })];
    for (const change of outcome.changes) {
      lines.push(
        textOf(table, "result.env.change", {
          change: change.change === "added" ? "+" : change.change === "removed" ? "-" : "~",
          kind: change.item.kind,
          name: change.item.name,
          description: change.item.description,
        }),
      );
    }
    if (outcome.delivered > 0) {
      lines.push(textOf(table, "result.env.delivered", { count: outcome.delivered }));
    }
    return { callId: request.callId, ok: true, content: lines.join("\n") };
  }

  /**
   * One draft: its kind is read off the workspace - a directory with a SKILL.md
   * is a skill, one with a `svc.json` a service, a `.json` file an MCP server
   * or the settings - and its name is the directory's or the file's.
   */
  private async draftOf(
    entry: unknown,
    workspace: WorkspaceMount,
  ): Promise<{ draft: EnvDraft } | string> {
    const path = typeof entry === "string" ? entry : stringField(entry, "path");
    if (path === "") return "env.empty";
    const copiedFrom = typeof entry === "string" ? undefined : numberField(entry, "copiedFrom");
    const name = baseName(path);
    const draft = { name, path, ...(copiedFrom === undefined ? {} : { copiedFrom }) };
    // The kind is read off the workspace: a directory with a SKILL.md is a skill,
    // one with a `svc.json` a service, one with `<name>.json` an MCP server that
    // brought its own code, and a `.json` file an MCP server or the settings.
    const skill = await this.readDraft(workspace, join(path, "SKILL.md"));
    if (skill !== null) return { draft: { ...draft, kind: "skill" } };
    const service = await this.readDraft(workspace, join(path, "svc.json"));
    if (service !== null) return { draft: { ...draft, kind: "service" } };
    if (path.endsWith(".json")) {
      if (name === "settings" && (await this.readDraft(workspace, path)) === null) return "env.draft";
      const kind: EnvItemKind = name === "settings" ? "settings" : "mcp";
      return { draft: { ...draft, kind } };
    }
    const server = await this.readDraft(workspace, join(path, `${name}.json`));
    if (server !== null) return { draft: { ...draft, kind: "mcp" } };
    return "env.draft";
  }

  /** One file of a draft, through the mount's own capability or the host path. */
  private async readDraft(workspace: WorkspaceMount, path: string): Promise<string | null> {
    if (workspace.readFile !== undefined) return workspace.readFile(path).catch(() => null);
    return readFile(join(workspace.path, path), "utf8").catch(() => null);
  }

  /** One refusal about the call itself, before the service layer saw it. */
  private refusal(
    _request: ToolCall,
    key: "empty" | "workspace" | "draft",
    args: Record<string, string | number> = {},
  ): ToolResult {
    return refused(`env.${key}`, this.services.table, `env.${key}`, args);
  }

  /**
   * One refusal the service layer returned, in the core's error shape. It names
   * the rule and the section of the built-in skill that covers it.
   */
  private refusalOf(request: ToolCall, error: unknown): ToolResult {
    const info = error as { rule?: string; message?: string; nextAction?: string };
    const next = info.nextAction ?? textOf(this.services.table, "next.env.draft");
    return {
      callId: request.callId,
      ok: false,
      content: "",
      error: {
        rule: info.rule ?? "env.draft",
        message: info.message ?? String(error),
        nextAction: `${next}`,
      },
    };
  }

  private absent(): ToolResult {
    return refused("env.absent", this.services.table, "env.absent");
  }


  private notOwned(request: ToolCall): ToolResult {
    return refused("tool.not_owned", this.services.table, "unknown_tool", { name: request.name });
  }
}

/** The last segment of a draft's path, which is the item's name. */
function baseName(path: string): string {
  const clean = path.replace(/\/+$/, "");
  const name = clean.slice(clean.lastIndexOf("/") + 1);
  return name.endsWith(".json") ? name.slice(0, -".json".length) : name;
}

/** What the model gave for one draft, as a path. */
function pathOf(entry: unknown): string {
  if (typeof entry === "string") return entry;
  return stringField(entry, "path");
}

function listArg(args: Record<string, unknown>, name: string): unknown[] {
  const value = args[name];
  return Array.isArray(value) ? value : value === undefined ? [] : [value];
}

/** One list of strings, as `remove` names items. */
function stringsArg(args: Record<string, unknown>, name: string): string[] {
  const value = args[name];
  if (!Array.isArray(value)) return value === undefined ? [] : [String(value)];
  return value.filter((item): item is string => typeof item === "string");
}

function stringField(value: unknown, key: string): string {
  if (typeof value !== "object" || value === null) return "";
  const found = (value as Record<string, unknown>)[key];
  return typeof found === "string" ? found : "";
}

function numberField(value: unknown, key: string): number | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const found = (value as Record<string, unknown>)[key];
  return typeof found === "number" && Number.isFinite(found) ? found : undefined;
}
