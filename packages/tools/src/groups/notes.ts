/**
 * The note tools: `note_write`, `note_replace`, `note_delete`
 * (docs/tools.md#direct-tools, docs/memory.md).
 *
 * Writing memory is a decision, so it is a direct call. A write names the
 * revision it read; a stale one is refused with what changed since, and the
 * model merges and writes again. The host records where the write happened -
 * window, event, evidence, range - and the model never fills an anchor in.
 */

import type {
  DirectToolSpec,
  NoteStore,
  NoteWriteInput,
  ToolCall,
  ToolGroup,
  ToolResult,
  WindowRef,
} from "@arbor/interfaces";
import { textOf } from "@arbor/prompt";
import { toolSpec, type ToolServices } from "../host.ts";

export class NoteToolGroup implements ToolGroup {
  readonly id = "notes";

  private readonly services: ToolServices;

  constructor(services: ToolServices) {
    this.services = services;
  }

  tools(): readonly DirectToolSpec[] {
    if (this.services.notes === undefined) return [];
    const table = this.services.table;
    return [
      toolSpec(table, "note_write", {
        title: { type: "string", required: true },
        summary: { type: "string" },
        body: { type: "string", required: true },
      }),
      toolSpec(table, "note_replace", {
        id: { type: "string", required: true },
        revision: { type: "number", required: true },
        title: { type: "string" },
        summary: { type: "string" },
        body: { type: "string", required: true },
      }),
      toolSpec(table, "note_delete", {
        id: { type: "string", required: true },
        revision: { type: "number", required: true },
      }),
    ];
  }

  modules(): readonly [] {
    return [];
  }

  async call(request: ToolCall, context: { window: WindowRef }): Promise<ToolResult> {
    const store = this.store();
    if (store === undefined) return this.absent(request);
    switch (request.name) {
      case "note_write":
        return this.write(request, store, context.window);
      case "note_replace":
        return this.replace(request, store, context.window);
      case "note_delete":
        return this.remove(request, store, context.window);
      default:
        return this.notOwned(request);
    }
  }

  private async write(request: ToolCall, store: NoteStore, window: WindowRef): Promise<ToolResult> {
    const title = stringArg(request.args, "title");
    const body = stringArg(request.args, "body");
    if (title === "" || body === "") return this.refusal(request, "note.write.empty");
    return this.record(request, store, window, {
      title,
      body,
      ...(stringArg(request.args, "summary") === "" ? {} : { summary: stringArg(request.args, "summary") }),
    });
  }

  private async replace(request: ToolCall, store: NoteStore, window: WindowRef): Promise<ToolResult> {
    const id = stringArg(request.args, "id");
    const revision = numberArg(request.args, "revision");
    const body = stringArg(request.args, "body");
    if (id === "" || body === "") return this.refusal(request, "note.write.empty");
    return this.record(request, store, window, {
      id: id as NoteWriteInput["id"],
      title: stringArg(request.args, "title"),
      body,
      replace: true,
      expectedRevision: revision,
      ...(stringArg(request.args, "summary") === "" ? {} : { summary: stringArg(request.args, "summary") }),
    });
  }

  private async remove(request: ToolCall, store: NoteStore, window: WindowRef): Promise<ToolResult> {
    const id = stringArg(request.args, "id");
    if (id === "") return this.refusal(request, "note.write.empty");
    return this.record(request, store, window, {
      id: id as NoteWriteInput["id"],
      title: "",
      body: "",
      delete: true,
      expectedRevision: numberArg(request.args, "revision"),
    });
  }

  /**
   * One write, with the anchor the host fills in. A refused write changes
   * nothing; the answer carries the rule, the next action and the revisions
   * that changed since the one the writer read.
   */
  private async record(
    request: ToolCall,
    _store: NoteStore,
    window: WindowRef,
    input: NoteWriteInput,
  ): Promise<ToolResult> {
    try {
      const note = await this.services.writeNote(window, input);
      return this.answer(request, note.ref, this.services.table);
    } catch (error: unknown) {
      return this.refusalOf(request, error);
    }
  }

  private answer(request: ToolCall, ref: string, table: import("@arbor/interfaces").TextTable): ToolResult {
    return { callId: request.callId, ok: true, content: textOf(table, "result.note_written", { ref }) };
  }

  /** One refusal the note store returned, in the core's error shape. */
  private refusalOf(request: ToolCall, error: unknown): ToolResult {
    const table = this.services.table;
    const info = error as { rule?: string; message?: string; nextAction?: string; details?: { revisions?: readonly { ref: string; revision: number; window: string | null }[] } };
    const revisions = info.details?.revisions ?? [];
    const lines = [info.message ?? String(error)];
    if (info.nextAction !== undefined) lines.push(`${textOf(table, "error.next", {})}${info.nextAction}`.trim());
    for (const revision of revisions) {
      lines.push(`${revision.ref} ${revision.window ?? ""}`);
    }
    return {
      callId: request.callId,
      ok: false,
      content: "",
      error: {
        rule: info.rule ?? "note.write.failed",
        message: lines.join("\n"),
        ...(info.nextAction === undefined ? {} : { nextAction: info.nextAction }),
      },
    };
  }

  private refusal(request: ToolCall, rule: string): ToolResult {
    const table = this.services.table;
    return {
      callId: request.callId,
      ok: false,
      content: "",
      error: {
        rule,
        message: textOf(table, `refused.${rule}`, {}, rule),
        nextAction: textOf(table, `next.${rule}`) || undefined,
      },
    };
  }

  private absent(request: ToolCall): ToolResult {
    const table = this.services.table;
    return {
      callId: request.callId,
      ok: false,
      content: "",
      error: {
        rule: "notes.absent",
        message: textOf(table, "refused.notes.absent"),
        nextAction: textOf(table, "next.notes.absent"),
      },
    };
  }

  private notOwned(request: ToolCall): ToolResult {
    return this.refusal(request, "unknown_tool");
  }

  private store(): NoteStore | undefined {
    return this.services.notes;
  }
}

function stringArg(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  return typeof value === "string" ? value : "";
}

function numberArg(args: Record<string, unknown>, name: string): number | undefined {
  const value = args[name];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

