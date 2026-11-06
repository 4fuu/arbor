/**
 * The code mode modules: `journal`, `windows`, `board`, `notes`, `channels`
 * and `workspace` (docs/tools.md#modules).
 *
 * A module whose backing feature is not configured is absent. The prompt names
 * a module, never a function; how to call one comes from `tool_search` and
 * `tool_describe`, which read the same catalog the window was opened with.
 * `env`, `services` and the MCP servers' own modules are in `./env.ts`.
 */

import { readdir, readFile } from "node:fs/promises";
import { isAbsolute, join, normalize, resolve, sep } from "node:path";
import type {
  Block,
  CallContext,
  Channel,
  ExternalRef,
  WorkspaceMount,
  Event,
  EventRef,
  Journal,
  ModuleSpec,
  NoteRef,
  Page,
  Ref,
  ScheduledTaskInput,
  ScheduledTaskUpdate,
  SkipPeriod,
  Target,
  TaskInput,
  TaskRef,
  ToolCall,
  ToolGroup,
  ToolResult,
  WindowRef,
} from "@arbor/interfaces";
import { formatTime, textOf } from "@arbor/prompt";
import type { LiveWindow, TaskSummary, ToolServices } from "../host.ts";
import { moduleSpec, refused } from "../host.ts";
import { envCommand } from "../env-stage.ts";

/** `journal`: search, show, around, trace, links. */
export class JournalModuleGroup implements ToolGroup {
  readonly id = "modules.journal";

  private readonly services: ToolServices;

  constructor(services: ToolServices) {
    this.services = services;
  }

  tools(): readonly [] {
    return [];
  }

  modules(): readonly ModuleSpec[] {
    return [
      moduleSpec(this.services.table, "journal", [
        { name: "journal.search", signature: "journal.search(query, options?)" },
        { name: "journal.show", signature: "journal.show(ref)" },
        { name: "journal.around", signature: "journal.around(ref, before?, after?)" },
        { name: "journal.trace", signature: "journal.trace(ref)" },
        { name: "journal.links", signature: "journal.links(ref, offset?)" },
      ]),
    ];
  }

  async call(request: ToolCall, _context: CallContext): Promise<ToolResult> {
    const journal: Journal = this.services.journal;
    const args = request.args;
    switch (request.name) {
      case "journal.search": {
        const page = await journal.search(stringArg(args, "query"), {
          ...(numberArg(args, "limit") === undefined ? {} : { limit: numberArg(args, "limit") }),
        });
        return this.answer(request, page.items.map((hit) => `${hit.ref} ${hit.kind} ${hit.summary}`), page);
      }
      case "journal.show": {
        const refs = eventRefsArg(args, "ref");
        const events = await journal.getMany(refs);
        return this.answer(request, events.map((event) => `${event.ref} ${event.kind} ${bodyOf(event)}`), {
          items: events,
          total: events.length,
          limit: events.length,
          nextCall: "journal.show(ref)",
        });
      }
      case "journal.around": {
        const events = await journal.around(eventRefsArg(args, "ref")[0] ?? ("r0" as EventRef), {
          ...(numberArg(args, "before") === undefined ? {} : { before: numberArg(args, "before") }),
          ...(numberArg(args, "after") === undefined ? {} : { after: numberArg(args, "after") }),
        });
        return this.answer(request, events.map((event) => `${event.ref} ${event.kind} ${bodyOf(event)}`), {
          items: events,
          total: events.length,
          limit: events.length,
          nextCall: "journal.around(ref)",
        });
      }
      case "journal.trace": {
        const node = await journal.trace(refArg(args, "ref"));
        return this.answer(request, [traceText(node, 0)], {
          items: [node.ref],
          total: 1,
          limit: 1,
          nextCall: "journal.trace(ref)",
        });
      }
      case "journal.links": {
        const page = await journal.links(refArg(args, "ref"), {
          ...(numberArg(args, "offset") === undefined ? {} : { offset: numberArg(args, "offset") }),
        });
        return this.answer(
          request,
          page.items.map((item) => `${item.ref} ${item.kind} ${item.summary}`),
          page,
        );
      }
      default:
        return this.notOwned(request);
    }
  }

  private answer(request: ToolCall, lines: readonly string[], page: Page<unknown>): ToolResult {
    const table = this.services.table;
    const body = lines.length === 0 ? textOf(table, "result.search.empty") : lines.join("\n");
    return {
      callId: request.callId,
      ok: true,
      content: `${body}\n${textOf(table, "result.search.total", { total: page.total })}\n${page.nextCall}`,
    };
  }

  private notOwned(request: ToolCall): ToolResult {
    return {
      callId: request.callId,
      ok: false,
      content: "",
      error: {
        rule: "module.function.unknown",
        message: textOf(this.services.table, "refused.unknown_function", {
          module: request.name.split(".")[0] ?? "",
          name: request.name,
        }),
        nextAction: textOf(this.services.table, "next.unknown_function"),
      },
    };
  }
}

/** `windows`: list, show, send, broadcast, inbox. */
export class WindowsModuleGroup implements ToolGroup {
  readonly id = "modules.windows";

  private readonly services: ToolServices;

  constructor(services: ToolServices) {
    this.services = services;
  }

  tools(): readonly [] {
    return [];
  }

  modules(): readonly ModuleSpec[] {
    return [
      moduleSpec(this.services.table, "windows", [
        { name: "windows.list", signature: "windows.list()" },
        { name: "windows.show", signature: "windows.show(c…)" },
        { name: "windows.send", signature: "windows.send(to, text, reply_to?)" },
        { name: "windows.broadcast", signature: "windows.broadcast(text)" },
        { name: "windows.inbox", signature: "windows.inbox()" },
      ]),
    ];
  }

  async call(request: ToolCall, context: CallContext): Promise<ToolResult> {
    const table = this.services.table;
    const args = request.args;
    switch (request.name) {
      case "windows.list": {
        const windows = await this.services.windows();
        const lines = windows.map(
          (live) => `${live.window} ${live.state} ${live.doing} ${live.usage.used}/${live.usage.limit}`,
        );
        return {
          callId: request.callId,
          ok: true,
          content: lines.length === 0 ? textOf(table, "result.search.empty") : lines.join("\n"),
        };
      }
      case "windows.show": {
        const events = await this.services.windowTranscript(windowArg(args, "window"));
        const lines = events.map((event) => `${event.ref} ${event.kind} ${bodyOf(event)}`);
        return {
          callId: request.callId,
          ok: true,
          content: lines.length === 0 ? textOf(table, "result.search.empty") : lines.join("\n"),
        };
      }
      case "windows.send": {
        const to = windowArg(args, "to");
        try {
          const event = await this.services.windowMessage(
            context.window,
            to,
            stringArg(args, "text"),
            stringArg(args, "reply_to") === "" ? undefined : (stringArg(args, "reply_to") as Ref),
          );
          return { callId: request.callId, ok: true, content: textOf(table, "result.window_message", { ref: event, window: to }) };
        } catch (error) {
          // A message to an ended window, or one past the hop limit, is refused
          // in the core's error shape, so the model reads the rule and the next
          // action like any other refusal.
          return refusedOf(request, error);
        }
      }
      case "windows.broadcast": {
        const count = await this.services.broadcast(context.window, stringArg(args, "text"));
        return {
          callId: request.callId,
          ok: true,
          content: textOf(table, "result.broadcast.count", { count }),
        };
      }
      case "windows.inbox": {
        const messages = await this.services.inbox(context.window);
        const lines = messages.map((message) => `${message.ref} ${message.from} ${message.text}`);
        return {
          callId: request.callId,
          ok: true,
          content: lines.length === 0 ? textOf(table, "result.search.empty") : lines.join("\n"),
        };
      }
      default:
        return this.notOwned(request);
    }
  }

  private notOwned(request: ToolCall): ToolResult {
    return {
      callId: request.callId,
      ok: false,
      content: "",
      error: {
        rule: "module.function.unknown",
        message: textOf(this.services.table, "refused.unknown_function", {
          module: "windows",
          name: request.name,
        }),
        nextAction: textOf(this.services.table, "next.unknown_function"),
      },
    };
  }
}

/** `board`: list, set, expect, unexpect. */
export class BoardModuleGroup implements ToolGroup {
  readonly id = "modules.board";

  private readonly services: ToolServices;

  constructor(services: ToolServices) {
    this.services = services;
  }

  tools(): readonly [] {
    return [];
  }

  modules(): readonly ModuleSpec[] {
    return [
      moduleSpec(this.services.table, "board", [
        { name: "board.list", signature: "board.list()" },
        { name: "board.set", signature: "board.set(line)" },
        { name: "board.expect", signature: "board.expect(item? | description?)" },
        { name: "board.unexpect", signature: "board.unexpect(ref)" },
      ]),
    ];
  }

  async call(request: ToolCall, context: CallContext): Promise<ToolResult> {
    const table = this.services.table;
    const args = request.args;
    switch (request.name) {
      case "board.list": {
        const page = await this.services.board();
        const lines = page.items.map(
          (line) => `${line.window} ${line.state} ${line.doing} ${line.targets.join(",")}`,
        );
        return {
          callId: request.callId,
          ok: true,
          content: lines.length === 0 ? textOf(table, "result.search.empty") : lines.join("\n"),
        };
      }
      case "board.set":
        await this.services.setBoardLine(context.window, stringArg(args, "line"));
        return { callId: request.callId, ok: true, content: textOf(table, "result.board.set") };
      case "board.expect": {
        const item = stringArg(args, "item");
        const description = stringArg(args, "description");
        const expectation = await this.services.expect(
          context.window,
          item === "" ? undefined : item,
          description === "" ? undefined : description,
        );
        return { callId: request.callId, ok: true, content: expectation.ref };
      }
      case "board.unexpect":
        await this.services.unexpect(context.window, refArg(args, "ref"));
        return { callId: request.callId, ok: true, content: textOf(table, "result.board.unexpect") };
      default:
        return this.notOwned(request);
    }
  }

  private notOwned(request: ToolCall): ToolResult {
    return {
      callId: request.callId,
      ok: false,
      content: "",
      error: {
        rule: "module.function.unknown",
        message: textOf(this.services.table, "refused.unknown_function", { module: "board", name: request.name }),
        nextAction: textOf(this.services.table, "next.unknown_function"),
      },
    };
  }
}

/** `notes`: search, read, context, active. Absent without a `NoteStore`. */
export class NotesModuleGroup implements ToolGroup {
  readonly id = "modules.notes";

  private readonly services: ToolServices;

  constructor(services: ToolServices) {
    this.services = services;
  }

  tools(): readonly [] {
    return [];
  }

  modules(): readonly ModuleSpec[] {
    if (this.services.notes === undefined) return [];
    return [
      moduleSpec(this.services.table, "notes", [
        { name: "notes.search", signature: "notes.search(query?, status?, about?, linked?)" },
        { name: "notes.read", signature: "notes.read(ref)" },
        { name: "notes.context", signature: "notes.context(ref)" },
        { name: "notes.active", signature: "notes.active()" },
      ]),
    ];
  }

  async call(request: ToolCall, _context: CallContext): Promise<ToolResult> {
    const store = this.services.notes;
    if (store === undefined) {
      return {
        callId: request.callId,
        ok: false,
        content: "",
        error: {
          rule: "notes.absent",
          message: textOf(this.services.table, "refused.notes.absent"),
          nextAction: textOf(this.services.table, "next.notes.absent"),
        },
      };
    }
    const args = request.args;
    switch (request.name) {
      case "notes.search": {
        const page = await store.search({
          ...(stringArg(args, "query") === "" ? {} : { query: stringArg(args, "query") }),
          ...(stringArg(args, "about") === "" ? {} : { about: stringArg(args, "about") }),
        });
        const lines = page.items.map((note) => `${note.ref} ${note.title}：${note.summary}`);
        return {
          callId: request.callId,
          ok: true,
          content: `${lines.join("\n")}\n${textOf(this.services.table, "result.search.total", { total: page.total })}`,
        };
      }
      case "notes.read": {
        const body = await store.read(noteRefArg(args, "ref"));
        if (body === null) {
          return {
            callId: request.callId,
            ok: false,
            content: "",
            error: {
              rule: "notes.not_found",
              message: textOf(this.services.table, "refused.notes.notfound", { ref: noteRefArg(args, "ref") }),
              nextAction: textOf(this.services.table, "next.notes.notfound"),
            },
          };
        }
        return {
          callId: request.callId,
          ok: true,
          content: `${body.ref} ${body.body}\n${body.nextCall}`,
        };
      }
      case "notes.context": {
        const context_ = await store.context(noteRefArg(args, "ref"));
        if (context_ === null) {
          return {
            callId: request.callId,
            ok: false,
            content: "",
            error: {
              rule: "notes.not_found",
              message: textOf(this.services.table, "refused.notes.notfound", { ref: noteRefArg(args, "ref") }),
              nextAction: textOf(this.services.table, "next.notes.notfound"),
            },
          };
        }
        return {
          callId: request.callId,
          ok: true,
          content: `${context_.ref} ${context_.evidence.join(", ")}\n${context_.events.join(", ")}`,
        };
      }
      case "notes.active": {
        const page = await store.active();
        const lines = page.items.map((note) => `${note.ref} ${note.title}：${note.summary}`);
        return {
          callId: request.callId,
          ok: true,
          content: `${lines.join("\n")}\n${textOf(this.services.table, "result.search.total", { total: page.total })}`,
        };
      }
      default:
        return this.notOwned(request);
    }
  }

  private notOwned(request: ToolCall): ToolResult {
    return {
      callId: request.callId,
      ok: false,
      content: "",
      error: {
        rule: "module.function.unknown",
        message: textOf(this.services.table, "refused.unknown_function", { module: "notes", name: request.name }),
        nextAction: textOf(this.services.table, "next.unknown_function"),
      },
    };
  }
}

/** `channels`: list, get. Absent when no plugin registered a channel. */
export class ChannelsModuleGroup implements ToolGroup {
  readonly id = "modules.channels";

  private readonly services: ToolServices;

  constructor(services: ToolServices) {
    this.services = services;
  }

  tools(): readonly [] {
    return [];
  }

  modules(): readonly ModuleSpec[] {
    // A channel is a plugin's adapter, so a host no plugin plugged one into has
    // nothing to list and nothing to look up.
    if (this.services.channels().length === 0) return [];
    return [
      moduleSpec(this.services.table, "channels", [
        { name: "channels.list", signature: "channels.list()" },
        { name: "channels.get", signature: "channels.get(ref)" },
      ]),
    ];
  }

  async call(request: ToolCall, _context: CallContext): Promise<ToolResult> {
    switch (request.name) {
      case "channels.list":
        return this.list(request);
      case "channels.get":
        return this.get(request);
      default:
        return this.notOwned(request);
    }
  }

  /** `channels.list`: every channel, and what is connected on it. */
  private async list(request: ToolCall): Promise<ToolResult> {
    const table = this.services.table;
    const lines: string[] = [];
    for (const channel of this.services.channels()) {
      const connections = await channel.connections();
      if (connections.length === 0) {
        lines.push(textOf(table, "result.channels.none", { channel: channel.id }));
        continue;
      }
      for (const connection of connections) {
        lines.push(
          textOf(table, "result.channels.line", {
            channel: channel.id,
            id: connection.id,
            state: connection.online ? textOf(table, "result.channels.online") : textOf(table, "result.channels.offline"),
            detail: connection.detail === undefined ? "" : ` ${connection.detail}`,
          }),
        );
      }
    }
    return { callId: request.callId, ok: true, content: lines.join("\n") };
  }

  /** `channels.get(ref)`: one outside message, by its native id. */
  private async get(request: ToolCall): Promise<ToolResult> {
    const table = this.services.table;
    const ref = stringArg(request.args, "ref");
    const channel = this.channelOf(ref);
    if (channel === undefined) {
      return {
        callId: request.callId,
        ok: false,
        content: "",
        error: {
          rule: "channels.unknown",
          message: textOf(table, "refused.channels.unknown", { ref }),
          nextAction: textOf(table, "next.channels.unknown"),
        },
      };
    }
    const message = await channel.get(ref as ExternalRef);
    if (message === null) {
      return {
        callId: request.callId,
        ok: false,
        content: "",
        error: {
          rule: "channels.not_found",
          message: textOf(table, "refused.channels.notfound", { ref }),
          nextAction: textOf(table, "next.channels.notfound"),
        },
      };
    }
    return {
      callId: request.callId,
      ok: true,
      content: [
        textOf(table, "result.channels.message", {
          external: message.external,
          source: message.source,
          target: message.target,
          time: formatTime(message.time),
          reply:
            message.replyTo === undefined
              ? ""
              : textOf(table, "result.channels.reply", { reply: message.replyTo }),
          stored: message.stored ? textOf(table, "result.channels.stored") : "",
        }),
        textOfBlocks(message.content),
      ].join("\n"),
    };
  }

  /** The channel a native id names, by its prefix: `http:42` is `http`'s. */
  private channelOf(ref: string): Channel | undefined {
    const prefix = ref.split(":")[0] ?? "";
    return this.services.channels().find((channel) => channel.id === prefix);
  }

  private notOwned(request: ToolCall): ToolResult {
    return {
      callId: request.callId,
      ok: false,
      content: "",
      error: {
        rule: "module.function.unknown",
        message: textOf(this.services.table, "refused.unknown_function", { module: "channels", name: request.name }),
        nextAction: textOf(this.services.table, "next.unknown_function"),
      },
    };
  }
}

/** `tasks`: list, show. The tasks the host dispatched (docs/dispatch.md#tasks). */
export class TasksModuleGroup implements ToolGroup {
  readonly id = "modules.tasks";

  private readonly services: ToolServices;

  constructor(services: ToolServices) {
    this.services = services;
  }

  tools(): readonly [] {
    return [];
  }

  modules(): readonly ModuleSpec[] {
    return [
      moduleSpec(this.services.table, "tasks", [
        { name: "tasks.list", signature: "tasks.list(limit?)" },
        { name: "tasks.show", signature: "tasks.show(t…)" },
      ]),
    ];
  }

  async call(request: ToolCall, _context: CallContext): Promise<ToolResult> {
    const table = this.services.table;
    const args = request.args;
    switch (request.name) {
      case "tasks.list": {
        const tasks = await this.services.tasks(numberArg(args, "limit"));
        const lines = tasks.map((task) => this.line(task));
        return {
          callId: request.callId,
          ok: true,
          content: lines.length === 0 ? textOf(table, "result.list.empty") : lines.join("\n"),
        };
      }
      case "tasks.show": {
        const records = await this.services.task(taskRefsArg(args, "ref"));
        const lines: string[] = [];
        for (const record of records) {
          lines.push(this.line(record));
          // The outside events the batch was made of, as the journal holds them.
          for (const event of record.events) lines.push(`${event.ref} ${event.kind} ${bodyOf(event)}`);
        }
        return {
          callId: request.callId,
          ok: true,
          content: lines.length === 0 ? textOf(table, "result.list.empty") : lines.join("\n"),
        };
      }
      default:
        return this.notOwned(request);
    }
  }

  /** One task as one line: its ref, its kind, why it is one, its targets and its time. */
  private line(task: TaskSummary): string {
    return textOf(this.services.table, "result.tasks.line", {
      ref: task.ref,
      kind: task.kind,
      reason: task.reason,
      targets: task.targets.join(","),
      time: formatTime(task.time),
    });
  }

  private notOwned(request: ToolCall): ToolResult {
    return {
      callId: request.callId,
      ok: false,
      content: "",
      error: {
        rule: "module.function.unknown",
        message: textOf(this.services.table, "refused.unknown_function", {
          module: "tasks",
          name: request.name,
        }),
        nextAction: textOf(this.services.table, "next.unknown_function"),
      },
    };
  }
}

/** `schedule`: list, create, update, cancel (docs/dispatch.md#scheduled-tasks). */
export class ScheduleModuleGroup implements ToolGroup {
  readonly id = "modules.schedule";

  private readonly services: ToolServices;

  constructor(services: ToolServices) {
    this.services = services;
  }

  tools(): readonly [] {
    return [];
  }

  modules(): readonly ModuleSpec[] {
    return [
      moduleSpec(this.services.table, "schedule", [
        { name: "schedule.list", signature: "schedule.list()" },
        { name: "schedule.create", signature: "schedule.create({ name?, firstAt, repeat?, skipDaily?, targets?, task })" },
        { name: "schedule.update", signature: "schedule.update({ ref, name?, firstAt?, repeat?, skipDaily?, targets?, task? })" },
        { name: "schedule.cancel", signature: "schedule.cancel({ ref })" },
      ]),
    ];
  }

  async call(request: ToolCall, _context: CallContext): Promise<ToolResult> {
    const table = this.services.table;
    const args = request.args;
    switch (request.name) {
      case "schedule.list": {
        const schedules = await this.services.schedules();
        const lines = schedules.map((task) =>
          textOf(table, "result.schedule.line", {
            ref: task.ref,
            name: task.name ?? "",
            time: formatTime(task.nextAt),
            repeat: this.repeatText(task.repeat),
            targets: task.targets.join(","),
          }),
        );
        return {
          callId: request.callId,
          ok: true,
          content: lines.length === 0 ? textOf(table, "result.list.empty") : lines.join("\n"),
        };
      }
      case "schedule.create":
        return this.create(request);
      case "schedule.update":
        return this.update(request);
      case "schedule.cancel": {
        const ref = taskRefArg(args, "ref");
        if (ref === undefined) return this.badInput("ref");
        await this.services.cancelSchedule(ref);
        return {
          callId: request.callId,
          ok: true,
          content: textOf(table, "result.schedule.cancelled", { ref }),
        };
      }
      default:
        return this.notOwned(request);
    }
  }

  /** `schedule.create`: one new scheduled task, from what the script named. */
  private async create(request: ToolCall): Promise<ToolResult> {
    const table = this.services.table;
    const args = request.args;
    const firstAt = numberArg(args, "firstAt");
    if (firstAt === undefined) return this.badInput("firstAt");
    const repeat = repeatArg(args);
    if (repeat === "invalid") return this.badInput("repeat");
    const task = taskArg(args, "task", firstAt);
    if (task === undefined) return this.badInput("task");
    const name = stringArg(args, "name");
    const skipDaily = skipDailyArg(args);
    const targets = targetsArg(args);
    const input: ScheduledTaskInput = {
      firstAt,
      ...(name === "" ? {} : { name }),
      ...(repeat === undefined ? {} : { repeat }),
      ...(skipDaily.length === 0 ? {} : { skipDaily }),
      ...(targets.length === 0 ? {} : { targets }),
      task,
    };
    const ref = await this.services.schedule(input);
    return {
      callId: request.callId,
      ok: true,
      content: textOf(table, "result.schedule.created", { ref }),
    };
  }

  /** `schedule.update`: only the fields the script named change. */
  private async update(request: ToolCall): Promise<ToolResult> {
    const table = this.services.table;
    const args = request.args;
    const ref = taskRefArg(args, "ref");
    if (ref === undefined) return this.badInput("ref");
    const repeat = repeatArg(args);
    if (repeat === "invalid") return this.badInput("repeat");
    const firstAt = numberArg(args, "firstAt");
    const task = taskArg(args, "task", firstAt ?? 0);
    const name = stringArg(args, "name");
    const skipDaily = skipDailyArg(args);
    const targets = targetsArg(args);
    const changes: ScheduledTaskUpdate = {
      ...(name === "" ? {} : { name }),
      ...(firstAt === undefined ? {} : { firstAt }),
      ...(repeat === undefined ? {} : { repeat }),
      ...(skipDaily.length === 0 ? {} : { skipDaily }),
      ...(targets.length === 0 ? {} : { targets }),
      ...(task === undefined ? {} : { task }),
    };
    const updated = await this.services.updateSchedule(ref, changes);
    if (updated === null) return this.notFound(ref);
    return {
      callId: request.callId,
      ok: true,
      content: textOf(table, "result.schedule.updated", { ref }),
    };
  }

  /** One repeat rule as one line: only once, a period, or a daily clock time. */
  private repeatText(repeat: ScheduledTaskInput["repeat"]): string {
    const table = this.services.table;
    if (repeat === undefined) return textOf(table, "result.schedule.once");
    return "everyMs" in repeat
      ? textOf(table, "result.schedule.every_ms", { ms: repeat.everyMs })
      : textOf(table, "result.schedule.daily", { time: repeat.dailyAt });
  }

  /** One argument the script did not name in a shape this module can read. */
  private badInput(field: string): ToolResult {
    return refused("schedule.input.invalid", this.services.table, "schedule.input", { field });
  }

  private notFound(ref: TaskRef): ToolResult {
    return refused("schedule.not_found", this.services.table, "schedule.notfound", { ref });
  }

  private notOwned(request: ToolCall): ToolResult {
    return {
      callId: request.callId,
      ok: false,
      content: "",
      error: {
        rule: "module.function.unknown",
        message: textOf(this.services.table, "refused.unknown_function", {
          module: "schedule",
          name: request.name,
        }),
        nextAction: textOf(this.services.table, "next.unknown_function"),
      },
    };
  }
}

/** `workspace`: grep, find, ls. Absent when the host has no workspace. */
export class WorkspaceModuleGroup implements ToolGroup {
  readonly id = "modules.workspace";

  private readonly services: ToolServices;

  constructor(services: ToolServices) {
    this.services = services;
  }

  tools(): readonly [] {
    return [];
  }

  modules(): readonly ModuleSpec[] {
    // A module whose backing feature is not configured is absent
    // (docs/tools.md#modules).
    if (this.services.workspace === undefined) return [];
    return [
      moduleSpec(this.services.table, "workspace", [
        { name: "workspace.grep", signature: "workspace.grep(pattern, path?)" },
        { name: "workspace.find", signature: "workspace.find(name, path?)" },
        { name: "workspace.ls", signature: "workspace.ls(path?)" },
      ]),
    ];
  }

  async call(request: ToolCall, context: CallContext): Promise<ToolResult> {
    switch (request.name) {
      case "workspace.ls":
        return this.ls(request, context.window, context);
      case "workspace.find":
        return this.find(request, context.window);
      case "workspace.grep":
        return this.grep(request, context.window);
      default:
        return this.notOwned(request);
    }
  }

  private async ls(request: ToolCall, window: WindowRef, context: CallContext): Promise<ToolResult> {
    const workspace = await this.services.ensureWorkspace(window);
    if (workspace === undefined) return this.absent(request);
    const path = stringArg(request.args, "path") || ".";
    // A path under the environment's prefix is read where the command runs, so
    // the prefix is resolved the same way `bash` resolves it.
    const listed = await this.runIn(
      workspace,
      `ls -1p ${quote(await envCommand(workspace, path, this.services.envPaths(), context.envRevision))}`,
    );
    if (listed !== null) {
      return { callId: request.callId, ok: listed.exitCode === 0, content: listed.stdout.trim() };
    }
    const target = joinInside(workspace.path, path);
    if (target === undefined) return this.outside(request);
    const entries = await readdirSafe(target);
    return {
      callId: request.callId,
      ok: true,
      content: entries.map((entry) => `${entry.name}${entry.directory ? "/" : ""}`).join("\n"),
    };
  }

  private async find(request: ToolCall, window: WindowRef): Promise<ToolResult> {
    const workspace = await this.services.ensureWorkspace(window);
    if (workspace === undefined) return this.absent(request);
    const name = stringArg(request.args, "name");
    const found = await this.runIn(workspace, `find . -name ${quote(`*${name}*`)}`);
    if (found !== null) {
      return {
        callId: request.callId,
        ok: found.exitCode === 0,
        content: found.stdout.trim().split("\n").filter((line) => line !== "").join("\n"),
      };
    }
    const paths = await walk(workspace.path, (entry) => entry.name.includes(name));
    return {
      callId: request.callId,
      ok: true,
      content: paths.map((path) => path.slice(workspace.path.length + 1)).join("\n"),
    };
  }

  private async grep(request: ToolCall, window: WindowRef): Promise<ToolResult> {
    const workspace = await this.services.ensureWorkspace(window);
    if (workspace === undefined) return this.absent(request);
    const pattern = stringArg(request.args, "pattern");
    const matched = await this.runIn(workspace, `grep -rn ${quote(pattern)} .`);
    if (matched !== null) {
      return { callId: request.callId, ok: matched.exitCode === 0, content: matched.stdout.trim() };
    }
    const files = await walk(workspace.path, () => true);
    const lines: string[] = [];
    for (const file of files) {
      const text = await readFileSafe(file);
      if (text === null || !text.includes(pattern)) continue;
      const relative = file.slice(workspace.path.length + 1);
      text.split("\n").forEach((line, index) => {
        if (line.includes(pattern)) lines.push(`${relative}:${index + 1}:${line}`);
      });
    }
    return { callId: request.callId, ok: true, content: lines.slice(0, 200).join("\n") };
  }

  /**
   * One lookup inside the workspace. An implementation that owns the execution
   * environment answers with `exec`, because its `path` is not a host path;
   * `null` means the caller walks the host directory itself.
   */
  private async runIn(
    workspace: WorkspaceMount,
    command: string,
  ): Promise<{ exitCode: number; stdout: string } | null> {
    if (workspace.exec === undefined) return null;
    return workspace.exec(command).catch(() => null);
  }

  private absent(request: ToolCall): ToolResult {
    return {
      callId: request.callId,
      ok: false,
      content: "",
      error: {
        rule: "workspace.absent",
        message: textOf(this.services.table, "result.no_workspace"),
        nextAction: textOf(this.services.table, "next.workspace.notfound"),
      },
    };
  }

  private outside(request: ToolCall): ToolResult {
    return {
      callId: request.callId,
      ok: false,
      content: "",
      error: {
        rule: "file.outside_workspace",
        message: textOf(this.services.table, "refused.read.outside", { path: stringArg(request.args, "path") }),
        nextAction: textOf(this.services.table, "next.read.outside"),
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
        message: textOf(this.services.table, "refused.unknown_function", {
          module: "workspace",
          name: request.name,
        }),
        nextAction: textOf(this.services.table, "next.unknown_function"),
      },
    };
  }
}

function bodyOf(event: Event): string {
  return event.body === null ? "" : event.body.replace(/\s+/g, " ").slice(0, 120);
}

/** The text of an outside message's blocks: what its sender wrote. */
function textOfBlocks(blocks: readonly Block[]): string {
  const lines: string[] = [];
  for (const block of blocks) {
    const content = block.fields.content;
    if (typeof content === "string") lines.push(content);
  }
  return lines.join("\n");
}

function traceText(node: { ref: Ref; summary: string; from: readonly unknown[] }, depth: number): string {
  const lines = [`${"  ".repeat(depth)}${node.ref} ${node.summary}`];
  for (const parent of node.from as readonly { ref: Ref; summary: string; from: readonly unknown[] }[]) {
    lines.push(traceText(parent, depth + 1));
  }
  return lines.join("\n");
}

/** One shell argument, quoted so a path with a space survives. */
function quote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function joinInside(root: string, path: string): string | undefined {
  if (path === "") return undefined;
  const wanted = isAbsolute(path) ? normalize(path) : resolve(root, path);
  return wanted === root || wanted.startsWith(root + sep) ? wanted : undefined;
}

async function readdirSafe(path: string): Promise<{ name: string; directory: boolean }[]> {
  try {
    return await readdir(path, { withFileTypes: true }).then((entries) =>
      entries.map((entry) => ({ name: entry.name, directory: entry.isDirectory() })),
    );
  } catch {
    return [];
  }
}

async function readFileSafe(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

/** Every file under a directory, in a stable order. */
async function walk(root: string, keep: (entry: { name: string }) => boolean): Promise<string[]> {
  const found: string[] = [];
  const step = async (directory: string): Promise<void> => {
    for (const entry of await readdirSafe(directory)) {
      const path = join(directory, entry.name);
      if (entry.directory) {
        if (entry.name === ".arbor" || entry.name === ".git") continue;
        await step(path);
        continue;
      }
      if (!keep(entry)) continue;
      found.push(path);
    }
  };
  await step(root);
  return found.sort();
}

function stringArg(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  return typeof value === "string" ? value : "";
}

function numberArg(args: Record<string, unknown>, name: string): number | undefined {
  const value = args[name];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function refArg(args: Record<string, unknown>, name: string): Ref {
  const value = args[name];
  return typeof value === "string" ? (value as Ref) : ("" as Ref);
}

function noteRefArg(args: Record<string, unknown>, name: string): NoteRef {
  const value = refArg(args, name);
  return /^n\d+(@\d+)?$/.test(value) ? (value as NoteRef) : ("n0" as NoteRef);
}

function eventRefsArg(args: Record<string, unknown>, name: string): EventRef[] {
  const value = args[name];
  if (Array.isArray(value)) return value.filter((item): item is EventRef => typeof item === "string");
  const single = refArg(args, name);
  return /^r\d+$/.test(single) ? [single as EventRef] : [];
}

function windowArg(args: Record<string, unknown>, name: string): WindowRef {
  const value = refArg(args, name);
  return /^c\d+$/.test(value) ? (value as WindowRef) : ("c0" as WindowRef);
}

/** The task refs an argument names: one, or a list of them. */
function taskRefsArg(args: Record<string, unknown>, name: string): TaskRef[] {
  const value = args[name];
  if (Array.isArray(value)) {
    return value.flatMap((one) =>
      typeof one === "string" && /^t\d+$/.test(one) ? [one as TaskRef] : [],
    );
  }
  const single = refArg(args, name);
  return /^t\d+$/.test(single) ? [single as TaskRef] : [];
}

/** One task ref, or undefined when the argument is not one. */
function taskRefArg(args: Record<string, unknown>, name: string): TaskRef | undefined {
  return taskRefsArg(args, name)[0];
}

/**
 * One repeat rule, `invalid` when the argument is not one this module can read:
 * a period in milliseconds, or a clock time a firing repeats at daily.
 */
function repeatArg(args: Record<string, unknown>): ScheduledTaskInput["repeat"] | "invalid" | undefined {
  const value = args.repeat;
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null) return "invalid";
  const repeat = value as { everyMs?: unknown; dailyAt?: unknown };
  if (typeof repeat.everyMs === "number" && Number.isFinite(repeat.everyMs) && repeat.everyMs > 0) {
    return { everyMs: repeat.everyMs };
  }
  if (typeof repeat.dailyAt === "string" && /^\d{1,2}:\d{2}$/u.test(repeat.dailyAt.trim())) {
    return { dailyAt: repeat.dailyAt.trim() };
  }
  return "invalid";
}

/** The daily skip periods an argument names. */
function skipDailyArg(args: Record<string, unknown>): readonly SkipPeriod[] {
  const value = args.skipDaily;
  if (!Array.isArray(value)) return [];
  return value.flatMap((one) => {
    if (typeof one !== "object" || one === null) return [];
    const period = one as { from?: unknown; to?: unknown };
    return typeof period.from === "string" && typeof period.to === "string"
      ? [{ from: period.from, to: period.to }]
      : [];
  });
}

/** The strings an argument names, or none when it names something else. */
function stringsArg(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((one): one is string => typeof one === "string" && one !== "");
}

/** The targets an argument names, or none when it names something else. */
function targetsArg(args: Record<string, unknown>): readonly Target[] {
  return stringsArg(args.targets);
}

/**
 * What a scheduled firing dispatches. Its time defaults to the firing's own, so
 * a script names what the task says and why and nothing else; the blocks it
 * carries are data, exactly as the host holds them.
 */
function taskArg(
  args: Record<string, unknown>,
  name: string,
  at: number,
): Omit<TaskInput, "kind"> | undefined {
  const value = args[name];
  if (typeof value !== "object" || value === null) return undefined;
  const task = value as { reason?: unknown; targets?: unknown; time?: unknown; content?: unknown };
  if (typeof task.reason !== "string" || task.reason === "" || !Array.isArray(task.content)) return undefined;
  return {
    reason: task.reason,
    targets: stringsArg(task.targets),
    time: typeof task.time === "number" && Number.isFinite(task.time) ? task.time : at,
    content: task.content as readonly Block[],
  };
}

/**
 * One refusal the service layer threw, as the tool result the model reads. The
 * service layer refuses in the core's error shape (docs/architecture.md#errors),
 * so the rule and the next action it names reach the model unchanged.
 */
function refusedOf(request: ToolCall, error: unknown): ToolResult {
  const refusal = error as { rule?: unknown; message?: unknown; nextAction?: unknown; refs?: unknown };
  const rule = typeof refusal.rule === "string" ? refusal.rule : "internal";
  const message = typeof refusal.message === "string" ? refusal.message : String(error);
  const nextAction = typeof refusal.nextAction === "string" ? refusal.nextAction : undefined;
  const refs = Array.isArray(refusal.refs) ? refusal.refs.filter((one): one is Ref => typeof one === "string") : [];
  return {
    callId: request.callId,
    ok: false,
    content: "",
    error: {
      rule,
      message,
      ...(nextAction === undefined ? {} : { nextAction }),
      ...(refs.length === 0 ? {} : { refs }),
    },
  };
}

export { EnvModuleGroup } from "./env.ts";
export type { LiveWindow };
