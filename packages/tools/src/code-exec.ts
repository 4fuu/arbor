/**
 * `code_exec`: everything that is not a decision runs from a script
 * (docs/tools.md#rules).
 *
 * A script that names a direct tool is refused with the rule and never reaches
 * the host. Calls from a script go through the same hooks as direct calls, so
 * anchors, watermarks, quotas, validation and logging behave the same: every
 * module function is the same service call the direct tool makes.
 *
 * Two lookups are script globals: `tool_search` takes keywords, an exact
 * `module.function` name, or nothing for every module; `tool_describe` returns
 * one signature. Both read the catalog frozen with the window plus the
 * environment deltas since.
 */

import vm from "node:vm";
import type { ModuleSpec, ToolResult, WindowRef } from "@arbor/interfaces";
import { textOf } from "@arbor/prompt";
import { boundResult } from "./bound.ts";
import type { ToolServices } from "./host.ts";

/** How long one script may run before it is stopped. */
const SCRIPT_TIMEOUT_MS = 60000;

export interface CodeExecContext {
  window: WindowRef;
  workspace?: string;
  task?: string;
  envRevision?: string;
  /** The event the `code_exec` call itself is recorded at. */
  call?: string;
}

/** The catalog a script calls through. */
export interface ScriptCatalog {
  modules(): readonly ModuleSpec[];
  /** Run one `module.function` call, the same path a direct call takes. */
  callModule(name: string, args: Record<string, unknown>, context: CodeExecContext): Promise<ToolResult>;
  /** `tool_search`: keywords, an exact name, or nothing for every module. */
  search(keywords?: string): { modules: readonly string[]; functions: readonly string[] };
  /** `tool_describe`: one function's signature. */
  describe(name: string): string | undefined;
  /** The direct tool names a script may not call. */
  directTools(): readonly string[];
}

/** Run one script in its own context, with the modules as globals. */
export async function runScript(
  script: string,
  catalog: ScriptCatalog,
  services: ToolServices,
  context: CodeExecContext,
): Promise<ToolResult> {
  const table = services.table;
  const named = directToolIn(script, catalog.directTools());
  if (named !== undefined) {
    return {
      callId: "",
      ok: false,
      content: "",
      error: {
        rule: "script.decision_tool",
        message: textOf(table, "refused.decision_in_script", { name: named }),
        nextAction: textOf(table, "next.decision_in_script"),
      },
    };
  }
  const globals: Record<string, unknown> = {
    tool_search: (keywords?: string) => catalog.search(keywords),
    tool_describe: (name: string) => catalog.describe(name),
    console: { log: () => {}, error: () => {} },
  };
  for (const module of catalog.modules()) {
    globals[module.name] = moduleFunctions(module, catalog, context);
  }
  const sandbox = vm.createContext(globals);
  const wrapped = `(async () => {\n${script}\n})()`;
  let value: unknown;
  try {
    const compiled = new vm.Script(wrapped, { filename: "code_exec.js" });
    value = await compiled.runInContext(sandbox, { timeout: SCRIPT_TIMEOUT_MS });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      callId: "",
      ok: false,
      content: "",
      error: {
        rule: "script.failed",
        message: textOf(table, "refused.script_failed", { message }),
        nextAction: textOf(table, "next.script_failed"),
      },
    };
  }
  const text = value === undefined ? "" : typeof value === "string" ? value : JSON.stringify(value);
  return {
    callId: "",
    ok: true,
    content: await boundResult(text ?? "", {
      workspace: context.workspace,
      callId: context.call,
      table,
    }),
  };
}

/** One module's functions, as the globals a script calls. */
function moduleFunctions(
  module: ModuleSpec,
  catalog: ScriptCatalog,
  context: CodeExecContext,
): Record<string, unknown> {
  const functions: Record<string, unknown> = {};
  for (const spec of module.functions) {
    functions[spec.name.slice(module.name.length + 1)] = async (args: Record<string, unknown> = {}) => {
      const result = await catalog.callModule(spec.name, args, context);
      if (!result.ok) throw new Error(result.error?.message ?? result.content);
      return result.content;
    };
  }
  return functions;
}

/**
 * The direct tool a script names, if any. This is a guard, not a sandbox: it
 * keeps a decision out of a script, and the host still enforces every rule.
 */
export function directToolIn(script: string, tools: readonly string[]): string | undefined {
  for (const tool of tools) {
    const pattern = new RegExp(`(^|[^\\w.$])${tool.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\(`);
    if (pattern.test(script)) return tool;
  }
  return undefined;
}

export { SCRIPT_TIMEOUT_MS };
export type { WindowRef };
