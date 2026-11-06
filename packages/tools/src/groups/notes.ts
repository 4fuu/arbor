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
  Ref,
  ToolCall,
  ToolGroup,
  ToolResult,
  WindowRef,
} from "@4fu/arbor-interfaces";
import { textOf } from "@4fu/arbor-prompt";
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
        refs: { type: "refs" },
      }),
      toolSpec(table, "note_replace", {
        id: { type: "string", required: true },
        revision: { type: "number", required: true },
        title: { type: "string" },
        summary: { type: "string" },
        body: { type: "string", required: true },
        refs: { type: "refs" },
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
    // Every rule a write has to meet lives in the store, which answers in the
    // core's error shape; the group adds nothing of its own.
    const refs = refsArg(request.args, "refs");
    return this.record(request, store, window, {
      title: stringArg(request.args, "title"),
      body: stringArg(request.args, "body"),
      ...(stringArg(request.args, "summary") === "" ? {} : { summary: stringArg(request.args, "summary") }),
      ...(refs.length === 0 ? {} : { refs }),
    });
  }

  private async replace(request: ToolCall, store: NoteStore, window: WindowRef): Promise<ToolResult> {
    const refs = refsArg(request.args, "refs");
    return this.record(request, store, window, {
      id: stringArg(request.args, "id") as NoteWriteInput["id"],
      title: stringArg(request.args, "title"),
      body: stringArg(request.args, "body"),
      replace: true,
      expectedRevision: numberArg(request.args, "revision"),
      ...(stringArg(request.args, "summary") === "" ? {} : { summary: stringArg(request.args, "summary") }),
      ...(refs.length === 0 ? {} : { refs }),
    });
  }

  private async remove(request: ToolCall, store: NoteStore, window: WindowRef): Promise<ToolResult> {
    return this.record(request, store, window, {
      id: stringArg(request.args, "id") as NoteWriteInput["id"],
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
    store: NoteStore,
    window: WindowRef,
    input: NoteWriteInput,
  ): Promise<ToolResult> {
    try {
      const note = await this.services.writeNote(window, input);
      return this.answer(request, note.ref, store);
    } catch (error: unknown) {
      return this.refusalOf(request, error);
    }
  }

  /**
   * One write's answer, with the active set's budget beside it: the budget is
   * part of every prefix, so a window that writes hears how full it is
   * (docs/memory.md#the-active-set).
   */
  private async answer(request: ToolCall, ref: string, store: NoteStore): Promise<ToolResult> {
    const table = this.services.table;
    const snapshot = await store.snapshot().catch(() => null);
    return {
      callId: request.callId,
      ok: true,
      content: [
        textOf(table, "result.note_written", { ref }),
        ...(snapshot === null
          ? []
          : [
              textOf(table, "result.note.budget", {
                used: snapshot.tokens,
                hard: snapshot.budget.tokens,
                left: Math.max(0, snapshot.budget.count - snapshot.total),
              }),
            ]),
      ].join("\n"),
    };
  }

  /** One refusal the note store returned, in the core's error shape. */
  private refusalOf(request: ToolCall, error: unknown): ToolResult {
    const table = this.services.table;
    const info = error as { rule?: string; message?: string; nextAction?: string; details?: { revisions?: readonly { ref: string; revision: number; window: string | null }[] } };
    const revisions = info.details?.revisions ?? [];
    const lines = [info.message ?? String(error)];
    if (info.nextAction !== undefined) {
      lines.push(textOf(table, "error.next", { next: info.nextAction }));
    }
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

/** The refs a write names, so the store can link them to the note. */
function refsArg(args: Record<string, unknown>, name: string): Ref[] {
  const value = args[name];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is Ref => typeof item === "string");
}
