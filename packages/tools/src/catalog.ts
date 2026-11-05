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
} from "@arbor/interfaces";
import { textOf } from "@arbor/prompt";
import { directToolIn, runScript, type CodeExecContext, type ScriptCatalog } from "./code-exec.ts";
import type { ToolServices } from "./host.ts";
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
   * Every module, one line each in the prompt. A name is declared once: an MCP
   * server named after a built-in module does not add a second line for it.
   */
  modules(): readonly ModuleSpec[] {
    const seen = new Set<string>();
    const modules: ModuleSpec[] = [];
    for (const module of this.groups.flatMap((group) => group.modules())) {
      if (seen.has(module.name)) continue;
      seen.add(module.name);
      modules.push(module);
    }
    return modules;
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

  /** One `module.function` call from a script: the same path as a direct call. */
  async callModule(name: string, args: Record<string, unknown>, context: CodeExecContext): Promise<ToolResult> {
    return this.call({ name, args, callId: context.call ?? "script" }, { window: context.window });
  }

  /**
   * `tool_search`: keywords, an exact `module.function`, or nothing. An exact
   * module name answers with that module's functions, and a skill's name or
   * keywords answer with its path and how to read it
   * (docs/environment.md#using-a-skill-or-a-server).
   */
  search(keywords?: string): { modules: readonly string[]; functions: readonly string[]; skills: readonly EnvItem[] } {
    const modules = this.modules();
    const functions = this.functions();
    const skills = this.services.environment === undefined ? [] : this.services.envCatalog().items.filter((item) => item.kind === "skill");
    if (keywords === undefined || keywords.trim() === "") {
      return { modules: modules.map((module) => module.name), functions: [], skills };
    }
    const wanted = keywords.trim();
    const named = modules.filter((module) => module.name === wanted);
    if (wanted.includes(".")) {
      const found = functions.filter((fn) => fn.name === wanted);
      return { modules: named.map((module) => module.name), functions: found.map((fn) => fn.name), skills: [] };
    }
    return {
      modules: modules
        .filter((module) => module.name.includes(wanted) || module.description.includes(wanted))
        .map((module) => module.name),
      // A server's name answers with its functions, not only the module's line.
      functions: functions
        .filter(
          (fn) =>
            fn.name.includes(wanted) ||
            fn.description.includes(wanted) ||
            named.some((module) => module.functions.includes(fn)),
        )
        .map((fn) => fn.name),
      skills: skills.filter((skill) => skill.name.includes(wanted) || skill.description.includes(wanted)),
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
    const lines: string[] = [];
    if (found.modules.length > 0) {
      lines.push(textOf(table, "result.tool_search.modules", { names: found.modules.join(", ") }));
    }
    for (const name of found.functions) {
      lines.push(this.describe(name) ?? name);
    }
    // A skill is used by reading it, so the answer names its path.
    for (const skill of found.skills) {
      if (skill.path === undefined) continue;
      lines.push(textOf(table, "result.tool_search.skill", { name: skill.name, description: skill.description, path: skill.path }));
    }
    return {
      callId: request.callId,
      ok: true,
      content: lines.length === 0 ? textOf(table, "result.tool_search.none") : lines.join("\n"),
    };
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

function lookup(table: TextTable, key: string, args: Record<string, string | number>): string {
  const template = table[key];
  if (template === undefined) return "";
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = args[name];
    return value === undefined ? match : String(value);
  });
}
