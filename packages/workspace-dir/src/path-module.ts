/**
 * The capability the built-in directory workspace contributes: another
 * window's directory, by its window (docs/workspaces.md).
 *
 * The core knows nothing about it. A window reads another window's directory
 * through `read`, by the path this answers, and both the description and the
 * result say the directory belongs to another window and must not be modified.
 * Nothing here enforces that, because the built-in workspace isolates by
 * directory only: another window's directory is a path on the same host, which
 * a command may name. It is not a security boundary, and real isolation comes
 * from an implementation that owns its execution environment.
 */

import type { ModuleSpec, TextTable, ToolCall, ToolGroup, ToolResult } from "@arbor/interfaces";
import { textOf } from "@arbor/prompt";
import type { DirectoryWorkspace } from "./directory-workspace.ts";

/** `workspace.path`: the directory of a window's workspace, by its window. */
export class WorkspacePathGroup implements ToolGroup {
  readonly id = "workspace.path";

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
            name: "workspace.path",
            signature: "workspace.path(window)",
            description: textOf(this.table, "function.workspace.path"),
          },
        ],
      },
    ];
  }

  async call(request: ToolCall): Promise<ToolResult> {
    if (request.name !== "workspace.path") return this.notOwned(request);
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

/** The window an argument names, or `c0` when it names none. */
function windowArg(value: unknown): string {
  return typeof value === "string" && /^c\d+$/.test(value) ? value : "c0";
}
