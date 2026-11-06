import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { SqliteJournal } from "@4fu/arbor-journal-sqlite";
import { DirectoryWorkspace } from "@4fu/arbor-workspace-dir";
import type {
  CallContext,
  Channel,
  Event,
  ExternalTool,
  NoteStore,
  NoteWriteInput,
  ScheduledTask,
  ScheduledTaskInput,
  ScheduledTaskUpdate,
  TaskRef,
  ToolResult,
  WorkspaceMount,
} from "@4fu/arbor-interfaces";
import { Renderer, dataBlock, zhTextTable } from "@4fu/arbor-prompt";
import { ToolCatalog } from "./catalog.ts";
import type { LiveWindow, TaskSummary, ToolServices } from "./host.ts";
import { handoffOf } from "./groups/core.ts";

interface Harness {
  catalog: ToolCatalog;
  journal: SqliteJournal;
  root: string;
  workspace: DirectoryWorkspace;
  ended: { window: string; handoff?: unknown }[];
  sent: { to: string; content: string }[];
  written: { window: string; input: NoteWriteInput }[];
  /** Every `schedule.create` argument the service layer was handed. */
  created: ScheduledTaskInput[];
  /** Every `schedule.update` argument the service layer was handed. */
  changed: { ref: TaskRef; changes: ScheduledTaskUpdate }[];
  /** Every `schedule.cancel` ref the service layer was handed. */
  cancelled: TaskRef[];
  /** The events each task's record carries, as the host would hand them back. */
  batched: Map<string, Event[]>;
  /** The workspace ref the window's first file call created. */
  refOf(window: string): string;
  /** The external tools the catalog did not register, with the rule. */
  refused: readonly { name: string; source: string; rule: string }[];
}

async function harness(
  options: { notes?: boolean; channels?: boolean; workspace?: boolean; external?: readonly ExternalTool[] } = {},
): Promise<Harness> {
  const journal = new SqliteJournal({ path: ":memory:" });
  const root = await mkdtemp(join(tmpdir(), "arbor-tools-"));
  const workspace = new DirectoryWorkspace({ root });
  const ended: Harness["ended"] = [];
  const sent: Harness["sent"] = [];
  const written: { window: string; input: NoteWriteInput }[] = [];
  const mounts = new Map<string, WorkspaceMount>();
  const live: LiveWindow[] = [
    {
      window: "c2",
      state: "running",
      startedAt: 1,
      targets: ["gh:pr:57"],
      doing: "修构建",
      expects: [],
      usage: { used: 1000, limit: 200000, reserve: 4000 },
    },
  ];
  const board = new Map<string, string>([["c1", "整理笔记"]]);
  const inbox: { ref: `r${number}`; from: `c${number}`; text: string }[] = [];
  // The task records and the schedules the host would hold, so the modules are
  // driven against the service calls they make.
  const summaries: TaskSummary[] = [
    {
      ref: "t1",
      kind: "batch",
      reason: "a message arrived in qq:group:1",
      targets: ["qq:group:1"],
      time: 1,
    },
    {
      ref: "t2",
      kind: "scheduled",
      reason: "a scheduled check",
      targets: ["gh:pr:57"],
      time: 2,
    },
  ];
  const batched = new Map<string, Event[]>();
  const stored: ScheduledTask[] = [
    {
      ref: "t5",
      name: "每日汇总",
      firstAt: 1_700_000_000_000,
      nextAt: 1_700_003_600_000,
      repeat: { everyMs: 3_600_000 },
      targets: ["gh:pr:57"],
      paused: false,
    },
  ];
  const created: ScheduledTaskInput[] = [];
  const changed: { ref: TaskRef; changes: ScheduledTaskUpdate }[] = [];
  const cancelled: TaskRef[] = [];
  // A channel is a plugin's adapter, so the harness has one only when the test
  // says so: a host no plugin plugged one into lists no channel.
  const channel = options.channels === true ? fakeChannel() : undefined;

  const services: ToolServices = {
    table: zhTextTable,
    journal,
    ...(options.notes === false ? {} : { notes: notesStore() }),
    ...(options.workspace === false ? {} : { workspace }),
    ensureWorkspace: async (window) => {
      const found = mounts.get(window);
      if (found !== undefined) return found;
      const ref = await workspace.create(window as `c${number}`);
      refs.set(window, ref);
      const mount = await workspace.mount(ref);
      mounts.set(window, mount);
      return mount;
    },
    endWindow: async (window, handoff) => {
      ended.push({ window, handoff });
      return { callId: "", ok: true, content: "已结束" };
    },
    hasOpenWork: async () => true,
    writeNote: async (window, input) => {
      written.push({ window, input });
      return {
        ref: "n1@1",
        id: "n1",
        title: input.title,
        summary: input.summary ?? "",
        body: input.body,
        status: "active",
        revision: 1,
        time: 1,
        window,
      };
    },
    search: async (window, query) => ({
      query,
      scope: ["journal"],
      hits: [
        {
          ref: "r1",
          seq: 1,
          window: window as `c${number}`,
          kind: "input",
          time: 1,
          match: "substring",
          score: 1,
          summary: `命中 ${query}`,
        },
      ],
      notes: [],
      windows: [],
      total: 1,
      nextCall: "search(query)",
    }),
    send: async (_window, request) => {
      sent.push({ to: request.to, content: request.content });
      return { event: "r9", behind: 0 };
    },
    board: async () => ({
      items: [...board.entries()].map(([window, doing]) => ({
        window: window as `c${number}`,
        doing,
        targets: [],
        expects: [],
        state: "running" as const,
        usage: { used: 1, limit: 200000, reserve: 4000 },
      })),
      total: board.size,
      limit: 20,
      nextCall: "board.list()",
    }),
    setBoardLine: async (window, doing) => {
      board.set(window, doing);
    },
    expect: async (_window, item, description) => ({
      kind: item === undefined ? "described" : "exact",
      ...(item === undefined ? {} : { item }),
      ...(description === undefined ? {} : { description }),
      ref: "m1",
    }),
    unexpect: async () => {},
    channels: () => (channel === undefined ? [] : [channel]),
    windows: async () => live,
    windowTranscript: async (window) => (await journal.list({ window })).items,
    windowMessage: async (_from, to) => {
      live.push({
        window: to,
        state: "running",
        startedAt: 2,
        targets: [],
        doing: "收到消息",
        expects: [],
        usage: { used: 1, limit: 200000, reserve: 4000 },
      });
      return "m10";
    },
    broadcast: async () => 0,
    inbox: async () => inbox,

    tasks: async (limit) => summaries.slice(-(limit ?? 20)),
    task: async (refs) =>
      refs.flatMap((ref) => {
        const summary = summaries.find((one) => one.ref === ref);
        return summary === undefined ? [] : [{ ...summary, events: batched.get(ref) ?? [] }];
      }),
    schedules: async () => stored,
    schedule: async (input) => {
      created.push(input);
      return "t9" as TaskRef;
    },
    updateSchedule: async (ref, changes) => {
      changed.push({ ref, changes });
      return stored.find((one) => one.ref === ref) ?? null;
    },
    cancelSchedule: async (ref) => {
      cancelled.push(ref);
    },

    envPaths: () => undefined,
    envCatalog: () => ({ items: [], modules: [], removed: [] }),
    envItemAt: async () => undefined,
    envRead: () => {},
    reload: async () => ({ revision: "e1", changes: [], delivered: 0 }),
    callMcp: async () => "",
  };

  const catalog = new ToolCatalog({ services });
  const refs = new Map<string, string>();
  const refused = catalog.external(options.external ?? [], "dsh");
  return {
    catalog,
    journal,
    root,
    workspace,
    ended,
    sent,
    written,
    created,
    changed,
    cancelled,
    batched,
    refOf: (window: string) => refs.get(window) ?? "",
    refused,
  };
}

function context(window = "c1", overrides: Partial<CallContext> = {}): CallContext {
  return { window: window as `c${number}`, ...overrides };
}

async function run(catalog: ToolCatalog, name: string, args: Record<string, unknown>, at?: string): Promise<ToolResult> {
  return catalog.call({ name, args, callId: "call_1" }, context("c1", at === undefined ? {} : { call: at as `r${number}` }));
}

describe("tool catalog", () => {
  it("declares the direct tools and the modules, with descriptions from the table", () => {
    return harness().then(({ catalog }) => {
      const tools = catalog.tools().map((tool) => tool.name);
      assert.ok(tools.includes("send"));
      assert.ok(tools.includes("end"));
      assert.ok(tools.includes("search"));
      assert.ok(tools.includes("bash"));
      assert.ok(tools.includes("code_exec"));
      assert.ok(tools.includes("tool_search"));
      const modules = catalog.modules().map((module) => module.name);
      assert.deepEqual(modules, ["journal", "windows", "board", "notes", "tasks", "schedule", "workspace"]);
      // A module's line describes what it can do and never names a function.
      const journal = catalog.modules().find((module) => module.name === "journal");
      assert.ok((journal?.description ?? "").length > 0);
      assert.ok(!journal?.description.includes("journal.search"));
    });
  });

  it("omits the notes module when no NoteStore is configured", async () => {
    const withoutNotes = await harness({ notes: false });
    assert.ok(!withoutNotes.catalog.modules().some((module) => module.name === "notes"));
    const notes = await harness();
    assert.ok(notes.catalog.modules().some((module) => module.name === "notes"));
  });

  it("omits the workspace module when no workspace is configured", async () => {
    const { catalog } = await harness({ workspace: false });
    assert.ok(!catalog.modules().some((module) => module.name === "workspace"));
    const listed = await run(catalog, "workspace.ls", {});
    assert.equal(listed.ok, false);
    assert.equal(listed.error?.rule, "tool.unknown");
  });

  it("answers another window's directory by its window, and a window reads what is in it", async () => {
    const { catalog, root } = await harness();
    await run(catalog, "write", { path: "notes.txt", text: "work in progress" });
    const found = await run(catalog, "workspace.path", { window: "c1" });
    assert.equal(found.ok, true);
    assert.ok(found.content.includes(join(root, "ws1")));
    // The answer says whose directory it is, and that it is not to be changed.
    assert.ok(found.content.includes("只读"));
    // The module lists the lookup beside the lookups the core declares, and the
    // persistent directories this implementation contributes.
    assert.deepEqual(
      catalog.modules().find((module) => module.name === "workspace")?.functions.map((fn) => fn.name),
      ["workspace.grep", "workspace.find", "workspace.ls", "workspace.keep", "workspace.keeps", "workspace.path"],
    );

    // A persistent directory is answered with its path under the keep root, and
    // the listing names it (docs/workspaces.md#persistent-directories).
    const kept = await run(catalog, "workspace.keep", { name: "build-cache" });
    assert.equal(kept.ok, true);
    assert.ok(kept.content.includes(join(root, "keep", "build-cache")));
    const listed = await run(catalog, "workspace.keeps", {});
    assert.equal(listed.ok, true);
    assert.ok(listed.content.includes("build-cache"));

    // Another window reads the directory the answer names, by its path.
    const read = await catalog.call(
      { name: "read", args: { path: join(root, "ws1", "notes.txt") }, callId: "call_1" },
      context("c2"),
    );
    assert.ok(read.content.includes("work in progress"));

    const unknown = await run(catalog, "workspace.path", { window: "c9" });
    assert.equal(unknown.ok, false);
    assert.equal(unknown.error?.rule, "workspace.not_found");
    assert.ok((unknown.error?.nextAction ?? "").includes("windows.list"));
  });

  it("omits the channels module when no channel is registered", async () => {
    const { catalog } = await harness();
    assert.ok(!catalog.modules().some((module) => module.name === "channels"));
    const result = await run(catalog, "channels.list", {});
    assert.equal(result.ok, false);
    assert.equal(result.error?.rule, "tool.unknown");
  });

  it("lists the registered channels and reads one message by its native id", async () => {
    const { catalog } = await harness({ channels: true });
    assert.deepEqual(catalog.modules().map((module) => module.name), [
      "journal",
      "windows",
      "board",
      "notes",
      "channels",
      "tasks",
      "schedule",
      "workspace",
    ]);
    assert.deepEqual(
      catalog.modules().find((module) => module.name === "channels")?.functions.map((fn) => fn.name),
      ["channels.list", "channels.get"],
    );

    const list = await run(catalog, "channels.list", {});
    assert.equal(list.ok, true);
    assert.ok(list.content.includes("http http 在线 http://127.0.0.1:8787"));
    assert.ok(list.content.includes("http http:demo 离线"));

    const found = await run(catalog, "channels.get", { ref: "http:42" });
    assert.equal(found.ok, true);
    assert.ok(found.content.includes("http:42 http http:demo"));
    assert.ok(found.content.includes("回复 http:41"));
    assert.ok(found.content.includes("（存储副本）"));
    assert.ok(found.content.includes("部署流程是什么"));
  });

  it("refuses a channel lookup the prefix or the id does not name", async () => {
    const { catalog } = await harness({ channels: true });
    const unknown = await run(catalog, "channels.get", { ref: "qq:42" });
    assert.equal(unknown.ok, false);
    assert.equal(unknown.error?.rule, "channels.unknown");
    assert.ok((unknown.error?.nextAction ?? "").includes("channels.list"));
    const missing = await run(catalog, "channels.get", { ref: "http:99" });
    assert.equal(missing.ok, false);
    assert.equal(missing.error?.rule, "channels.not_found");
    assert.ok((missing.error?.message ?? "").includes("http:99"));
  });

  it("answers channels.list from a script, the way a direct call is answered", async () => {
    const { catalog } = await harness({ channels: true });
    const scripted = await run(catalog, "code_exec", {
      script: "return await channels.list()",
    });
    assert.equal(scripted.ok, true);
    assert.ok(scripted.content.includes("http http 在线"));
  });

  it("routes a direct tool and a module function through the same service call", async () => {
    const { catalog, journal } = await harness();
    await journal.append({ kind: "input", window: "c1", body: "部署上线流程已确认", targets: ["qq:group:1"] });
    const direct = await run(catalog, "search", { query: "部署" });
    assert.equal(direct.ok, true);
    assert.ok(direct.content.includes("命中 部署"));
    const scripted = await run(catalog, "code_exec", {
      script: "return await journal.search({ query: '部署' })",
    });
    assert.equal(scripted.ok, true);
    assert.ok(scripted.content.includes("部署上线流程已确认"));
  });

  it("records a send through the effect queue and says when the window is behind", async () => {
    const { catalog, sent } = await harness();
    const result = await run(catalog, "send", { to: "qq:group:123", content: "已完成" });
    assert.equal(result.ok, true);
    assert.deepEqual(sent, [{ to: "qq:group:123", content: "已完成" }]);
    assert.ok(result.content.includes("已记录"));
  });

  it("refuses a send with no target, naming the rule and the next action", async () => {
    const { catalog } = await harness();
    const result = await run(catalog, "send", { to: "", content: "x" });
    assert.equal(result.ok, false);
    assert.equal(result.error?.rule, "send.target.empty");
    assert.ok(result.error?.nextAction !== undefined && result.error.nextAction.length > 0);
  });

  it("refuses end without a handoff when the window still has work", async () => {
    const { catalog, ended } = await harness();
    const result = await run(catalog, "end", {});
    assert.equal(result.ok, false);
    assert.equal(result.error?.rule, "end.handoff.required");
    assert.ok(result.error?.message.includes("当前话题"));
    assert.equal(ended.length, 0);
  });

  it("ends the window with a handoff and continues in a new one", async () => {
    const { catalog, ended } = await harness();
    const result = await run(catalog, "end", {
      handoff: { topics: ["部署"], progress: ["已改配置"], pending: ["等待 CI"], agreements: ["先灰度"], refs: ["r12"] },
    });
    assert.equal(result.ok, true);
    assert.equal(ended.length, 1);
    assert.deepEqual(ended[0]?.handoff, {
      topics: ["部署"],
      progress: ["已改配置"],
      pending: ["等待 CI"],
      agreements: ["先灰度"],
      refs: ["r12"],
    });
  });

  it("reads a handoff's four parts, each with its refs", () => {
    const handoff = handoffOf({ topics: ["a"], progress: [], pending: [], agreements: [], refs: ["r1"] });
    assert.deepEqual(handoff?.topics, ["a"]);
    assert.equal(handoffOf({}), undefined);
    assert.equal(handoffOf("nope"), undefined);
  });

  it("answers tool_search with the modules and one function's instructions", async () => {
    const { catalog } = await harness();
    const all = await run(catalog, "tool_search", {});
    assert.ok(all.content.includes("journal"));
    // The answer leads with how a function is called, and closes with how to
    // read one signature.
    assert.ok(all.content.includes("在 code_exec 脚本中"));
    assert.ok(all.content.includes("tool_describe"));
    const one = await run(catalog, "tool_search", { keywords: "journal.search" });
    assert.ok(one.content.includes("journal.search(query, options?)"));
    const none = await run(catalog, "tool_search", { keywords: "zzz" });
    assert.equal(none.ok, true);
    assert.ok(none.content.length > 0);
    assert.ok(none.content.includes("没有匹配的名称"));
  });

  it("answers tool_search about a direct tool, exactly first", async () => {
    const { catalog } = await harness();
    // A direct tool is not a module function, and the answer says what it does.
    const bash = await run(catalog, "tool_search", { keywords: "bash" });
    assert.ok(bash.content.includes("bash"));
    assert.ok(bash.content.includes("执行一条命令"));
    // An exact name comes before a name that only starts with it, and both
    // before a description that merely holds it.
    const end = await run(catalog, "tool_search", { keywords: "end" });
    const lines = end.content.split("\n");
    assert.equal(lines[lines.length - 2]?.startsWith("end："), true);
    const note = await run(catalog, "tool_search", { keywords: "note" });
    assert.ok(note.content.includes("note_write"));
    assert.ok(note.content.includes("note_replace"));
    assert.ok(note.content.includes("note_delete"));
    // A function answers on its own name, without the module in front of it.
    const search = await run(catalog, "tool_search", { keywords: "search" });
    assert.ok(search.content.includes("journal.search(query, options?)"));
    const short = await run(catalog, "tool_search", { keywords: "sho" });
    assert.ok(short.content.includes("journal.show(ref)"));
    assert.ok(short.content.includes("windows.show(c…)"));
  });

  it("refuses a script that names a direct tool, and never reaches the host", async () => {
    const { catalog, sent } = await harness();
    const result = await run(catalog, "code_exec", { script: "send('qq:1', 'hi')" });
    assert.equal(result.ok, false);
    assert.equal(result.error?.rule, "script.decision_tool");
    assert.ok(result.error?.message.includes("send"));
    assert.equal(sent.length, 0);
  });

  it("declares a plugin's or a backend's tool beside the core's own, and calls it through the same path", async () => {
    const calls: { name: string; args: Record<string, unknown>; context: CallContext }[] = [];
    const lint: ExternalTool = {
      name: "dsh_lint",
      description: "检查一段配置是否合法。",
      parameters: { text: { type: "string", description: "配置内容", required: true } },
      execute: async (request, context) => {
        calls.push({ name: request.name, args: request.args, context });
        return { callId: request.callId, ok: true, content: "检查完成" };
      },
    };
    const { catalog, refused } = await harness({ external: [lint] });
    assert.deepEqual(refused, []);
    // It is declared to the model like any direct tool, with where it comes from.
    const declared = catalog.tools().find((tool) => tool.name === "dsh_lint");
    assert.equal(declared?.source, "dsh");
    assert.equal(declared?.description, "检查一段配置是否合法。");
    assert.deepEqual(Object.keys(declared?.parameters ?? {}), ["text"]);

    // The call runs the tool's own execute, with the context the service layer
    // fills for every tool - the same one a core tool is handed.
    const at = "r7" as const;
    const result = await run(catalog, "dsh_lint", { text: "a: 1" }, at);
    assert.equal(result.ok, true);
    assert.equal(result.content, "检查完成");
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.name, "dsh_lint");
    assert.deepEqual(calls[0]?.args, { text: "a: 1" });
    assert.equal(calls[0]?.context.window, "c1");
    assert.equal(calls[0]?.context.call, at);

    // The one result cut is the catalog's, and it is the only one: an answer
    // longer than the limit comes back cut, with the marker.
    const long: ExternalTool = {
      name: "dsh_long",
      description: "返回很长的一段输出。",
      parameters: {},
      execute: async (request) => ({ callId: request.callId, ok: true, content: "x".repeat(30000) }),
    };
    const { catalog: cutting } = await harness({ external: [long] });
    const cut = await run(cutting, "dsh_long", {});
    assert.ok(cut.content.includes("输出已截断"));
    assert.ok(cut.content.length < 25000);
  });

  it("lets a script call a plugin tool, and still refuses one that names arbor's own", async () => {
    const calls: string[] = [];
    const lint: ExternalTool = {
      name: "dsh_lint",
      description: "检查一段配置是否合法。",
      parameters: { text: { type: "string", description: "配置内容", required: true } },
      execute: async (request) => {
        calls.push(String(request.args.text));
        return { callId: request.callId, ok: true, content: `检查完成 ${String(request.args.text)}` };
      },
    };
    const { catalog, sent } = await harness({ external: [lint] });
    // A tool declared from outside the core is a capability of its own, like a
    // module function: a script reaches it as a global of the same name.
    const scripted = await run(catalog, "code_exec", { script: "return await dsh_lint({ text: 'a: 1' })" });
    assert.equal(scripted.ok, true);
    assert.ok(scripted.content.includes("检查完成 a: 1"));
    assert.deepEqual(calls, ["a: 1"]);
    // A refusal from it reaches the script as an error, the way a module
    // function's does.
    const failing: ExternalTool = {
      name: "dsh_fail",
      description: "总是失败。",
      parameters: {},
      execute: async (request) => ({
        callId: request.callId,
        ok: false,
        content: "",
        error: { rule: "dsh.refused", message: "本部署禁止检查" },
      }),
    };
    const { catalog: refusedCatalog } = await harness({ external: [failing] });
    const failed = await run(refusedCatalog, "code_exec", { script: "return await dsh_fail()" });
    assert.equal(failed.ok, false);
    assert.equal(failed.error?.rule, "script.failed");
    assert.ok(failed.error?.message.includes("本部署禁止检查"));

    // The guard still keeps arbor's own decisions and commands out of a script.
    const decision = await run(catalog, "code_exec", { script: "send('qq:1', 'hi')" });
    assert.equal(decision.error?.rule, "script.decision_tool");
    assert.equal(sent.length, 0);
    const command = await run(catalog, "code_exec", { script: "return read({ path: 'a.txt' })" });
    assert.equal(command.error?.rule, "script.decision_tool");
  });

  it("does not register an external tool whose name the model already has", async () => {
    const colliding: ExternalTool = {
      name: "send",
      description: "另一个发送。",
      parameters: {},
      execute: async (request) => ({ callId: request.callId, ok: true, content: "不应该到达" }),
    };
    const moduleName: ExternalTool = {
      name: "journal",
      description: "另一个记录模块。",
      parameters: {},
      execute: async (request) => ({ callId: request.callId, ok: true, content: "不应该到达" }),
    };
    const { catalog, refused, sent } = await harness({ external: [colliding, moduleName] });
    // Neither is registered: the core tool and the module keep their names.
    assert.ok(!catalog.tools().some((tool) => tool.name === "send" && tool.source === "dsh"));
    assert.equal(catalog.tools().find((tool) => tool.name === "send")?.source, undefined);
    assert.ok(!catalog.modules().some((module) => module.name === "journal" && module.description === "另一个记录模块。"));
    // Both collisions come back with the rule, so the host records them.
    assert.deepEqual(refused, [
      { name: "send", source: "dsh", rule: "tool.name_taken" },
      { name: "journal", source: "dsh", rule: "tool.name_taken" },
    ]);
    // The core tool still answers, and the plugin's never runs.
    const sent_ = await run(catalog, "send", { to: "qq:group:123", content: "已完成" });
    assert.equal(sent_.ok, true);
    assert.deepEqual(sent, [{ to: "qq:group:123", content: "已完成" }]);
  });

  it("answers tool_search about an external tool, and says where it comes from", async () => {
    const lint: ExternalTool = {
      name: "dsh_lint",
      description: "检查一段配置是否合法。",
      parameters: {},
      execute: async (request) => ({ callId: request.callId, ok: true, content: "" }),
    };
    const { catalog } = await harness({ external: [lint] });
    // An exact name first.
    const exact = await run(catalog, "tool_search", { keywords: "dsh_lint" });
    assert.ok(exact.content.includes("dsh_lint：检查一段配置是否合法。（来自dsh）"));
    // Then a prefix, then a description.
    const prefix = await run(catalog, "tool_search", { keywords: "dsh_" });
    assert.ok(prefix.content.includes("dsh_lint"));
    const described = await run(catalog, "tool_search", { keywords: "配置是否合法" });
    assert.ok(described.content.includes("dsh_lint"));
    // The tools list writes the same line, so the model reads one fact twice at
    // most.
    const listed = catalog.tools().find((tool) => tool.name === "dsh_lint");
    assert.equal(listed?.source, "dsh");
  });

  it("runs a script that chains module calls and bounds its output", async () => {
    const { catalog, journal } = await harness();
    await journal.append({ kind: "input", window: "c1", body: "第一批" });
    await journal.append({ kind: "input", window: "c1", body: "第二批" });
    const result = await run(catalog, "code_exec", {
      script: "const page = await journal.search({ query: '批' }); return page",
    });
    assert.equal(result.ok, true);
    assert.ok(result.content.includes("第一批"));
    assert.ok(result.content.includes("第二批"));
  });

  it("reports a failing script with the rule and the next action", async () => {
    const { catalog } = await harness();
    const result = await run(catalog, "code_exec", { script: "throw new Error('boom')" });
    assert.equal(result.ok, false);
    assert.equal(result.error?.rule, "script.failed");
    assert.ok(result.error?.message.includes("boom"));
  });

  it("reads, writes and edits in the window's own workspace, and an absolute path anywhere", async () => {
    const { catalog, root, refOf } = await harness();
    const written = await run(catalog, "write", { path: "src/app.ts", text: "export const a = 1" });
    assert.equal(written.ok, true);
    const read = await run(catalog, "read", { path: "src/app.ts" });
    assert.ok(read.content.includes("export const a = 1"));
    assert.equal(refOf("c1"), "ws1");
    assert.equal(await readFile(join(root, "ws1", "src", "app.ts"), "utf8"), "export const a = 1");

    const edited = await run(catalog, "edit", { path: "src/app.ts", old: "a = 1", new: "a = 2" });
    assert.equal(edited.ok, true);
    assert.equal(await readFile(join(root, "ws1", "src", "app.ts"), "utf8"), "export const a = 2");

    const missing = await run(catalog, "edit", { path: "src/app.ts", old: "nothing", new: "x" });
    assert.equal(missing.ok, false);
    assert.equal(missing.error?.rule, "edit.no_match");

    // Nothing refuses a path outside the window's own directory: the owner asked
    // for no restriction, and the prompt text alone says a directory belongs to
    // another window.
    const outsideRoot = await mkdtemp(join(tmpdir(), "arbor-tools-outside-"));
    try {
      const target = join(outsideRoot, "escape.txt");
      const escaped = await run(catalog, "write", { path: target, text: "outside the workspace" });
      assert.equal(escaped.ok, true);
      assert.equal(await readFile(target, "utf8"), "outside the workspace");
      const readOutside = await run(catalog, "read", { path: target });
      assert.ok(readOutside.content.includes("outside the workspace"));
    } finally {
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });

  it("runs bash in the workspace and follows a long command with bash_output", async () => {
    const { catalog, root, refOf } = await harness();
    // A command that ends early is answered when it ends, not when the default
    // wait runs out.
    const started = Date.now();
    const short = await run(catalog, "bash", { command: "pwd && echo hello" });
    assert.ok(Date.now() - started < 5000, "a short command does not wait out the default wait");
    assert.equal(short.ok, true);
    assert.ok(short.content.includes(root));
    assert.ok(short.content.includes("hello"));
    assert.equal(refOf("c1"), "ws1");
    assert.equal(refOf("c1"), "ws1");

    const long = await run(catalog, "bash", { command: "echo begun; sleep 5; echo done", timeout: 500 });
    const job = /b\d+/.exec(long.content)?.[0] ?? "";
    assert.notEqual(job, "");
    const running = await run(catalog, "bash_output", { job });
    assert.equal(running.ok, true);
    assert.ok(running.content.includes("仍在运行"));
    assert.ok(running.content.includes("begun"), "a running job shows what it has written so far");
    const stopped = await run(catalog, "bash_stop", { job });
    assert.ok(stopped.content.includes("已停止"));
    const missing = await run(catalog, "bash_output", { job: "b999" });
    assert.equal(missing.ok, false);
    assert.equal(missing.error?.rule, "bash.job.not_found");
  });

  it("gives a command the host's environment and the window's directory", async () => {
    const { catalog, root } = await harness();
    // A variable the host carries and no configuration named.
    process.env.ARBOR_TEST_HOST_ONLY = "host-only";
    try {
      const result = await run(catalog, "bash", { command: "env", timeout: 5000 });
      assert.equal(result.ok, true);
      const reported = Object.fromEntries(
        result.content
          .split("\n")
          .filter((line) => line.includes("="))
          .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
      ) as Record<string, string>;
      // The host's environment, and the window's own directory.
      assert.ok(reported.PATH !== undefined, "a command can find programs");
      assert.ok(reported.HOME !== undefined);
      assert.equal(reported.ARBOR_WORKSPACE, join(root, "ws1"), "the workspace is the window's own directory");
      // The host's own environment is inherited; the scrub, not the
      // environment, keeps a secret value from the model.
      assert.equal(reported.ARBOR_TEST_HOST_ONLY, "host-only", "the host's own environment is inherited");
    } finally {
      delete process.env.ARBOR_TEST_HOST_ONLY;
    }
  });

  it("cuts every tool's result once, at the one exit they all leave by", async () => {
    const { catalog } = await harness();
    // `bash` bounds nothing of its own: the cut is the catalog's, and it is the
    // only one (docs/prompting.md#information-density).
    const big = await run(catalog, "bash", { command: "head -c 30000 /dev/zero | tr '\\0' x" });
    assert.equal(big.ok, true);
    assert.ok(big.content.includes("输出已截断"));
    assert.ok(big.content.length < 25000);
    // A result inside the limit is left exactly as the tool wrote it.
    const small = await run(catalog, "bash", { command: "echo hello" });
    assert.equal(small.content.trim(), "hello");
  });

  it("reports the active set's budget with a note write", async () => {
    const { catalog, written } = await harness();
    const result = await run(catalog, "note_write", { title: "部署", body: "先灰度，再全量", refs: ["r12"] });
    assert.equal(result.ok, true);
    assert.ok(result.content.includes("已写入 n1@1"));
    assert.ok(result.content.includes("活跃笔记约 4/10 token"));
    assert.ok(result.content.includes("还可新建 0 条"));
    // The refs the write named reach the store, which links them to the note.
    assert.deepEqual(written[0]?.input.refs, ["r12"]);
  });

  it("says what one search covered, and that there is more", async () => {
    const { catalog } = await harness();
    const result = await run(catalog, "search", { query: "部署" });
    assert.equal(result.ok, true);
    assert.ok(result.content.includes("共 1 条。"));
    assert.ok(result.content.includes("范围：journal"));
    // Nothing was cut, so no 还有 line is written.
    assert.ok(!result.content.includes("还有"));
  });

  it("lists, greps and finds files through the workspace module", async () => {
    const { catalog, refOf } = await harness();
    await run(catalog, "write", { path: "src/a.ts", text: "const deploy = 1" });
    await run(catalog, "write", { path: "src/b.ts", text: "const other = 2" });
    assert.equal(refOf("c1"), "ws1");
    const ls = await run(catalog, "workspace.ls", { path: "src" });
    assert.ok(ls.content.includes("a.ts"));
    const grep = await run(catalog, "workspace.grep", { pattern: "deploy" });
    assert.ok(grep.content.includes("src/a.ts:1:const deploy = 1"));
    const find = await run(catalog, "workspace.find", { name: "b.ts" });
    assert.ok(find.content.includes("src/b.ts"));
  });

  it("sets a board line and an expectation for this window", async () => {
    const { catalog } = await harness();
    const set = await run(catalog, "board.set", { line: "修 CI" });
    assert.equal(set.ok, true);
    const list = await run(catalog, "board.list", {});
    assert.ok(list.content.includes("修 CI"));
    const expect = await run(catalog, "board.expect", { item: "gh:pr:57" });
    assert.equal(expect.content, "m1");
  });

  it("lists the tasks the host dispatched and shows one with the events it batched", async () => {
    const { catalog, journal, batched } = await harness();
    const input = await journal.append({ kind: "input", body: "CI 红了", targets: ["gh:pr:57"] });
    batched.set("t2", [input]);

    const list = await run(catalog, "tasks.list", {});
    assert.ok(list.content.includes("t2"), "the newest task is listed");
    assert.ok(list.content.includes("a scheduled check"));
    const one = await run(catalog, "tasks.list", { limit: 1 });
    assert.ok(one.content.includes("t2"));
    assert.ok(!one.content.includes("t1"), "the bound keeps the newest one");

    const shown = await run(catalog, "tasks.show", { ref: "t2" });
    assert.ok(shown.content.includes("a scheduled check"));
    assert.ok(shown.content.includes(`${input.ref} input CI 红了`), "the batch's events come with it");
    const several = await run(catalog, "tasks.show", { ref: ["t1", "t9"] });
    assert.ok(several.content.includes("a message arrived in qq:group:1"));
    assert.ok(!several.content.includes("t9"), "a ref that names no task is left out");
  });

  it("creates, updates and cancels a scheduled task through one service call each", async () => {
    const { catalog, created, changed, cancelled } = await harness();

    const made = await run(catalog, "schedule.create", {
      name: "每日汇总",
      firstAt: 1_700_000_000_000,
      repeat: { everyMs: 3_600_000 },
      targets: ["gh:pr:57"],
      task: { reason: "a scheduled check", targets: ["gh:pr:57"], content: [{ kind: "data", fields: { content: "到点了" } }] },
    });
    assert.equal(made.ok, true);
    assert.ok(made.content.includes("t9"));
    assert.deepEqual(created, [
      {
        firstAt: 1_700_000_000_000,
        name: "每日汇总",
        repeat: { everyMs: 3_600_000 },
        targets: ["gh:pr:57"],
        // The task's own time defaults to the firing's, so a script names only
        // what the task says.
        task: {
          reason: "a scheduled check",
          targets: ["gh:pr:57"],
          time: 1_700_000_000_000,
          content: [{ kind: "data", fields: { content: "到点了" } }],
        },
      },
    ]);

    const list = await run(catalog, "schedule.list", {});
    assert.ok(list.content.includes("t5"));
    assert.ok(list.content.includes("每日汇总"));
    assert.ok(list.content.includes("每 3600000 ms"));

    const updated = await run(catalog, "schedule.update", { ref: "t5", name: "改名后的汇总" });
    assert.equal(updated.ok, true);
    assert.deepEqual(changed, [{ ref: "t5", changes: { name: "改名后的汇总" } }], "only what it named changes");

    const stopped = await run(catalog, "schedule.cancel", { ref: "t5" });
    assert.equal(stopped.ok, true);
    assert.ok(stopped.content.includes("不再触发"));
    assert.deepEqual(cancelled, ["t5"]);
  });

  it("refuses a schedule create it cannot read, and an update of a ref that names none", async () => {
    const { catalog } = await harness();
    const noTime = await run(catalog, "schedule.create", {
      task: { reason: "a check", content: [{ kind: "data", fields: { content: "x" } }] },
    });
    assert.equal(noTime.ok, false);
    assert.equal(noTime.error?.rule, "schedule.input.invalid");
    assert.ok(noTime.error?.message.includes("firstAt"));
    assert.ok(noTime.error?.nextAction !== undefined && noTime.error.nextAction.length > 0);

    const badRepeat = await run(catalog, "schedule.create", {
      firstAt: 1_700_000_000_000,
      repeat: { hourly: true },
      task: { reason: "a check", content: [{ kind: "data", fields: { content: "x" } }] },
    });
    assert.equal(badRepeat.error?.rule, "schedule.input.invalid");
    assert.ok(badRepeat.error?.message.includes("repeat"));

    const missing = await run(catalog, "schedule.update", { ref: "t404", name: "改名" });
    assert.equal(missing.ok, false);
    assert.equal(missing.error?.rule, "schedule.not_found");
    assert.ok(missing.error?.nextAction?.includes("schedule.list"));
  });

  it("runs the tasks and schedule modules from a script, through the same service calls", async () => {
    const { catalog, cancelled } = await harness();
    const result = await run(catalog, "code_exec", {
      script:
        "await schedule.cancel({ ref: 't5' });" +
        "const page = await tasks.list({ limit: 1 });" +
        "return page",
    });
    assert.equal(result.ok, true);
    assert.ok(result.content.includes("a scheduled check"));
    assert.deepEqual(cancelled, ["t5"]);
  });

  it("sends a message to another live window and lists the live windows", async () => {
    const { catalog } = await harness();
    const list = await run(catalog, "windows.list", {});
    assert.ok(list.content.includes("c2"));
    const message = await run(catalog, "windows.send", { to: "c2", text: "CI 红了" });
    assert.equal(message.ok, true);
    assert.ok(message.content.includes("消息 m10 已发送给 c2"));
    const inbox = await run(catalog, "windows.inbox", {});
    assert.equal(inbox.ok, true);
  });

  it("reaches a workspace the implementation owns through its own capabilities", async () => {
    const { catalog } = await harness();
    const files = new Map<string, string>([["notes/a.txt", "deploy is done"]]);
    const commands: string[] = [];
    const owned: WorkspaceMount = {
      ref: "ws1",
      path: "/sandbox/ws1",
      exec: async (command: string) => {
        commands.push(command);
        if (command.startsWith("ls ")) return { exitCode: 0, stdout: "a.txt\n", stderr: "", truncated: false };
        if (command.startsWith("grep ")) {
          return { exitCode: 0, stdout: "notes/a.txt:1:deploy is done\n", stderr: "", truncated: false };
        }
        return { exitCode: 0, stdout: "hello\n", stderr: "", truncated: false };
      },
      readFile: async (path: string) => files.get(path) ?? null,
      writeFile: async (path: string, text: string) => {
        files.set(path, text);
      },
      release: async () => {},
    };
    // The mount the service layer hands the tools is the implementation's own.
    const services = (catalog as unknown as { services: ToolServices }).services;
    services.ensureWorkspace = async () => owned;

    const bash = await run(catalog, "bash", { command: "echo hello" });
    assert.deepEqual(commands, ["echo hello"]);
    assert.equal(bash.content.trim(), "hello");

    const written = await run(catalog, "write", { path: "notes/b.txt", text: "second" });
    assert.equal(written.ok, true);
    assert.equal(files.get("notes/b.txt"), "second");

    const read = await run(catalog, "read", { path: "notes/a.txt" });
    assert.ok(read.content.includes("deploy is done"));

    const missing = await run(catalog, "read", { path: "notes/none.txt" });
    assert.equal(missing.ok, false);
    assert.equal(missing.error?.rule, "file.not_found");

    const ls = await run(catalog, "workspace.ls", { path: "notes" });
    assert.ok(commands.some((command) => command.startsWith("ls ")));
    assert.ok(ls.content.includes("a.txt"));

    const grep = await run(catalog, "workspace.grep", { pattern: "deploy" });
    assert.ok(grep.content.includes("notes/a.txt:1:deploy is done"));
  });

  it("stages the environment into a mount that owns its execution environment", async () => {
    const { catalog } = await harness();
    const directory = await mkdtemp(join(tmpdir(), "arbor-env-"));
    await mkdir(join(directory, "skills", "deploy"), { recursive: true });
    await writeFile(join(directory, "skills", "deploy", "SKILL.md"), "# deploy\n", "utf8");
    await writeFile(join(directory, "settings.json"), '{"identity":"arbor"}\n', "utf8");
    const commands: string[] = [];
    const staged: { prefix: string; files: readonly { path: string; text: string }[] }[] = [];
    const owned: WorkspaceMount = {
      ref: "ws1",
      path: "/workspaces/1-1",
      exec: async (command: string) => {
        commands.push(command);
        return { exitCode: 0, stdout: "", stderr: "", truncated: false };
      },
      stage: async (prefix: string, files) => {
        staged.push({ prefix, files });
        return "/tmp/arbor-env/1-1";
      },
      release: async () => {},
    };
    const services = (catalog as unknown as { services: ToolServices }).services;
    services.ensureWorkspace = async () => owned;
    services.envPaths = () => ({ prefix: "/env", directory });
    const bash = (command: string, revision: string): Promise<ToolResult> =>
      catalog.call({ name: "bash", args: { command, timeout: 5 }, callId: "call_1" }, { window: "c1", envRevision: revision });

    // The command runs where the host's directory is not visible, so the
    // environment is staged into the mount and the prefix is rewritten onto
    // where it landed - the model still writes `/env`.
    const first = await bash("cat /env/settings.json", "e1");
    assert.equal(first.ok, true);
    assert.deepEqual(commands, ["cat /tmp/arbor-env/1-1/settings.json"]);
    assert.deepEqual(staged.map((one) => one.prefix), ["/env"]);
    assert.deepEqual(
      staged[0]?.files.map((file) => ({ path: file.path, text: file.text })),
      [
        { path: "settings.json", text: '{"identity":"arbor"}\n' },
        { path: "skills/deploy/SKILL.md", text: "# deploy\n" },
      ],
    );

    // The same revision stages once: the mount keeps what it staged.
    await bash("cat /env/settings.json", "e1");
    assert.equal(staged.length, 1);

    // A `reload` lands as a new revision, so the next command stages again and
    // the window reads what the environment holds now.
    await bash("cat /env/settings.json", "e2");
    assert.equal(staged.length, 2);
    assert.deepEqual(commands.at(-1), "cat /tmp/arbor-env/1-1/settings.json");

    // A mount whose `path` is a host path reaches the directory itself.
    const hostDir: WorkspaceMount = { ...owned, stage: undefined };
    services.ensureWorkspace = async () => hostDir;
    await bash("cat /env/settings.json", "e1");
    assert.deepEqual(commands.at(-1), `cat ${directory}/settings.json`);
    assert.equal(staged.length, 2);

    await rm(directory, { recursive: true, force: true });
  });

  it("writes memory through the note tools, with the host filling the anchor", async () => {
    const { catalog, written } = await harness();
    const tools = catalog.tools().map((tool) => tool.name);
    assert.ok(tools.includes("note_write"));
    assert.ok(tools.includes("note_replace"));
    assert.ok(tools.includes("note_delete"));

    const created = await run(catalog, "note_write", {
      title: "部署",
      summary: "上线步骤",
      body: "先灰度，再全量",
    });
    assert.equal(created.ok, true);
    assert.equal(written.length, 1);
    assert.equal(written[0]?.window, "c1");
    assert.equal(written[0]?.input.title, "部署");
    // The group never declares an anchor: the service layer fills it in.
    assert.equal(written[0]?.input.anchor, undefined);

    const replaced = await run(catalog, "note_replace", {
      id: "n1",
      revision: 1,
      title: "部署",
      body: "先灰度，再全量，最后回滚",
    });
    assert.equal(replaced.ok, true);
    assert.equal(written[1]?.input.replace, true);
    assert.equal(written[1]?.input.expectedRevision, 1);

    const removed = await run(catalog, "note_delete", { id: "n1", revision: 2 });
    assert.equal(removed.ok, true);
    assert.equal(written[2]?.input.delete, true);
    // A delete answers its own line: it removed a note rather than writing one.
    assert.match(removed.content, /^已删除 n1@1/);
  });

  it("omits the note tools when no NoteStore is configured", async () => {
    const { catalog } = await harness({ notes: false });
    const tools = catalog.tools().map((tool) => tool.name);
    assert.ok(!tools.includes("note_write"));
    const result = await run(catalog, "note_write", { title: "x", body: "y" });
    assert.equal(result.ok, false);
    assert.equal(result.error?.rule, "tool.unknown");
  });

  it("renders a refusal as the renderer's error block, so the model reads the rule", async () => {
    const { catalog } = await harness();
    const renderer = new Renderer();
    const result = await run(catalog, "send", { to: "", content: "x" });
    const text = renderer.render([
      {
        kind: "error",
        fields: {
          tool: "send",
          rule: result.error?.rule ?? "",
          message: result.error?.message ?? "",
          ...(result.error?.nextAction === undefined ? {} : { next: result.error.nextAction }),
        },
      },
    ]);
    assert.ok(text.includes("send.target.empty"));
    assert.ok(text.includes("下一步"));
  });
});

/**
 * One channel with two connections and one message, for the channels module.
 * It keeps its own copy, so `stored` says the channel is not live.
 */
function fakeChannel(): Channel {
  return {
    id: "http",
    connections: async () => [
      { id: "http", online: true, detail: "http://127.0.0.1:8787" },
      { id: "http:demo", online: false },
    ],
    get: async (nativeId) => {
      if (nativeId !== "http:42") return null;
      return {
        external: "http:42",
        source: "http",
        target: "http:demo",
        time: 1700000000000,
        content: [dataBlock("部署流程是什么")],
        replyTo: "http:41",
        stored: true,
      };
    },
  };
}

/** A note store with one note, for the notes module. */
function notesStore(): NoteStore {
  const note = {
    ref: "n1@1" as const,
    id: "n1" as const,
    title: "部署",
    summary: "上线步骤",
    body: "先灰度，再全量",
    status: "active" as const,
    revision: 1,
    time: 1,
    window: "c1" as const,
  };
  return {
    write: async () => note,
    read: async () => ({ ref: note.ref, revision: 1, body: note.body ?? "", total: 9, nextCall: "notes.read(n1)" }),
    revisions: async () => ({ items: [], total: 0, limit: 20, nextCall: "" }),
    search: async () => ({ items: [note], total: 1, limit: 20, nextCall: "" }),
    active: async () => ({ items: [note], total: 1, limit: 20, nextCall: "" }),
    context: async () => ({ ref: note.ref, revision: 1, events: ["r1"], evidence: [] }),
    snapshot: async () => ({
      epoch: 1,
      time: 1,
      items: [note],
      total: 1,
      limit: 20,
      nextCall: "notes.active()",
      budget: { count: 1, tokens: 10 },
      tokens: 4,
    }),
    delta: async () => ({ since: 1, epoch: 1, items: [], total: 0, limit: 20, nextCall: "" }),
    score: async () => ({ items: [], total: 0, limit: 20, nextCall: "" }),
    recordUse: async () => {},
    close: async () => {},
  };
}
