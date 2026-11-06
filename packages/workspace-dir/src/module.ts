/**
 * The module functions the plain-directory workspace contributes
 * (docs/workspaces.md#persistent-directories).
 *
 * `keep` and `keeps` give the model the persistent directories: a named place
 * whose content outlives the window that made it, the retention period and a
 * host restart, which a later window finds by name. `path` answers another
 * window's own directory, by its window. The core knows nothing about either:
 * a window reaches a persistent directory through these, through `journal`, or
 * plainly by its path - `mkdir -p <root>/keep/<name>` makes the same directory.
 *
 * Every result and refusal is one text-table entry naming the rule and the next
 * action. These functions live in the `workspace` module beside the core's
 * `grep`, `find` and `ls`.
 */

import type {
  CallContext,
  ModuleSpec,
  TextTable,
  ToolCall,
  ToolGroup,
  ToolResult,
} from "@4fu/arbor-interfaces";
import { textOf } from "@4fu/arbor-prompt";
import type { DirectoryWorkspace } from "./directory-workspace.ts";

/** `workspace.keep`, `workspace.keeps` and `workspace.path`. */
export class WorkspaceDirGroup implements ToolGroup {
  readonly id = "workspace.dir";

  private readonly workspace: DirectoryWorkspace;
  private readonly table: TextTable;

  constructor(workspace: DirectoryWorkspace, table: TextTable) {
    this.workspace = workspace;
    this.table = table;
  }

  tools(): readonly [] {
    return [];
  }

  modules(): readonly ModuleSpec[] {
    return [
      {
        name: "workspace",
        description: textOf(this.table, "module.workspace"),
        functions: [
          {
            name: "workspace.keep",
            signature: "workspace.keep(name)",
            description: textOf(this.table, "function.workspace.keep"),
          },
          {
            name: "workspace.keeps",
            signature: "workspace.keeps()",
            description: textOf(this.table, "function.workspace.keeps"),
          },
          {
            name: "workspace.path",
            signature: "workspace.path(window)",
            description: textOf(this.table, "function.workspace.path"),
          },
        ],
      },
    ];
  }

  async call(request: ToolCall, context: CallContext): Promise<ToolResult> {
    switch (request.name) {
      case "workspace.keep":
        return this.keep(request, context);
      case "workspace.keeps":
        return this.keeps(request);
      case "workspace.path":
        return this.path(request);
      default:
        return this.notOwned(request);
    }
  }

  private async keep(request: ToolCall, context: CallContext): Promise<ToolResult> {
    const name = stringArg(request.args, "name");
    try {
      const path = await this.workspace.keep(context.window, name);
      return this.ok(request, textOf(this.table, "result.workspace.keep", { name, path }));
    } catch (error) {
      return this.refusalOf(request, error);
    }
  }

  private async keeps(request: ToolCall): Promise<ToolResult> {
    const keeps = await this.workspace.keeps();
    if (keeps.length === 0) {
      return this.ok(request, textOf(this.table, "result.workspace.keeps.empty"));
    }
    const lines = keeps
      .map((keep) => textOf(this.table, "result.workspace.keeps.line", { name: keep.name, path: keep.path }))
      .join("\n");
    return this.ok(request, textOf(this.table, "result.workspace.keeps", { lines }));
  }

  private async path(request: ToolCall): Promise<ToolResult> {
    const window = windowArg(request.args.window) as `c${number}`;
    const path = await this.workspace.pathOfWindow(window);
    if (path === undefined) {
      return {
        callId: request.callId,
        ok: false,
        content: "",
        error: {
          rule: "workspace.not_found",
          message: textOf(this.table, "refused.workspace.path", { window }),
          nextAction: textOf(this.table, "next.workspace.path"),
        },
      };
    }
    return {
      callId: request.callId,
      ok: true,
      content: textOf(this.table, "result.workspace.path", { window, path }),
    };
  }

  private ok(request: ToolCall, content: string): ToolResult {
    return { callId: request.callId, ok: true, content };
  }

  /**
   * One refusal the workspace answered with, in the core's error shape. The rule
   * names the table entry that carries its wording, exactly the way a note
   * store's refusal reaches the model.
   */
  private refusalOf(request: ToolCall, error: unknown): ToolResult {
    const info = error as { rule?: string; message?: string; nextAction?: string };
    return {
      callId: request.callId,
      ok: false,
      content: "",
      error: {
        rule: info.rule ?? "workspace.keep.failed",
        message: info.message ?? String(error),
        ...(info.nextAction === undefined ? {} : { nextAction: info.nextAction }),
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
        message: textOf(this.table, "refused.unknown_function", { module: "workspace", name: request.name }),
        nextAction: textOf(this.table, "next.unknown_function"),
      },
    };
  }
}

function stringArg(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  return typeof value === "string" ? value : "";
}

/** The window an argument names, or `c0` when it names none. */
function windowArg(value: unknown): string {
  return typeof value === "string" && /^c\d+$/.test(value) ? value : "c0";
}
