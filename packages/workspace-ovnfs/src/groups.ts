/**
 * The module functions the ovnfs workspace contributes (docs/workspaces.md).
 *
 * `checkout`, `list`, `diff`, `apply`, `rm` and `path` give the model the ovnfs
 * method without the CLI: open a checkout of a project subfolder, see its
 * changes, merge them back, remove it. The plain CLI works just as well - a
 * command run in `bash` reaches the same daemon - and a checkout opened or
 * applied through here is recorded in the journal, linked to the window.
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
  WindowRef,
} from "@4fu/arbor-interfaces";
import { textOf } from "@4fu/arbor-prompt";
import type { OvnfsWorkspace } from "./ovnfs.ts";

export class OvnfsWorkspaceGroup implements ToolGroup {
  readonly id = "workspace.ovnfs";

  private readonly workspace: OvnfsWorkspace;
  private readonly table: TextTable;

  constructor(workspace: OvnfsWorkspace, table: TextTable) {
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
            name: "workspace.checkout",
            signature: "workspace.checkout(name, dir?)",
            description: textOf(this.table, "function.workspace.checkout"),
          },
          {
            name: "workspace.list",
            signature: "workspace.list(window?)",
            description: textOf(this.table, "function.workspace.list"),
          },
          {
            name: "workspace.diff",
            signature: "workspace.diff(name)",
            description: textOf(this.table, "function.workspace.diff"),
          },
          {
            name: "workspace.apply",
            signature: "workspace.apply(name, branch?)",
            description: textOf(this.table, "function.workspace.apply"),
          },
          {
            name: "workspace.rm",
            signature: "workspace.rm(name)",
            description: textOf(this.table, "function.workspace.rm"),
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
      case "workspace.checkout":
        return this.checkout(request, context);
      case "workspace.list":
        return this.list(request, context);
      case "workspace.diff":
        return this.diff(request);
      case "workspace.apply":
        return this.apply(request, context);
      case "workspace.rm":
        return this.rm(request);
      case "workspace.path":
        return this.path(request);
      default:
        return this.notOwned(request);
    }
  }

  private async checkout(request: ToolCall, context: CallContext): Promise<ToolResult> {
    const name = stringArg(request.args, "name");
    // ovnfs accepts only lowercase letters, digits, ".", "_" and "-" in a name.
    if (!name.startsWith(`${context.window}-`) || !/^[a-z0-9._-]+$/.test(name)) {
      return this.refusal(request, "refused.workspace.name", { name });
    }
    const dir = stringArg(request.args, "dir");
    try {
      const path = await this.workspace.openCheckout(context.window, name, dir);
      return this.ok(request, textOf(this.table, "result.workspace.checkout", { name, path }));
    } catch (error) {
      return this.refusal(request, "refused.workspace.cli", { message: messageOf(error) });
    }
  }

  private async list(request: ToolCall, context: CallContext): Promise<ToolResult> {
    const window = windowArg(request.args.window) ?? context.window;
    const checkouts = await this.workspace.checkouts(window);
    if (checkouts.length === 0) {
      return this.ok(request, textOf(this.table, "result.workspace.list.empty", { window }));
    }
    const lines = checkouts
      .map((one) =>
        textOf(this.table, "result.workspace.list.line", {
          name: one.name,
          dirty: one.dirty ? "（未合回）" : "",
          path: one.path,
        }),
      )
      .join("\n");
    return this.ok(request, textOf(this.table, "result.workspace.list", { window, lines }));
  }

  private async diff(request: ToolCall): Promise<ToolResult> {
    const name = stringArg(request.args, "name");
    try {
      const reply = await this.workspace.diffCheckout(name);
      if (reply.changes.length === 0) {
        return this.ok(request, textOf(this.table, "result.workspace.diff.empty", { name }));
      }
      const changes = reply.changes.map((change) => `${change.status} ${change.path}`).join("\n");
      return this.ok(request, textOf(this.table, "result.workspace.diff", { name, changes }));
    } catch (error) {
      return this.refusal(request, "refused.workspace.cli", { message: messageOf(error) });
    }
  }

  private async apply(request: ToolCall, context: CallContext): Promise<ToolResult> {
    const name = stringArg(request.args, "name");
    const branch = stringArg(request.args, "branch") || undefined;
    try {
      const reply = await this.workspace.applyCheckout(context.window, name, branch);
      if (reply.conflicts.length > 0) {
        const conflicts = reply.conflicts
          .map((conflict) => `${conflict.path}（${conflict.reason}）`)
          .join("\n");
        return this.ok(request, textOf(this.table, "result.workspace.conflict", { name, conflicts }));
      }
      if (branch !== undefined) {
        return this.ok(
          request,
          textOf(this.table, "result.workspace.apply.branch", { name, branch, commit: reply.commit ?? "" }),
        );
      }
      return this.ok(
        request,
        textOf(this.table, "result.workspace.apply", {
          name,
          applied: reply.applied.length,
          merged: reply.merged.length,
        }),
      );
    } catch (error) {
      return this.refusal(request, "refused.workspace.cli", { message: messageOf(error) });
    }
  }

  private async rm(request: ToolCall): Promise<ToolResult> {
    const name = stringArg(request.args, "name");
    try {
      await this.workspace.removeCheckout(name);
      return this.ok(request, textOf(this.table, "result.workspace.rm", { name }));
    } catch (error) {
      return this.refusal(request, "refused.workspace.cli", { message: messageOf(error) });
    }
  }

  private async path(request: ToolCall): Promise<ToolResult> {
    const window = windowArg(request.args.window) ?? "c0";
    const checkouts = await this.workspace.checkouts(window);
    if (checkouts.length === 0) {
      return this.ok(request, textOf(this.table, "result.workspace.path.empty", { window }));
    }
    const lines = checkouts.map((one) => `${one.name} ${one.path}`).join("\n");
    return this.ok(request, textOf(this.table, "result.workspace.path", { window, lines }));
  }

  private ok(request: ToolCall, content: string): ToolResult {
    return { callId: request.callId, ok: true, content };
  }

  private refusal(request: ToolCall, key: string, args: Record<string, string | number>): ToolResult {
    return {
      callId: request.callId,
      ok: false,
      content: "",
      error: {
        rule: key,
        message: textOf(this.table, key, args, key),
        nextAction: textOf(this.table, key.replace("refused.", "next."), args) || undefined,
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
        message: textOf(this.table, "refused.unknown_function", {
          module: "workspace",
          name: request.name,
        }),
        nextAction: textOf(this.table, "next.unknown_function"),
      },
    };
  }
}

function stringArg(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  return typeof value === "string" ? value : "";
}

function windowArg(value: unknown): WindowRef | undefined {
  return typeof value === "string" && /^c\d+$/.test(value) ? (value as WindowRef) : undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
