/**
 * The decision tools: `send`, `end` and `search`
 * (docs/tools.md#direct-tools, docs/prompting.md#rules-surface-where-they-bite).
 *
 * Anything that speaks, ends a window or writes memory is a direct call. The
 * one guard rule stated up front is `end` with unfinished work, because the
 * handoff is the cost of the decision to end; every other rule lives in the
 * refusal the model meets.
 */

import type {
  CallContext,
  DirectToolSpec,
  Handoff,
  Ref,
  ToolCall,
  ToolGroup,
  ToolResult,
  WindowRef,
} from "@arbor/interfaces";
import { textOf } from "@arbor/prompt";
import type { ToolServices } from "../host.ts";
import { refused, toolSpec } from "../host.ts";

export class CoreToolGroup implements ToolGroup {
  readonly id = "core";

  private readonly services: ToolServices;

  constructor(services: ToolServices) {
    this.services = services;
  }

  tools(): readonly DirectToolSpec[] {
    const table = this.services.table;
    return [
      toolSpec(table, "send", {
        to: { type: "string", required: true },
        content: { type: "string", required: true },
        reply_to: { type: "ref" },
        cites: { type: "refs" },
      }),
      toolSpec(table, "end", { handoff: { type: "object" } }),
      toolSpec(table, "search", {
        query: { type: "string", required: true },
        scope: { type: "string" },
      }),
    ];
  }

  modules(): readonly [] {
    return [];
  }

  async call(request: ToolCall, context: CallContext): Promise<ToolResult> {
    switch (request.name) {
      case "send":
        return this.send(request, context.window);
      case "end":
        return this.end(request, context.window);
      case "search":
        return this.search(request, context.window);
      default:
        return this.notOwned(request);
    }
  }

  private async send(request: ToolCall, window: WindowRef): Promise<ToolResult> {
    const table = this.services.table;
    const to = stringArg(request.args, "to");
    const content = stringArg(request.args, "content");
    if (to === "") return refused("send.target.empty", table, "send.target");
    if (content === "") return refused("send.content.empty", table, "send.content");
    const outcome = await this.services.send(window, {
      to,
      content,
      ...(stringArg(request.args, "reply_to") === "" ? {} : { replyTo: stringArg(request.args, "reply_to") }),
      ...(refsArg(request.args, "cites").length === 0 ? {} : { cites: refsArg(request.args, "cites") }),
    });
    const lines = [textOf(table, "result.sent", { ref: outcome.event })];
    if (outcome.behind > 0) {
      lines.push(textOf(table, "result.send.behind", { count: outcome.behind }));
    }
    return { callId: request.callId, ok: true, content: lines.join("\n") };
  }

  /**
   * `end` with unfinished work needs a handoff: current topics, progress,
   * pending items and agreements. The host knows whether work is open; the
   * tool does not guess.
   */
  private async end(request: ToolCall, window: WindowRef): Promise<ToolResult> {
    const table = this.services.table;
    const handoff = handoffOf(request.args.handoff);
    if (handoff === undefined && (await this.services.hasOpenWork(window))) {
      return refused("end.handoff.required", table, "end.no_handoff");
    }
    const result = await this.services.endWindow(window, handoff);
    return {
      ...result,
      callId: request.callId,
      content: textOf(table, "result.ended", { window }),
    };
  }

  private async search(request: ToolCall, window: WindowRef): Promise<ToolResult> {
    const table = this.services.table;
    const query = stringArg(request.args, "query");
    const scope = stringArg(request.args, "scope");
    const outcome = await this.services.search(
      window,
      query,
      scope === "" ? undefined : scope.split(",").map((part) => part.trim()),
    );
    const lines: string[] = [];
    for (const hit of outcome.hits) {
      lines.push(`${hit.ref} ${hit.kind} ${hit.summary}`);
    }
    for (const note of outcome.notes) {
      lines.push(`${note.ref} ${note.title}：${note.summary}`);
    }
    for (const live of outcome.windows) {
      lines.push(`${live.window} ${live.doing}`);
    }
    const body = lines.length === 0 ? textOf(table, "result.search.empty") : lines.join("\n");
    const total = textOf(table, "result.search.total", { total: outcome.total });
    return { callId: request.callId, ok: true, content: `${body}\n${total}\n${outcome.nextCall}` };
  }

  private notOwned(request: ToolCall): ToolResult {
    return {
      callId: request.callId,
      ok: false,
      content: "",
      error: {
        rule: "tool.not_owned",
        message: textOf(this.services.table, "refused.unknown_tool", { name: request.name }),
        nextAction: textOf(this.services.table, "next.unknown_tool"),
      },
    };
  }
}

/** The four parts of a handoff, each with its refs. */
export function handoffOf(value: unknown): Handoff | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  const parts = (key: string): string[] =>
    Array.isArray(raw[key]) ? raw[key].filter((item): item is string => typeof item === "string") : [];
  const refs = Array.isArray(raw.refs) ? raw.refs.filter((item): item is Ref => typeof item === "string") : [];
  const handoff: Handoff = {
    topics: parts("topics"),
    progress: parts("progress"),
    pending: parts("pending"),
    agreements: parts("agreements"),
    refs,
  };
  const empty =
    handoff.topics.length === 0 &&
    handoff.progress.length === 0 &&
    handoff.pending.length === 0 &&
    handoff.agreements.length === 0;
  return empty ? undefined : handoff;
}

function stringArg(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  return typeof value === "string" ? value : "";
}

function refsArg(args: Record<string, unknown>, name: string): Ref[] {
  const value = args[name];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is Ref => typeof item === "string");
}
