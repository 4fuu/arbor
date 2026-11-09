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
} from "@4fu/arbor-interfaces";
import { textOf } from "@4fu/arbor-prompt";
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
   * pending items and agreements. The host knows what is open and names it; the
   * tool does not guess.
   *
   * A handoff the model wrote in another shape is refused rather than read as
   * none: dropping it would end the window with the work it carries lost
   * (docs/windows.md#ending-and-continuing). The window stays open, so the
   * model can call `end` again with the four fields this tool's description
   * names.
   */
  private async end(request: ToolCall, window: WindowRef): Promise<ToolResult> {
    const table = this.services.table;
    const handoff = handoffOf(request.args.handoff);
    if (request.args.handoff !== undefined && handoff === undefined) {
      // The core's error shape as a tool result: the rule, one line and the
      // next action, which here names the exact field names
      // (packages/errors, docs/prompting.md#rules-surface-where-they-bite).
      return refused("end.handoff.invalid", table, "end.handoff.invalid");
    }
    // A well-formed handoff with every part empty carries nothing, so it is no
    // handoff: the window ends as it would with the argument left out, and the
    // host still refuses with open work that has nothing to carry it.
    const empty =
      handoff !== undefined &&
      handoff.topics.length === 0 &&
      handoff.progress.length === 0 &&
      handoff.pending.length === 0 &&
      handoff.agreements.length === 0 &&
      handoff.refs.length === 0;
    const result = await this.services.endWindow(window, empty ? undefined : handoff);
    if (!result.ok) return { ...result, callId: request.callId };
    return { ...result, callId: request.callId, content: textOf(table, "result.ended", { window }) };
  }

  private async search(request: ToolCall, window: WindowRef): Promise<ToolResult> {
    const table = this.services.table;
    const query = stringArg(request.args, "query");
    const scope = stringArg(request.args, "scope");
    const wanted = scope === "" ? undefined : scope.split(",").map((part) => part.trim());
    const outcome = await this.services.search(window, query, wanted);
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
    // What was searched, how much there is, and how to reach the rest: a limit
    // that shapes a result without refusing is reported every time
    // (docs/prompting.md#rules-surface-where-they-bite).
    const more = outcome.total - lines.length;
    return {
      callId: request.callId,
      ok: true,
      content: [
        body,
        textOf(table, "result.search.total", { total: outcome.total }),
        textOf(table, "result.search.scope", { scope: outcome.scope.join("、") }),
        ...(more > 0 ? [textOf(table, "result.search.more", { count: more })] : []),
        outcome.nextCall,
      ].join("\n"),
    };
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

/**
 * The four parts of a handoff, each with its refs.
 *
 * The shape is exact because a handoff is the one thing a window carries into
 * the next one: the fields are `topics`, `progress`, `pending`, `agreements`
 * and the optional `refs`, each a string array. A value in any other shape -
 * a misspelled field, a string where an array belongs, or a required field
 * left out - answers `undefined`, and `end` refuses it instead of dropping it
 * (docs/windows.md#ending-and-continuing). A well-formed handoff whose parts
 * are all empty is returned as it stands; `end` reads it as no handoff,
 * because it carries nothing.
 */
export function handoffOf(value: unknown): Handoff | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const parts = (key: string): string[] | undefined => {
    const part = raw[key];
    if (!Array.isArray(part) || !part.every((item) => typeof item === "string")) return undefined;
    return [...part];
  };
  const topics = parts("topics");
  const progress = parts("progress");
  const pending = parts("pending");
  const agreements = parts("agreements");
  const refs = raw.refs === undefined ? ([] as Ref[]) : (parts("refs") as Ref[] | undefined);
  if (
    topics === undefined ||
    progress === undefined ||
    pending === undefined ||
    agreements === undefined ||
    refs === undefined
  ) {
    return undefined;
  }
  return { topics, progress, pending, agreements, refs };
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
