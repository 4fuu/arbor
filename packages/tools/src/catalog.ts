/**
 * The one tool catalog: every direct tool and every code mode module, and the
 * two paths that reach the service layer (docs/tools.md).
 *
 * A direct tool and a code mode function are thin wrappers of one service call:
 * same arguments, same behaviour, same errors. `tool_search` and `tool_describe`
 * read this catalog, so the lookup and the prompt never disagree. `code_exec`
 * runs a script against it and refuses a script that names a direct tool.
 */

import type {
  CallContext,
  DirectToolSpec,
  EnvItem,
  FunctionSpec,
  ModuleSpec,
  TextTable,
  ToolCall,
  ToolGroup,
  ToolResult,
} from "@4fu/arbor-interfaces";
import { textOf } from "@4fu/arbor-prompt";
import { directToolIn, runScript, type CodeExecContext, type ScriptCatalog } from "./code-exec.ts";
import type { ToolServices } from "./host.ts";
import { boundResult } from "./bound.ts";
import { CoreToolGroup } from "./groups/core.ts";
import { EnvToolGroup } from "./groups/env.ts";
import { FileToolGroup } from "./groups/files.ts";
import { NoteToolGroup } from "./groups/notes.ts";
import {
  BoardModuleGroup,
  ChannelsModuleGroup,
  EnvModuleGroup,
  JournalModuleGroup,
  NotesModuleGroup,
  ScheduleModuleGroup,
  TasksModuleGroup,
  WindowsModuleGroup,
  WorkspaceModuleGroup,
} from "./modules/modules.ts";

export interface ToolCatalogOptions {
  services: ToolServices;
  /** Extra groups, from a plugin. */
  groups?: readonly ToolGroup[];
}

/** What one `tool_search` answers: names, and the items a name belongs to. */
export interface SearchAnswer {
  modules: readonly string[];
  functions: readonly string[];
  skills: readonly EnvItem[];
  tools: readonly DirectToolSpec[];
}

/** How many names one `tool_search` answer lists before it says there are more. */
export const SEARCH_CAP = 20;

export class ToolCatalog implements ToolGroup, ScriptCatalog {
  readonly id = "catalog";

  private readonly services: ToolServices;
  private readonly groups: readonly ToolGroup[];

  constructor(options: ToolCatalogOptions) {
    this.services = options.services;
    this.groups = [
      new CoreToolGroup(options.services),
      new FileToolGroup(options.services),
      new NoteToolGroup(options.services),
      new JournalModuleGroup(options.services),
      new WindowsModuleGroup(options.services),
      new BoardModuleGroup(options.services),
      new NotesModuleGroup(options.services),
      new ChannelsModuleGroup(options.services),
      new TasksModuleGroup(options.services),
      new ScheduleModuleGroup(options.services),
      new WorkspaceModuleGroup(options.services),
      new EnvToolGroup(options.services),
      new EnvModuleGroup(options.services),
      // What the workspace implementation contributes: a capability the core
      // does not name, such as showing another window's directory.
      ...(options.services.workspace?.groups?.(options.services.table) ?? []),
      ...(options.groups ?? []),
    ];
  }

  /** Every direct tool, one line each in the prompt. */
  tools(): readonly DirectToolSpec[] {
    const table = this.services.table;
    const entryPoints: DirectToolSpec[] = [
      {
        name: "code_exec",
        description: lookup(table, "tool.code_exec", {}),
        parameters: { script: { type: "string", description: lookup(table, "param.script", {}), required: true } },
      },
      {
        name: "tool_search",
        description: lookup(table, "tool.tool_search", {}),
        parameters: { keywords: { type: "string", description: lookup(table, "param.keywords", {}) } },
      },
    ];
    return [...entryPoints, ...this.groups.flatMap((group) => group.tools())];
  }

  /**
   * Every module, one line each in the prompt. A name is declared once: every
   * group that declares it lists its functions together, so a group that adds a
   * function to a module the core already declares - an implementation's own
   * capability, or an MCP server named after a built-in module - adds no second
   * line for it.
   */
  modules(): readonly ModuleSpec[] {
    const merged = new Map<string, ModuleSpec>();
    for (const module of this.groups.flatMap((group) => group.modules())) {
      const found = merged.get(module.name);
      if (found === undefined) {
        merged.set(module.name, module);
        continue;
      }
      const declared = new Set(found.functions.map((fn) => fn.name));
      merged.set(module.name, {
        ...found,
        functions: [...found.functions, ...module.functions.filter((fn) => !declared.has(fn.name))],
      });
    }
    return [...merged.values()];
  }

  /** Every function the modules declare. */
  functions(): readonly FunctionSpec[] {
    return this.modules().flatMap((module) => module.functions);
  }

  /** The direct tool names, which a script may not call. */
  directTools(): readonly string[] {
    return this.tools().map((tool) => tool.name);
  }

  /** One call, through the group that owns it. */
  async call(request: ToolCall, context: CallContext): Promise<ToolResult> {
    const result = this.named(request, await this.route(request, context));
    // The one exit every direct call leaves by: one head-and-tail cut, for
    // every tool, with the whole kept in the workspace
    // (docs/prompting.md#information-density).
    if (!result.ok) return result;
    return {
      ...result,
      content: await boundResult(result.content, {
        ...(context.workspace === undefined ? {} : { workspace: context.workspace.path }),
        ...(context.call === undefined ? {} : { callId: context.call }),
        table: this.services.table,
      }),
    };
  }

  /** One `module.function` call from a script: the same path as a direct call. */
  async callModule(name: string, args: Record<string, unknown>, context: CodeExecContext): Promise<ToolResult> {
    // No cut here: the script reads the whole answer and cuts what it returns.
    return this.named({ name, args, callId: context.call ?? "script" }, await this.route({
      name,
      args,
      callId: context.call ?? "script",
    }, { window: context.window }));
  }

  /**
   * The call itself: the removal check, the two entry points, then the group
   * that owns the name. A name no group owns is refused, because the prompt
   * promises `tool_search` answers it (docs/tools.md#rules).
   */
  private async route(request: ToolCall, context: CallContext): Promise<ToolResult> {
    // A removal never changes a prompt, but a call into what it removed is
    // refused with the ref of the change that removed it
    // (docs/environment.md#deltas-in-a-window).
    const removed = this.services.environment === undefined
      ? undefined
      : this.services.envCatalog().removed.find((one) => one.name === request.name);
    if (removed !== undefined) {
      return {
        callId: request.callId,
        ok: false,
        content: "",
        error: {
          rule: "env.removed",
          message: textOf(this.services.table, "refused.env.removed", { name: request.name, ref: removed.ref }),
          nextAction: textOf(this.services.table, "next.env.removed"),
        },
      };
    }
    if (request.name === "code_exec") {
      return this.codeExec(stringArg(request.args, "script"), {
        window: context.window,
        ...(context.task === undefined ? {} : { task: context.task }),
        ...(context.workspace === undefined ? {} : { workspace: context.workspace.path }),
        ...(context.envRevision === undefined ? {} : { envRevision: context.envRevision }),
        ...(context.call === undefined ? {} : { call: context.call }),
      });
    }
    if (request.name === "tool_search") return this.toolSearch(request);
    const owner = this.groups.find((group) =>
      group.tools().some((tool) => tool.name === request.name) ||
      group.modules().some((module) => module.functions.some((fn) => fn.name === request.name)),
    );
    if (owner === undefined) {
      return {
        callId: request.callId,
        ok: false,
        content: "",
        error: {
          rule: "tool.unknown",
          message: textOf(this.services.table, "refused.unknown_tool", { name: request.name }),
          nextAction: textOf(this.services.table, "next.unknown_tool"),
        },
      };
    }
    return owner.call(request, context);
  }

  /** The result as it leaves: the tool that was called, and the call's own id. */
  private named(request: ToolCall, result: ToolResult): ToolResult {
    return {
      ...result,
      callId: result.callId === "" ? request.callId : result.callId,
      tool: result.tool ?? request.name,
    };
  }

  /**
   * `tool_search`: keywords, an exact `module.function` or tool name, or
   * nothing. An exact module name answers with that module's functions, a
   * direct tool answers with its description, and a skill's name or keywords
   * answer with its path and how to read it
   * (docs/environment.md#using-a-skill-or-a-server). A name is matched exactly
   * first, then by prefix, then by description.
   */
  search(keywords?: string): SearchAnswer {
    const modules = this.modules();
    const functions = this.functions();
    const tools = this.tools();
    const skills = this.services.environment === undefined ? [] : this.services.envCatalog().items.filter((item) => item.kind === "skill");
    if (keywords === undefined || keywords.trim() === "") {
      return { modules: modules.map((module) => module.name), functions: [], skills, tools: [] };
    }
    const wanted = keywords.trim();
    const named = modules.filter((module) => module.name === wanted);
    if (wanted.includes(".")) {
      return {
        modules: named.map((module) => module.name),
        functions: functions.filter((fn) => fn.name === wanted).map((fn) => fn.name),
        skills: [],
        tools: tools.filter((tool) => tool.name === wanted),
      };
    }
    const rankedFunctions = ranked(wanted, functions, (fn) => [shortName(fn.name), fn.description]);
    return {
      modules: ranked(wanted, modules, (module) => [module.name, module.description]).map((module) => module.name),
      // A server's name answers with its functions, not only the module's line;
      // any other keyword answers with the functions whose own name or
      // description holds it.
      functions: (named.length === 0
        ? rankedFunctions
        : functions.filter((fn) => named.some((module) => module.functions.includes(fn)))
      ).map((fn) => fn.name),
      skills: ranked(wanted, skills, (skill) => [skill.name, skill.description]),
      tools: ranked(wanted, tools, (tool) => [tool.name, tool.description]),
    };
  }

  /** `tool_describe`: one function's signature and description. */
  describe(name: string): string | undefined {
    const found = this.functions().find((fn) => fn.name === name);
    return found === undefined ? undefined : `${found.signature} - ${found.description}`;
  }

  /** `code_exec`: run one script against this catalog. */
  async codeExec(script: string, context: CodeExecContext): Promise<ToolResult> {
    return runScript(script, this, this.services, context);
  }

  /** `tool_search` as a direct call: one block per name it answers. */
  private toolSearch(request: ToolCall): ToolResult {
    const table = this.services.table;
    const keywords = stringArg(request.args, "keywords");
    const found = this.search(keywords === "" ? undefined : keywords);
    const lines: string[] = [textOf(table, "result.tool_search.lead")];
    if (found.modules.length > 0) {
      lines.push(textOf(table, "result.tool_search.modules", { names: found.modules.join(", ") }));
    }
    for (const tool of found.tools) {
      lines.push(textOf(table, "result.tool_search.tool", { name: tool.name, description: tool.description }));
    }
    for (const name of found.functions) {
      lines.push(this.describe(name) ?? name);
    }
    // A skill is used by reading it, so the answer names its path.
    for (const skill of found.skills) {
      if (skill.path === undefined) continue;
      lines.push(textOf(table, "result.tool_search.skill", { name: skill.name, description: skill.description, path: skill.path }));
    }
    const listed = found.modules.length + found.tools.length + found.functions.length + found.skills.length;
    if (listed === 0) {
      lines.push(textOf(table, "result.tool_search.none"));
    } else {
      // A module the answer names with no function to call is said out loud,
      // so the model does not go looking for one.
      if (found.modules.length > 0 && found.functions.length === 0 && found.tools.length === 0 && found.skills.length === 0) {
        lines.push(textOf(table, "result.tool_search.none_functions"));
      }
      if (listed > SEARCH_CAP) {
        lines.push(textOf(table, "result.tool_search.more", { count: listed - SEARCH_CAP }));
      }
    }
    lines.push(textOf(table, "result.tool_search.hint"));
    return { callId: request.callId, ok: true, content: lines.join("\n") };
  }

  /** The guard a script goes through, exposed for tests. */
  decisionIn(script: string): string | undefined {
    return directToolIn(script, this.directTools());
  }
}

function stringArg(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  return typeof value === "string" ? value : "";
}

/**
 * The matches, strongest first: an exact name, then a name that starts with
 * the query, then a description that holds it. Ties keep the order the catalog
 * declares them in, so the answer is deterministic.
 */
function ranked<T>(
  wanted: string,
  items: readonly T[],
  keys: (item: T) => readonly [string, string],
): T[] {
  const found: { rank: number; item: T }[] = [];
  for (const item of items) {
    const [name, description] = keys(item);
    if (name === wanted) found.push({ rank: 0, item });
    else if (name.startsWith(wanted)) found.push({ rank: 1, item });
    else if (description.includes(wanted)) found.push({ rank: 2, item });
  }
  return found.sort((left, right) => left.rank - right.rank).map((one) => one.item);
}

/** A function's own name, without the `module.` the catalog declares it with. */
function shortName(name: string): string {
  const dot = name.indexOf(".");
  return dot === -1 ? name : name.slice(dot + 1);
}

function lookup(table: TextTable, key: string, args: Record<string, string | number>): string {
  const template = table[key];
  if (template === undefined) return "";
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = args[name];
    return value === undefined ? match : String(value);
  });
}
