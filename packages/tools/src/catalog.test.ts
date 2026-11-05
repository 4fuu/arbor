import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { SqliteJournal } from "@arbor/journal-sqlite";
import { DirectoryWorkspace } from "@arbor/workspace-dir";
import type { CallContext, NoteStore, NoteWriteInput, ToolResult, WorkspaceMount } from "@arbor/interfaces";
import { Renderer, zhTextTable } from "@arbor/prompt";
import { ToolCatalog } from "./catalog.ts";
import type { LiveWindow, ToolServices } from "./host.ts";
import { handoffOf } from "./groups/core.ts";

interface Harness {
  catalog: ToolCatalog;
  journal: SqliteJournal;
  root: string;
  workspace: DirectoryWorkspace;
  ended: { window: string; handoff?: unknown }[];
  sent: { to: string; content: string }[];
  written: { window: string; input: NoteWriteInput }[];
  /** The workspace ref the window's first file call created. */
  refOf(window: string): string;
}

async function harness(options: { notes?: boolean } = {}): Promise<Harness> {
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

  const services: ToolServices = {
    table: zhTextTable,
    journal,
    ...(options.notes === false ? {} : { notes: notesStore() }),
    workspace,
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

    envPaths: () => undefined,
    envCatalog: () => ({ items: [], modules: [], removed: [] }),
    envItemAt: async () => undefined,
    envRead: () => {},
    reload: async () => ({ revision: "e1", changes: [], delivered: 0 }),
    callMcp: async () => "",
  };

  const catalog = new ToolCatalog({ services });
  const refs = new Map<string, string>();
  return {
    catalog,
    journal,
    root,
    workspace,
    ended,
    sent,
    written,
    refOf: (window: string) => refs.get(window) ?? "",
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
      assert.deepEqual(modules, ["journal", "windows", "board", "notes", "workspace"]);
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
    const one = await run(catalog, "tool_search", { keywords: "journal.search" });
    assert.ok(one.content.includes("journal.search(query, options?)"));
    const none = await run(catalog, "tool_search", { keywords: "zzz" });
    assert.equal(none.ok, true);
    assert.ok(none.content.length > 0);
  });

  it("refuses a script that names a direct tool, and never reaches the host", async () => {
    const { catalog, sent } = await harness();
    const result = await run(catalog, "code_exec", { script: "send('qq:1', 'hi')" });
    assert.equal(result.ok, false);
    assert.equal(result.error?.rule, "script.decision_tool");
    assert.ok(result.error?.message.includes("send"));
    assert.equal(sent.length, 0);
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

  it("reads, writes and edits inside the window's own workspace only", async () => {
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

    const outside = await run(catalog, "write", { path: "../escape.txt", text: "x" });
    assert.equal(outside.ok, false);
    assert.equal(outside.error?.rule, "file.outside_workspace");
  });

  it("runs bash in the workspace and follows a long command with bash_output", async () => {
    const { catalog, root, refOf } = await harness();
    const short = await run(catalog, "bash", { command: "pwd && echo hello", timeout: 5000 });
    assert.equal(short.ok, true);
    assert.ok(short.content.includes(root));
    assert.ok(short.content.includes("hello"));
    assert.equal(refOf("c1"), "ws1");
    assert.equal(refOf("c1"), "ws1");

    const long = await run(catalog, "bash", { command: "sleep 5; echo done", timeout: 50 });
    const job = /b\d+/.exec(long.content)?.[0] ?? "";
    assert.notEqual(job, "");
    const running = await run(catalog, "bash_output", { job });
    assert.equal(running.ok, true);
    assert.ok(running.content.includes("仍在运行"));
    const stopped = await run(catalog, "bash_stop", { job });
    assert.ok(stopped.content.includes("已停止"));
    const missing = await run(catalog, "bash_output", { job: "b999" });
    assert.equal(missing.ok, false);
    assert.equal(missing.error?.rule, "bash.job.not_found");
  });

  it("snapshots the directory at the event a write is recorded at", async () => {
    const { catalog, workspace, refOf } = await harness();
    await run(catalog, "write", { path: "a.txt", text: "one" });
    const ref = refOf("c1");
    assert.equal(ref, "ws1");
    const handle = await workspace.snapshot(ref as `ws${number}`, "r902");
    await run(catalog, "write", { path: "a.txt", text: "two" });
    const mount = await workspace.mount(handle.ref);
    assert.equal(await readFile(join(mount.path, "a.txt"), "utf8"), "one");
    await mount.release();
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
      readOnly: false,
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
    }),
    delta: async () => ({ since: 1, epoch: 1, items: [], total: 0, limit: 20, nextCall: "" }),
    score: async () => ({ items: [], total: 0, limit: 20, nextCall: "" }),
    recordUse: async () => {},
    close: async () => {},
  };
}
