import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { SqliteJournal } from "@4fu/arbor-journal-sqlite";
import { DirectoryEnvironment } from "@4fu/arbor-environment-dir";
import { DirectoryWorkspace } from "@4fu/arbor-workspace-dir";
import type { Effect, Judge, JudgeAnswer, JudgeRequest } from "@4fu/arbor-interfaces";
import type { CallContext, DirectToolSpec, Settings, ToolCall, ToolGroup, ToolResult } from "@4fu/arbor-interfaces";
import type {
  OutsideEvent,
  Plugin,
  TaskInput,
  TaskSource,
  Unsubscribe,
} from "@4fu/arbor-interfaces";
import { Arbor } from "./host.ts";
import { RefAllocator } from "./refs.ts";
import { ManualTimers, ScriptedBackend, turn } from "./testing.ts";
import { textOf, zhTextTable } from "@4fu/arbor-prompt";

/**
 * A judge that answers nothing, so a test never reaches a service. Every
 * decision falls back to its own rule default, which is what a test that is not
 * about the judge wants.
 */
class QuietJudge implements Judge {
  readonly name = "quiet";

  async decide(request: JudgeRequest): Promise<JudgeAnswer> {
    if (request.decision === "filter") return { decision: "filter", needsHandling: true };
    if (request.decision === "model_tier") return { decision: "model_tier", tier: "" };
    if (request.decision === "route") {
      return { decision: "route", scores: [{ item: "new", score: 3 }], best: "new" };
    }
    if (request.decision === "notice" || request.decision === "broadcast") {
      return {
        decision: request.decision,
        windows: request.state.candidates.map((candidate) => ({ window: candidate.window, needs: true })),
      };
    }
    return { decision: "active_set", keep: [], drop: [] };
  }
}

/** Let the host's watchers run, so a test observes what it recorded. */
async function settle(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await turn();
}

/** A tool group a test owns, so a call's result is exactly what it scripts. */
class ProbeGroup implements ToolGroup {
  readonly id = "probe";
  readonly calls: ToolCall[] = [];
  /** The revision of the environment each call was made against. */
  readonly revisions: (string | undefined)[] = [];

  tools(): readonly DirectToolSpec[] {
    return [
      {
        name: "probe",
        description: "一个测试用的工具。",
        parameters: { text: { type: "string", description: "内容", required: true } },
      },
    ];
  }

  modules(): readonly [] {
    return [];
  }

  async call(request: ToolCall, context: CallContext): Promise<ToolResult> {
    this.calls.push(request);
    this.revisions.push(context.envRevision);
    return { callId: request.callId, ok: true, content: "探测完成" };
  }
}

/** One scripted window: the host sees a backend it can drive by hand. */
async function host(
  options: {
    workspace?: boolean;
    environment?: boolean;
    /** The retention period the host reclaims a chain's directory after. */
    retentionMs?: number;
    now?: () => number;
    plugins?: readonly Plugin[];
    /** The settings the host runs with, secrets included. */
    settings?: Settings;
    /** The judge the host routes with. Defaults to one that answers nothing. */
    judge?: Judge;
    /** Where a named secret's value comes from. */
    secretOf?: (name: string) => string | undefined;
    /** Extra tool groups, from a plugin. */
    groups?: readonly ToolGroup[];
  } = {},
): Promise<{
  arbor: Arbor;
  journal: SqliteJournal;
  timers: ManualTimers;
  backend: ScriptedBackend;
  probe: ProbeGroup;
  root: string;
  environment?: DirectoryEnvironment;
}> {
  const journal = new SqliteJournal({ path: ":memory:" });
  const timers = new ManualTimers();
  const root = await mkdtemp(join(tmpdir(), "arbor-core-"));
  const backend = new ScriptedBackend();
  const probe = new ProbeGroup();
  const environment = options.environment === true ? new DirectoryEnvironment({ root }) : undefined;
  const arbor = new Arbor({
    journal,
    backend,
    timers,
    now: options.now ?? (() => 1700000000000),
    judge: options.judge ?? new QuietJudge(),
    ...(options.workspace === false ? {} : { workspace: new DirectoryWorkspace({ root }) }),
    ...(environment === undefined ? {} : { environment }),
    ...(options.retentionMs === undefined ? {} : { settings: { workspaces: { retentionMs: options.retentionMs } } }),
    ...(options.settings === undefined ? {} : { settings: options.settings }),
    ...(options.secretOf === undefined ? {} : { secretOf: options.secretOf }),
    ...(options.plugins === undefined ? {} : { plugins: options.plugins }),
    groups: [...(options.groups ?? []), probe],
  });
  backend.attach(arbor.windowControl());
  return { arbor, journal, timers, backend, probe, root, ...(environment === undefined ? {} : { environment }) };
}

const task = {
  kind: "batch" as const,
  reason: "查看 CI 结果",
  targets: ["gh:pr:57"],
  time: 1700000000000,
  content: [{ kind: "data" as const, fields: { content: "CI 红了" } }],
};

describe("one window end to end", () => {
  it("opens a window, records its start and its tool calls, and ends it", async () => {
    const { arbor, journal, backend } = await host();
    backend.script([
      { tool: "probe", args: { text: "CI" } },
      { text: "CI 红了两次" },
    ]);
    const record = await arbor.open(task);
    assert.equal(record.window, "c1");
    await backend.finished();
    await arbor.end(record.window);
    await backend.finished();

    const started = await journal.list({ kinds: ["window_start"] });
    assert.equal(started.items.length, 1);
    assert.equal(started.items[0]?.window, "c1");
    assert.ok(started.items[0]?.targets.includes("gh:pr:57"));
    const calls = await journal.list({ kinds: ["tool_call"] });
    assert.equal(calls.items.length, 1);
    assert.equal(calls.items[0]?.window, "c1");
    const results = await journal.list({ kinds: ["tool_result"] });
    assert.equal(results.items.length, 1);
    assert.equal(results.items[0]?.body, "探测完成");
    const ended = await journal.list({ kinds: ["window_end"] });
    assert.equal(ended.items.length, 1);
    assert.equal(JSON.parse(ended.items[0]?.body ?? "{}").reason, "model_ended");
  });

  it("writes through the window's own directory, and records no snapshot id on any event", async () => {
    const { arbor, journal, backend, root } = await host();
    backend.script([
      { tool: "write", args: { path: "a.txt", text: "one" } },
      { text: "完成" },
    ]);
    const record = await arbor.open(task);
    await backend.finished();
    await arbor.end(record.window);
    await backend.finished();
    const results = await journal.list({ kinds: ["tool_result"] });
    assert.equal(results.total, 1);
    assert.ok(results.items[0]?.body?.includes("已写入 a.txt"));
    // The directory was created for the window, under the root the host named.
    assert.equal(await readFile(join(root, "ws1", "a.txt"), "utf8"), "one");
    // No event carries a snapshot id: the directory is the only state a file
    // call leaves, and nothing names a state of it.
    for (const event of (await journal.list({ window: record.window })).items) {
      assert.equal("snapshot" in event, false);
      assert.ok(!event.refs.some((ref) => /^ws\d+@/.test(ref)));
    }
  });

  it("gives every call the environment's revision, so a live window reads what it holds now", async () => {
    const { arbor, backend, probe, root, environment } = await host({ environment: true });
    assert.ok(environment !== undefined);
    // One skill is installed before the window opens.
    const draft = join(root, "draft");
    await mkdir(draft, { recursive: true });
    await writeFile(join(draft, "SKILL.md"), "# deploy\n\n部署。\n\n1. 读这个文件。\n", "utf8");
    await environment.install([{ kind: "skill", name: "deploy", path: draft }]);
    const before = await environment.revision();

    backend.script([{ tool: "probe", args: { text: "第一轮" } }, { text: "完成" }]);
    const record = await arbor.open(task);
    await backend.finished();
    assert.equal(probe.revisions[0], before);

    // The environment changes while the window is live, and the call that runs
    // next carries the revision it holds then: what a command sees is staged
    // again for the revision it reads now.
    const second = join(root, "draft-2");
    await mkdir(second, { recursive: true });
    await writeFile(join(second, "SKILL.md"), "# rollback\n\n回滚。\n\n1. 读这个文件。\n", "utf8");
    await environment.install([{ kind: "skill", name: "rollback", path: second }]);
    const after = await environment.revision();

    backend.script([{ tool: "probe", args: { text: "第二轮" } }, { text: "完成" }]);
    await arbor.deliver(
      record.window,
      {
        kind: "inserted_task",
        refs: ["t2"],
        time: 1700000000000,
        content: [{ kind: "data", fields: { content: "继续处理" } }],
      },
      { targets: ["gh:pr:57"] },
    );
    await backend.finished();

    assert.equal(probe.revisions.length, 2);
    assert.equal(probe.revisions[1], after);
    assert.notEqual(before, after);
  });

  it("continues in the predecessor's directory, in place, so the work carries over", async () => {
    const { arbor, journal, backend, root } = await host();
    backend.script([
      { tool: "write", args: { path: "notes.txt", text: "work in progress" } },
      { text: "完成" },
    ]);
    const record = await arbor.open(task);
    await backend.finished();

    // The model ends with a handoff, so the host opens a continuation.
    backend.script([
      { tool: "read", args: { path: "notes.txt" } },
      { text: "读到了" },
    ]);
    await arbor.services.endWindow(record.window, {
      topics: ["CI"],
      progress: ["已写下结论"],
      pending: ["重跑"],
      agreements: ["先修测试"],
      refs: ["r1"],
    });
    await backend.finished();

    // The continuation reads what the window before it wrote.
    const read = await journal.list({ window: "c2", kinds: ["tool_result"] });
    assert.equal(read.total, 1);
    assert.ok(read.items[0]?.body?.includes("work in progress"));

    // It worked in the same directory, in place: no second directory was made,
    // and the chain's directory holds the file the first window wrote.
    assert.equal(await readFile(join(root, "ws1", "notes.txt"), "utf8"), "work in progress");
    assert.deepEqual(await readdir(root), ["ws1"]);
  });

  it("gives two unrelated windows directories that do not see each other", async () => {
    const { arbor, journal, backend, root } = await host();
    backend.script([{ tool: "write", args: { path: "a.txt", text: "first" } }, { text: "完成" }]);
    const first = await arbor.open(task);
    await backend.finished();
    await arbor.end(first.window);
    await backend.finished();

    backend.script([{ tool: "read", args: { path: "a.txt" } }, { text: "读不到" }]);
    const second = await arbor.open(task);
    await backend.finished();
    await arbor.end(second.window);
    await backend.finished();

    const read = await journal.list({ window: second.window, kinds: ["tool_result"] });
    assert.ok(read.items[0]?.body?.includes("file.not_found"));
    assert.deepEqual((await readdir(root)).sort(), ["ws1", "ws2"]);
    assert.equal(await readFile(join(root, "ws1", "a.txt"), "utf8"), "first");
  });

  it("makes no directory for a call that changes no file", async () => {
    const { arbor, journal, backend, root } = await host();
    backend.script([
      { tool: "probe", args: { text: "CI" } },
      { text: "完成" },
    ]);
    const record = await arbor.open(task);
    await backend.finished();
    await arbor.end(record.window);
    await backend.finished();
    const results = await journal.list({ kinds: ["tool_result"] });
    assert.equal(results.total, 1);
    assert.ok(results.items[0]?.body?.includes("探测完成"));
    // A window that never touches files has no directory.
    assert.deepEqual(await readdir(root), []);
  });

  it("sends the frozen prefix: arbor's system prompt and the memory snapshot", async () => {
    const { arbor, backend } = await host();
    backend.script([{ text: "完成" }]);
    await arbor.open(task);
    await backend.finished();
    const opened = backend.opened[0];
    assert.ok(opened !== undefined);
    assert.ok(opened.prompt.system.includes("<agent>"));
    assert.ok(opened.prompt.system.includes("窗口是一次性的"));
    assert.ok(opened.firstInput !== undefined && opened.firstInput.includes("CI 红了"));
    assert.ok(opened.firstInput.includes("任务 t1"));
    assert.ok(!opened.prompt.system.includes("coding agent"));
  });

  it("lists the direct tools and the modules the window was opened with", async () => {
    const { arbor, backend } = await host();
    backend.script([{ text: "完成" }]);
    await arbor.open(task);
    await backend.finished();
    const tools = backend.opened[0]?.tools.map((tool) => tool.name) ?? [];
    assert.ok(tools.includes("send"));
    assert.ok(tools.includes("probe"));
    assert.ok(tools.includes("end"));
    assert.ok(tools.includes("search"));
    assert.ok(tools.includes("bash"));
    assert.ok(tools.includes("code_exec"));
    const modules = backend.opened[0]?.modules.map((module) => module.name) ?? [];
    assert.deepEqual(modules, ["journal", "windows", "board", "tasks", "schedule", "workspace"]);
  });

  it("ends the window with a handoff and opens a continuation that carries it", async () => {
    const { arbor, journal, backend } = await host();
    backend.script([{ text: "继续" }]);
    const record = await arbor.open(task);
    // The model ends with a handoff, so the host opens the continuation.
    await arbor.services.endWindow(record.window, {
      topics: ["CI"],
      progress: ["已定位到失败的测试"],
      pending: ["重跑"],
      agreements: ["先修测试"],
      refs: ["r1"],
    });
    await backend.finished();
    // The end is settled by the window's own run, which opens the continuation,
    // so the run is what a test waits for before it reads the journal.
    await record.running;
    const started = await journal.list({ kinds: ["window_start"] });
    assert.equal(started.items.length, 2);
    const continuation = started.items[1];
    assert.equal(continuation?.window, "c2");
    assert.ok(continuation?.refs.includes("c1"));
    const opened = backend.opened[1];
    assert.ok(opened?.continuation?.previous === "c1");
    assert.ok(opened?.firstInput?.includes("上一个窗口 c1 的记录没有加载"));
    assert.ok(opened?.firstInput?.includes("原因：继续窗口 c1 未完成的工作。"));
    assert.ok(opened?.firstInput?.includes("当前话题：CI"));
    assert.ok(opened?.firstInput?.includes("本 agent 在上一个窗口 c1 中自己写下的交接内容"));
    assert.ok(opened?.firstInput?.includes("未完成的任务：t1"));
  });

  it("says there is no handoff and gives the order to recover", async () => {
    const { arbor, journal, backend } = await host();
    backend.script([{ text: "第一轮" }, { text: "第二轮" }]);
    await arbor.open(task);
    await backend.finished();
    // The host stopped without ending the window, so the restart continues it
    // with no handoff to carry.
    const reopened = new Arbor({ journal, backend, timers: new ManualTimers(), now: () => 1700000000000 });
    await reopened.start();
    await backend.finished();
    const opened = backend.opened[1];
    assert.ok(opened?.continuation?.previous === "c1");
    assert.ok(opened?.firstInput?.includes("上一个窗口 c1 没有留下交接内容"));
    assert.ok(opened?.firstInput?.includes("按此顺序恢复：笔记、现场板、它的最后事件"));
    assert.ok(opened?.firstInput?.includes("窗口 c1 在任务中途被重置"));
  });

  it("stops the windows on close without opening a continuation, and the next start continues the work", async () => {
    const { arbor, journal, backend, root } = await host();
    backend.script([
      { tool: "write", args: { path: "notes.txt", text: "work in progress" } },
      { text: "第一轮" },
    ]);
    const record = await arbor.open(task);
    await backend.finished();

    // `close` only releases resources: the window is stopped, and nothing opens
    // a continuation, so no second turn starts.
    await arbor.close();
    const started = await journal.list({ kinds: ["window_start"] });
    assert.equal(started.items.length, 1);
    assert.equal(backend.opened.length, 1);
    const ended = await journal.list({ kinds: ["window_end"] });
    assert.equal(ended.items.length, 1);
    assert.equal(ended.items[0]?.window, record.window);
    assert.equal(JSON.parse(ended.items[0]?.body ?? "{}").reason, "host_restart");
    assert.equal(arbor.live().length, 0);

    // The next start on the same journal continues the stopped window, the way
    // the restart section describes: in the directory it worked in, which the
    // window chain in the journal names.
    const reopened = new Arbor({
      journal,
      backend,
      timers: new ManualTimers(),
      now: () => 1700000000000,
      workspace: new DirectoryWorkspace({ root }),
    });
    backend.attach(reopened.windowControl());
    backend.script([
      { tool: "read", args: { path: "notes.txt" } },
      { text: "读到了" },
    ]);
    await reopened.start();
    await backend.finished();
    const continued = await journal.list({ kinds: ["window_start"] });
    assert.equal(continued.items.length, 2);
    assert.equal(continued.items[1]?.window, "c2");
    const opened = backend.opened[1];
    assert.ok(opened?.continuation?.previous === "c1");
    assert.ok(opened?.continuation?.midTaskReset === true);
    assert.ok(opened?.firstInput?.includes("窗口 c1 在任务中途被重置"));
    const read = await journal.list({ window: "c2", kinds: ["tool_result"] });
    assert.ok(read.items[0]?.body?.includes("work in progress"));
    assert.equal(await readFile(join(root, "ws1", "notes.txt"), "utf8"), "work in progress");
    assert.deepEqual(await readdir(root), ["ws1"]);
  });

  it("runs a module call from a script through the same service call", async () => {
    const { arbor, journal, backend } = await host();
    await journal.append({ kind: "input", window: "c1", body: "部署上线流程已确认", targets: ["qq:group:1"] });
    backend.script([
      { tool: "code_exec", args: { script: "return await journal.search({ query: '部署' })" } },
      { text: "完成" },
    ]);
    const record = await arbor.open(task);
    await backend.finished();
    await arbor.end(record.window);
    await backend.finished();
    const results = await journal.list({ kinds: ["tool_result"] });
    assert.ok(results.items[0]?.body?.includes("部署上线流程已确认"));
  });

  it("refuses a script that names a direct tool, and the host never sees the call", async () => {
    const { arbor, journal, backend } = await host();
    backend.script([
      { tool: "code_exec", args: { script: "send('qq:group:1', 'hi')" } },
      { text: "完成" },
    ]);
    const record = await arbor.open(task);
    await backend.finished();
    await arbor.end(record.window);
    await backend.finished();
    const results = await journal.list({ kinds: ["tool_result"] });
    assert.ok(results.items[0]?.body?.includes("script.decision_tool"));
    const sends = await journal.list({ kinds: ["send"] });
    assert.equal(sends.items.length, 0);
  });

  it("lists the notes module and its active set when a NoteStore is configured", async () => {
    const journal = new SqliteJournal({ path: ":memory:" });
    const { SqliteNoteStore } = await import("@4fu/arbor-notes-sqlite");
    const notes = new SqliteNoteStore({ path: ":memory:", journal });
    const timers = new ManualTimers();
    const backend = new ScriptedBackend();
    const arbor = new Arbor({
      journal,
      backend,
      timers,
      notes,
      now: () => 1700000000000,
      judge: new QuietJudge(),
    });
    backend.attach({
      recordToolCall: arbor.recordToolCall,
      runToolCall: arbor.runToolCall,
      endRequested: arbor.endRequested,
    });
    const note = await notes.write({ title: "部署", summary: "上线步骤", body: "先灰度，再全量" });
    // A note nobody used is not in the active set, so the host records the use
    // a window made of it.
    await notes.recordUse({ ref: note.ref, kind: "read", window: "c1" });
    backend.script([{ text: "完成" }]);
    await arbor.open(task);
    await backend.finished();
    const opened = backend.opened[0];
    assert.ok(opened?.modules.some((module) => module.name === "notes"));
    assert.ok(opened?.prompt.memory.includes("n1@1 部署"));
    const found = await arbor.search("灰度", ["notes"]);
    assert.equal(found.notes.length, 1);
    assert.equal(found.notes[0]?.title, "部署");
  });

  it("ends the window at its hard limit and continues with the mid-task reset", async () => {
    const { arbor, journal, backend } = await host();
    backend.script([
      { usage: { used: 190000, limit: 200000, reserve: 4000 } },
      { text: "继续" },
    ]);
    const record = await arbor.open(task);
    await backend.finished();
    // The hard limit ends the window inside its own run, which opens the
    // continuation, so the run is what a test waits for.
    await record.running;
    const ended = await journal.list({ kinds: ["window_end"] });
    assert.equal(ended.items[0]?.window, "c1");
    const body = JSON.parse(ended.items[0]?.body ?? "{}") as { reason: string };
    assert.equal(body.reason, "hard_limit");
    const opened = backend.opened[1];
    assert.ok(opened?.continuation?.midTaskReset === true);
    assert.ok(opened?.firstInput?.includes("窗口 c1 在任务中途被重置"));
    assert.ok(opened?.firstInput?.includes("已发送的内容不会再次发送"));
  });

  it("sends the reminder series, and only the highest crossed tier", async () => {
    const { arbor, journal, backend } = await host();
    backend.script([
      { usage: { used: 130000, limit: 200000, reserve: 4000 } },
      { text: "继续" },
    ]);
    await arbor.open(task);
    await backend.finished();
    const reminders = await journal.list({ kinds: ["reminder"] });
    assert.equal(reminders.items.length, 1);
    const body = reminders.items[0]?.body ?? "";
    assert.ok(body.includes("已用 130000/200000 tokens（65%）"));
    assert.ok(body.includes("第 4/7 条提醒"));
    assert.ok(body.includes("这是系统提醒，不是用户请求"));
    assert.ok(body.includes("写明边界"));
    // 80 % has not been crossed, so the cost of ignoring it is not said yet.
    assert.ok(!body.includes("如果不照做"));
  });

  it("sends every tier in order when the window crosses several thresholds", async () => {
    const { arbor, journal, backend } = await host();
    backend.script([
      { usage: { used: 30000, limit: 200000, reserve: 4000 } },
      { usage: { used: 70000, limit: 200000, reserve: 4000 } },
      { usage: { used: 130000, limit: 200000, reserve: 4000 } },
      { usage: { used: 165000, limit: 200000, reserve: 4000 } },
      { text: "继续" },
    ]);
    await arbor.open(task);
    await backend.finished();
    const reminders = await journal.list({ kinds: ["reminder"] });
    const bodies = reminders.items.map((item) => item.body ?? "");
    assert.equal(bodies.length, 4);
    assert.ok(bodies[0]?.includes("第 1/7 条提醒"));
    assert.ok(bodies[0]?.includes("还没有进展笔记的话"));
    assert.ok(bodies[1]?.includes("第 2/7 条提醒"));
    assert.ok(bodies[1]?.includes("更新进展笔记"));
    assert.ok(bodies[2]?.includes("第 4/7 条提醒"));
    assert.ok(bodies[2]?.includes("写明边界"));
    // From 80 % on, the reminder also says what ignoring it costs.
    assert.ok(bodies[3]?.includes("第 6/7 条提醒"));
    assert.ok(bodies[3]?.includes("再开新工作前先轮换"));
    assert.ok(bodies[3]?.includes("如果不照做"));
  });

  it("keeps an ended run open for a related input, then ends it when quiet", async () => {
    const { arbor, timers, backend } = await host();
    backend.script([{ text: "第一轮" }, { text: "第二轮" }]);
    const record = await arbor.open(task);
    await backend.finished();
    assert.equal(arbor.live()[0]?.state, "idle");
    // An input for the target the window started on enters even during its
    // protection period (docs/dispatch.md#insertion-timing).
    await arbor.deliver(
      record.window,
      {
        kind: "inserted_task",
        refs: ["t2"],
        time: 1700000000000,
        content: [{ kind: "data", fields: { content: "继续处理" } }],
      },
      { targets: ["gh:pr:57"] },
    );
    await backend.finished();
    const delivered = await arbor.journal.list({ kinds: ["delivery"] });
    assert.equal(delivered.items.length, 1);
    timers.fireAll();
    await backend.finished();
    const ended = await arbor.journal.list({ kinds: ["window_end"] });
    const last = ended.items.at(-1);
    assert.equal(JSON.parse(last?.body ?? "{}").reason, "idle_timeout");
  });

  it("rebuilds a running window from the journal after a restart", async () => {
    const { arbor, journal, backend, root } = await host();
    backend.script([
      { tool: "write", args: { path: "notes.txt", text: "work in progress" } },
      { text: "第一轮" },
    ]);
    const record = await arbor.open(task);
    await backend.finished();
    // The host stopped without ending the window: only window_start is there.
    const timers = new ManualTimers();
    const reopened = new Arbor({
      journal,
      backend,
      timers,
      now: () => 1700000000000,
      workspace: new DirectoryWorkspace({ root }),
    });
    // A restart is a new host, so the backend takes its control, the way pi does.
    backend.attach(reopened.windowControl());
    // The continued window works in the directory the stopped one worked in,
    // which the window chain in the journal names.
    backend.script([
      { tool: "read", args: { path: "notes.txt" } },
      { text: "读到了" },
    ]);
    await reopened.start();
    await backend.finished();
    const started = await journal.list({ kinds: ["window_start"] });
    assert.equal(started.items.length, 2);
    assert.equal(started.items[1]?.window, "c2");
    const opened = backend.opened[1];
    assert.ok(opened?.continuation?.midTaskReset === true);
    assert.ok(opened?.firstInput?.includes("窗口 c1 在任务中途被重置"));
    assert.equal(record.state, "idle");
    const read = await journal.list({ window: "c2", kinds: ["tool_result"] });
    assert.ok(read.items[0]?.body?.includes("work in progress"));
    assert.equal(await readFile(join(root, "ws1", "notes.txt"), "utf8"), "work in progress");
    assert.deepEqual(await readdir(root), ["ws1"]);
  });

  it("records a send as an effect and never repeats it in the continuation", async () => {
    const { arbor, journal, backend } = await host();
    backend.script([
      { tool: "send", args: { to: "qq:group:123", content: "已修好" } },
      { text: "完成" },
    ]);
    const record = await arbor.open(task);
    await backend.finished();
    await arbor.services.endWindow(record.window, {
      topics: ["CI"],
      progress: ["已发送结论"],
      pending: ["等待确认"],
      agreements: ["不再重发"],
      refs: ["r1"],
    });
    await backend.finished();
    await record.running;
    const sends = await journal.list({ kinds: ["send"] });
    assert.equal(sends.items.length, 1);
    assert.equal(sends.items[0]?.window, "c1");
    assert.ok(sends.items[0]?.targets.includes("qq:group:123"));
    const continuation = backend.opened[1];
    assert.ok(continuation?.firstInput?.includes("已产生的效果：r"));
  });

  it("refuses end without a handoff while the window is behind on a target", async () => {
    const { arbor, journal, backend } = await host();
    backend.script([{ text: "完成" }]);
    const record = await arbor.open(task);
    // Another window wrote on the target after this one opened.
    await journal.append({ kind: "input", window: "c9", body: "新的 CI 结果", targets: ["gh:pr:57"] });
    const result = await arbor.services.endWindow(record.window);
    assert.equal(result.ok, false);
    assert.equal(result.error?.rule, "end.handoff.required");
    assert.ok(result.error?.message.includes("当前话题"));
  });

  it("ends a fresh window cleanly, because its own opening is not open work", async () => {
    const { arbor, backend } = await host();
    backend.script([{ text: "完成" }]);
    const record = await arbor.open(task);
    // Nothing but the task this window was opened for sits on its target, so
    // there is no unfinished work to hand over.
    const result = await arbor.services.endWindow(record.window);
    assert.equal(result.ok, true);
  });

  it("counts a note a send cited, so the note earns a place in the active set", async () => {
    const journal = new SqliteJournal({ path: ":memory:" });
    const { SqliteNoteStore } = await import("@4fu/arbor-notes-sqlite");
    const notes = new SqliteNoteStore({ path: ":memory:", journal });
    const timers = new ManualTimers();
    const backend = new ScriptedBackend();
    const arbor = new Arbor({
      journal,
      backend,
      timers,
      notes,
      now: () => 1700000000000,
      judge: new QuietJudge(),
    });
    backend.attach(arbor.windowControl());
    backend.script([
      { tool: "note_write", args: { title: "部署", summary: "上线步骤", body: "先灰度，再全量" } },
      { tool: "send", args: { to: "qq:group:123", content: "已完成", cites: ["n1"] } },
      { text: "完成" },
    ]);
    await arbor.open(task);
    await backend.finished();
    // The cite is a use the store cannot see, so the host records it: a note
    // nobody cites, holds as evidence or reads earns nothing.
    const scored = await notes.score();
    assert.equal(scored.total, 1);
    assert.equal(scored.items[0]?.ref, "n1@1");
    assert.ok((scored.items[0]?.score ?? 0) > 0);
  });

  it("fills a note write's anchor in, so the model never declares one", async () => {
    const journal = new SqliteJournal({ path: ":memory:" });
    const { SqliteNoteStore } = await import("@4fu/arbor-notes-sqlite");
    const notes = new SqliteNoteStore({ path: ":memory:", journal });
    const timers = new ManualTimers();
    const backend = new ScriptedBackend();
    const arbor = new Arbor({
      journal,
      backend,
      timers,
      notes,
      now: () => 1700000000000,
      judge: new QuietJudge(),
    });
    backend.attach(arbor.windowControl());
    backend.script([
      { tool: "note_write", args: { title: "部署", summary: "上线步骤", body: "先灰度，再全量" } },
      { text: "完成" },
    ]);
    await arbor.open(task);
    await backend.finished();
    const revision = await notes.revisions("n1");
    assert.equal(revision.items.length, 1);
    assert.equal(revision.items[0]?.anchor?.window, "c1");
    assert.match(revision.items[0]?.anchor?.event ?? "", /^r\d+$/);
  });

  it("refuses a note write against a revision that has moved on", async () => {
    const journal = new SqliteJournal({ path: ":memory:" });
    const { SqliteNoteStore } = await import("@4fu/arbor-notes-sqlite");
    const notes = new SqliteNoteStore({ path: ":memory:", journal });
    const timers = new ManualTimers();
    const backend = new ScriptedBackend();
    const arbor = new Arbor({
      journal,
      backend,
      timers,
      notes,
      now: () => 1700000000000,
      judge: new QuietJudge(),
    });
    backend.attach(arbor.windowControl());
    backend.script([
      { tool: "note_write", args: { title: "部署", body: "第一版" } },
      { tool: "note_replace", args: { id: "n1", revision: 0, body: "第二版" } },
      { text: "完成" },
    ]);
    await arbor.open(task);
    await backend.finished();
    const results = await journal.list({ kinds: ["tool_result"] });
    // The first write succeeded; the replace named a revision that never existed.
    assert.ok(results.items[0]?.body?.includes("已写入 n1@1"));
    // The refusal is recorded with the rule that refused it, so a trace shows why.
    assert.ok(results.items[1]?.body?.includes("note.write"));
    const body = await notes.read("n1");
    assert.equal(body?.body, "第一版");
  });

  it("keeps the board current with the live windows", async () => {
    const { arbor, backend } = await host();
    backend.script([{ text: "完成" }]);
    const record = await arbor.open(task);
    const lines = arbor.boardLines();
    assert.equal(lines.length, 1);
    assert.equal(lines[0]?.window, "c1");
    assert.equal(lines[0]?.doing, "查看 CI 结果");
    await arbor.services.setBoardLine(record.window, "重跑失败的测试");
    assert.equal(arbor.boardLines()[0]?.doing, "重跑失败的测试");
  });

  it("searches the journal, the notes and the board in one query", async () => {
    const { arbor, journal, backend } = await host();
    await journal.append({ kind: "input", window: "c1", body: "部署上线流程已确认", targets: ["qq:group:1"] });
    backend.script([{ text: "完成" }]);
    const record = await arbor.open(task);
    const found = await arbor.search("部署");
    assert.equal(found.hits.length, 1);
    assert.equal(found.hits[0]?.ref, "r1");
    const board = await arbor.search("查看");
    assert.equal(board.windows.length, 1);
    assert.equal(board.windows[0]?.window, record.window);
  });

  it("serves the tasks module from the records dispatch wrote", async () => {
    const { arbor, journal, backend } = await host();
    // Two batches, on two targets, so each is one task: the host records a task
    // and the outside events it batches before anything decides about them
    // (docs/dispatch.md#tasks).
    backend.script([{ text: "完成" }]);
    await arbor.ingest([
      {
        source: "qq",
        target: "qq:group:1",
        time: 1_700_000_001_000,
        content: [{ kind: "data", fields: { content: "在吗" } }],
      },
    ]);
    await backend.finished();
    backend.script([{ text: "完成" }]);
    await arbor.ingest([
      {
        source: "qq",
        target: "qq:group:2",
        time: 1_700_000_002_000,
        content: [{ kind: "data", fields: { content: "看下 CI" } }],
      },
    ]);
    await backend.finished();

    const listed = await arbor.services.tasks();
    assert.equal(listed.length, 2);
    assert.equal(listed[0]?.ref, "t2", "the newest task comes first");
    assert.equal(listed[0]?.kind, "batch");
    assert.equal(listed[0]?.reason, "a message arrived in qq:group:2");
    assert.deepEqual(listed[0]?.targets, ["qq:group:2"]);
    assert.equal(listed[0]?.source, "qq");
    assert.equal(listed[1]?.ref, "t1");
    const bounded = await arbor.services.tasks(1);
    assert.deepEqual(bounded.map((one) => one.ref), ["t2"]);

    const shown = await arbor.services.task(["t1", "t404"]);
    assert.equal(shown.length, 1, "a ref that names no task is left out");
    const bodies = (shown[0]?.events ?? []).map((event) => event.body);
    assert.equal(bodies.length, 1, "the task's batch comes with it");
    assert.ok(bodies[0]?.includes("在吗"));
    const inputs = await journal.list({ kinds: ["input"] });
    assert.equal(inputs.items.length, 2);
  });

  it("serves the schedule module, and a cancelled schedule does not come back", async () => {
    const { arbor, journal, backend } = await host();
    backend.script([{ text: "完成" }]);
    await arbor.open(task);
    await backend.finished();
    const at = 1_700_000_000_000;
    const ref = await arbor.services.schedule({
      name: "每日汇总",
      firstAt: at,
      repeat: { everyMs: 3_600_000 },
      targets: ["gh:pr:57"],
      task: { reason: "a scheduled check", targets: ["gh:pr:57"], time: at, content: [{ kind: "data", fields: { content: "到点了" } }] },
    });

    const listed = await arbor.services.schedules();
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.ref, ref);
    const repeat = listed[0]?.repeat;
    assert.equal(repeat !== undefined && "everyMs" in repeat ? repeat.everyMs : undefined, 3_600_000);

    const updated = await arbor.services.updateSchedule(ref, { name: "改名后的汇总", repeat: { dailyAt: "09:00" } });
    assert.equal(updated?.name, "改名后的汇总");
    assert.deepEqual((await arbor.services.schedules())[0]?.repeat, { dailyAt: "09:00" });
    assert.equal(await arbor.services.updateSchedule("t404", { name: "x" }), null);

    await arbor.services.cancelSchedule(ref);
    assert.equal((await arbor.services.schedules()).length, 0);

    // The cancellation is recorded, so a restart restores nothing.
    const reopened = new Arbor({ journal, backend, timers: new ManualTimers(), now: () => at });
    await reopened.start();
    assert.equal((await reopened.services.schedules()).length, 0);
  });
});

/**
 * The retention period (docs/workspaces.md#lifecycle): a chain's directory is
 * kept once its last window has ended, and reclaimed when the period has
 * passed - which a restart has to keep, because the end it is counted from is
 * in the journal.
 */

describe("workspace retention", () => {
  const retentionMs = 60_000;

  /** One window that wrote a file and then ended its run, as the model asked. */
  async function endedChain(
    options: { retentionMs?: number; now?: () => number } = {},
  ): Promise<{ arbor: Arbor; journal: SqliteJournal; backend: ScriptedBackend; timers: ManualTimers; root: string }> {
    const { arbor, journal, backend, timers, root } = await host(options);
    backend.script([
      { tool: "write", args: { path: "notes.txt", text: "work in progress" } },
      { text: "写完了" },
    ]);
    const record = await arbor.open(task);
    await backend.finished();
    await arbor.end(record.window);
    // The window's own run is what records the end and arms the deadline, so
    // waiting for it is waiting for both.
    await record.running;
    return { arbor, journal, backend, timers, root };
  }

  /**
   * Let the reclaim a fired timer started run to its end. The bound is a
   * deadline, not a number of yields: the reclaim is real filesystem work, and
   * a loop of yields expires on a loaded machine long before it has finished.
   */
  async function untilRemoved(path: string): Promise<void> {
    const deadline = Date.now() + 5000;
    while (existsSync(path) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(existsSync(path), false);
  }

  it("reclaims the chain's directory once the retention period has passed", async () => {
    const { timers, root } = await endedChain({ retentionMs });
    // The chain's last window ended, so one deadline is waiting; the directory
    // is still there while the period runs.
    assert.deepEqual(timers.delays(), [retentionMs]);
    assert.ok(existsSync(join(root, "ws1")));

    timers.fireAll();
    await untilRemoved(join(root, "ws1"));
  });

  it("keeps the directory when no retention period is set", async () => {
    const { timers, root } = await endedChain();
    assert.equal(timers.size, 0);
    timers.fireAll();
    await turn();
    assert.ok(existsSync(join(root, "ws1")));
  });

  it("has nothing to reclaim for a chain that never touched files", async () => {
    const { arbor, backend, timers } = await host({ retentionMs });
    backend.script([{ text: "没有文件" }]);
    const record = await arbor.open(task);
    await backend.finished();
    await arbor.end(record.window);
    await record.running;
    assert.equal(timers.size, 0);
  });

  it("keeps the deadline across a restart, counted from the end the journal recorded", async () => {
    const { arbor, journal, backend, root } = await endedChain({ retentionMs });
    // `close` leaves nothing armed and reclaims nothing.
    await arbor.close();
    assert.ok(existsSync(join(root, "ws1")));
    // The end the journal recorded is what the retention period is counted
    // from; the clock a host runs with is not the journal's own.
    const ended = await journal.list({ kinds: ["window_end"], limit: 1 });
    const endedAt = ended.items[0]?.time ?? 0;

    // The restart lands inside the retention period, so what is left of it is
    // what is armed: 60 s from the end, not 60 s from this start.
    const inside = new ManualTimers();
    const reopened = new Arbor({
      journal,
      backend,
      timers: inside,
      now: () => endedAt + retentionMs / 2,
      workspace: new DirectoryWorkspace({ root }),
      settings: { workspaces: { retentionMs } },
    });
    backend.attach(reopened.windowControl());
    await reopened.start();
    assert.equal(inside.size, 1);
    assert.deepEqual(inside.delays(), [retentionMs / 2]);

    // Past the period, the same start reclaims the directory on its own.
    const due = new ManualTimers();
    const later = new Arbor({
      journal,
      backend,
      timers: due,
      now: () => endedAt + retentionMs + 1,
      workspace: new DirectoryWorkspace({ root }),
      settings: { workspaces: { retentionMs } },
    });
    backend.attach(later.windowControl());
    await later.start();
    assert.equal(due.size, 1);
    assert.deepEqual(due.delays(), [0]);
    due.fireAll();
    await untilRemoved(join(root, "ws1"));
  });

  it("leaves a chain its continuation is still working in alone", async () => {
    const { arbor, journal, backend, timers, root } = await host({ retentionMs });
    backend.script([{ tool: "write", args: { path: "notes.txt", text: "work in progress" } }, { text: "还没做完" }]);
    const record = await arbor.open(task);
    await backend.finished();
    // The end carries a handoff, so the chain goes on in a new window; its
    // steps are scripted before the end that opens it.
    backend.script([{ tool: "read", args: { path: "notes.txt" } }, { text: "读到了" }]);
    await arbor.end(record.window, {
      topics: ["CI"],
      progress: ["构建修了一半"],
      pending: ["跑测试"],
      agreements: [],
      refs: [],
    });
    await backend.finished();
    await record.running;
    // The continuation's run has ended and it waits for a related input, so
    // the one timer waiting is its idle one: no retention deadline is armed
    // while a window of the chain is live.
    assert.deepEqual(timers.delays(), [300_000]);
    assert.ok(existsSync(join(root, "ws1")));
    const continued = await journal.list({ kinds: ["window_start"], limit: 5 });
    assert.equal(continued.items.at(-1)?.window, "c2");
  });
});

/**
 * Task sources: a plugin's source claims the outside events of the source it
 * names, and the host turns those into tasks with the source's own `toTasks`
 * (docs/dispatch.md#tasks).
 *
 * Batching and debouncing are the source's business, so the host does none of
 * its own for events a source claims - a burst of messages becomes the one task
 * the source says it is, and a window is not interrupted again and again. What
 * no source claims keeps the host's own per-target grouping, which is the
 * default for a source that hands events over as they arrive.
 */
describe("task sources", () => {
  /** One outside event, the way a channel hands it over. */
  function event(source: string, target: string, text: string): OutsideEvent {
    return {
      source,
      target,
      time: 1_700_000_000_000,
      content: [{ kind: "data", fields: { content: text } }],
    };
  }

  /**
   * A chat source: it debounces per conversation, so every event of one target
   * that arrives together becomes one task. It also has a push source of its
   * own, the way a channel does.
   */
  class ChatSource implements TaskSource {
    readonly id = "qq";
    /** Every group of events `toTasks` was handed, in order. */
    readonly batched: OutsideEvent[][] = [];
    /** What its own push source handed the host, once `start` subscribed to it. */
    private handler: ((events: readonly OutsideEvent[]) => void | Promise<void>) | undefined;

    toTasks(events: readonly OutsideEvent[]): readonly TaskInput[] {
      this.batched.push([...events]);
      const byTarget = new Map<string, OutsideEvent[]>();
      for (const one of events) {
        const group = byTarget.get(one.target);
        if (group === undefined) byTarget.set(one.target, [one]);
        else group.push(one);
      }
      return [...byTarget].map(([target, group]) => ({
        kind: "batch" as const,
        // The source's own reason, not the host's: it knows why this is a task.
        reason: `群里连续来了 ${group.length} 条消息`,
        targets: [target],
        time: group[group.length - 1]?.time ?? 1_700_000_000_000,
        content: group.map((one) => one.content[0] as TaskInput["content"][number]),
        events: group,
        source: this.id,
      }));
    }

    subscribe(handler: (events: readonly OutsideEvent[]) => void | Promise<void>): Unsubscribe {
      this.handler = handler;
      return () => {
        this.handler = undefined;
      };
    }

    /** Push outside traffic in, the way this source's own transport would. */
    deliver(events: readonly OutsideEvent[]): Promise<void> {
      return Promise.resolve(this.handler === undefined ? undefined : this.handler(events));
    }
  }

  /** Wait for the backend to have opened `count` windows. */
  async function opened(backend: ScriptedBackend, count: number): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (backend.opened.length >= count) return;
      await turn();
    }
    throw new Error(`only ${backend.opened.length} windows opened`);
  }

  it("dispatches the batching a registered source made, and the host groups only what it left", async () => {
    const chat = new ChatSource();
    const { arbor, journal, backend } = await host({ plugins: [{ name: "chat", adapters: { taskSources: [chat] } }] });
    backend.script([{ text: "回复群里的问题" }, { text: "处理爬虫的事件" }]);

    const routed = await arbor.ingest([
      event("qq", "qq:group:1", "在吗"),
      event("qq", "qq:group:1", "看下 CI"),
      event("qq", "qq:group:1", "红了"),
      // A source the plugin registered nothing for keeps the host's own grouping.
      event("svc:crawler", "svc:crawler", "页面变了"),
    ]);
    await opened(backend, 2);

    // The whole burst reached the source as one group, and it made one task of
    // it: the window is interrupted once, not once per message.
    assert.equal(chat.batched.length, 1);
    assert.deepEqual(
      chat.batched[0]?.map((one) => one.target),
      ["qq:group:1", "qq:group:1", "qq:group:1"],
    );
    assert.equal(routed.length, 2);
    assert.equal(routed[0]?.window, "c1");

    const tasks = await arbor.tasks();
    assert.equal(tasks.length, 2);
    assert.equal(tasks[1]?.ref, "t1");
    assert.equal(tasks[1]?.source, "qq");
    assert.equal(tasks[1]?.reason, "群里连续来了 3 条消息");
    assert.deepEqual(tasks[1]?.targets, ["qq:group:1"]);
    const shown = await arbor.task(["t1"]);
    assert.equal(shown[0]?.events.length, 3, "the task names the events it batches");
    // The event no source claimed is the host's own task, grouped by its target.
    assert.equal(tasks[0]?.ref, "t2");
    assert.equal(tasks[0]?.source, "svc:crawler");
    assert.equal(tasks[0]?.reason, "a message arrived in svc:crawler");
    // One window for the burst, one for what it did not claim: no window per message.
    assert.equal(backend.opened.length, 2);
    // Every outside event is still recorded before anything routes, whatever
    // batched it: the journal stays the only record.
    const inputs = await journal.list({ kinds: ["input"] });
    assert.equal(inputs.items.length, 4);
  });

  it("keeps its own grouping by target with no task source registered", async () => {
    const { arbor, journal, backend } = await host();
    backend.script([{ text: "回第一群" }, { text: "回第二群" }]);

    await arbor.ingest([event("qq", "qq:group:1", "在吗"), event("qq", "qq:group:1", "看下 CI"), event("qq", "qq:group:2", "另一边")]);
    await opened(backend, 2);

    const tasks = await arbor.tasks();
    assert.equal(tasks.length, 2);
    assert.equal(tasks[1]?.reason, "a message arrived in qq:group:1");
    assert.equal(tasks[0]?.reason, "a message arrived in qq:group:2");
    assert.equal((await arbor.task(["t1"]))[0]?.events.length, 2);
    assert.equal((await arbor.task(["t2"]))[0]?.events.length, 1);
    const inputs = await journal.list({ kinds: ["input"] });
    assert.equal(inputs.items.length, 3, "every outside event is recorded before anything routes");
  });

  it("subscribes to a source's own push source, the way a channel's is subscribed", async () => {
    const chat = new ChatSource();
    const { arbor, backend } = await host({ plugins: [{ name: "chat", adapters: { taskSources: [chat] } }] });
    await arbor.start();
    backend.script([{ text: "回复群里的问题" }]);

    await chat.deliver([event("qq", "qq:group:1", "在吗"), event("qq", "qq:group:1", "看下 CI")]);
    await opened(backend, 1);

    assert.equal(chat.batched.length, 1);
    const tasks = await arbor.tasks();
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0]?.reason, "群里连续来了 2 条消息");
  });
});

describe("refs across a restart", () => {
  it("continues after the newest ref, however many the journal holds", async () => {
    // More windows than one list page, so a seed read from the oldest page
    // would hand out a ref an earlier window already has.
    const journal = new SqliteJournal({ path: ":memory:" });
    for (let n = 1; n <= 250; n += 1) {
      await journal.append({ kind: "window_start", window: `c${n}` });
    }
    const refs = await RefAllocator.from(journal);
    assert.equal(refs.nextWindow(), "c251");
  });
});

describe("secrets", () => {
  const VALUE = "sk-live-4fUU-arbor-0001";

  /** A tool group whose result carries whatever the script gave it. */
  class EchoGroup implements ToolGroup {
    readonly id = "echo";
    readonly text: string;

    constructor(text: string) {
      this.text = text;
    }

    tools(): readonly DirectToolSpec[] {
      return [
        {
          name: "echo",
          description: "把一段文本原样返回。",
          parameters: { text: { type: "string", description: "内容", required: true } },
        },
      ];
    }

    modules(): readonly [] {
      return [];
    }

    async call(request: ToolCall): Promise<ToolResult> {
      return { callId: request.callId, ok: true, content: this.text };
    }
  }

  function secretHost(groups: readonly ToolGroup[]): Promise<Awaited<ReturnType<typeof host>>> {
    return host({
      groups,
      settings: { secrets: ["ARBOR_TEST_SECRET"] },
      secretOf: (name) => (name === "ARBOR_TEST_SECRET" ? VALUE : undefined),
    });
  }

  it("replaces a secret value in a tool result, in every form it can take", async () => {
    const raw = `key=${VALUE}`;
    const encoded = `base64 ${Buffer.from(VALUE, "utf8").toString("base64")} url ${encodeURIComponent(VALUE)}`;
    const { arbor, journal, backend } = await secretHost([new EchoGroup(`${raw}\n${encoded}`)]);
    backend.script([{ tool: "echo", args: {} }, { text: "完成" }]);
    const record = await arbor.open(task);
    await backend.finished();

    const results = await journal.list({ window: record.window, kinds: ["tool_result"] });
    const body = results.items[0]?.body ?? "";
    assert.ok(!body.includes(VALUE), "the raw value is gone");
    assert.ok(!body.includes(Buffer.from(VALUE, "utf8").toString("base64")), "its base64 form is gone");
    assert.ok(!body.includes(encodeURIComponent(VALUE)), "its URL-encoded form is gone");
    assert.equal(body.split("[hidden:ARBOR_TEST_SECRET]").length - 1, 3, "every form carries the placeholder");
    // What the model reads is the scrubbed form too, not only the record.
    assert.ok(!(backend.opened[0]?.firstInput ?? "").includes(VALUE));
  });

  it("leaves a value too short to be a secret alone", async () => {
    const { arbor, journal, backend } = await secretHost([new EchoGroup("abc")]);
    backend.script([{ tool: "echo", args: {} }, { text: "完成" }]);
    const record = await arbor.open(task);
    await backend.finished();

    const results = await journal.list({ window: record.window, kinds: ["tool_result"] });
    assert.equal(results.items[0]?.body, "abc");
  });

  it("refuses a send whose content carries a secret value, and records nothing", async () => {
    const { arbor, journal, backend } = await secretHost([]);
    backend.script([{ tool: "send", args: { to: "qq:group:1", content: `密钥是 ${VALUE}` } }, { text: "完成" }]);
    const record = await arbor.open(task);
    await backend.finished();

    const results = await journal.list({ window: record.window, kinds: ["tool_result"] });
    assert.equal((results.items[0]?.body ?? "").includes("send.secret"), true);
    assert.ok((results.items[0]?.body ?? "").includes("ARBOR_TEST_SECRET"));
    // Nothing was recorded as an effect, so nothing can be carried out.
    assert.equal((await journal.list({ kinds: ["send"] })).items.length, 0);
    assert.equal((await journal.list({ kinds: ["effect_result"] })).items.length, 0);
  });

  it("picks a secret up when the settings name one later", async () => {
    // The host opens with no secret named; the environment's settings name one,
    // and `start` reads them, so the scrub covers it from then on.
    const { arbor, journal, backend, root, environment } = await host({
      environment: true,
      groups: [new EchoGroup(`key=${VALUE}`)],
      settings: { secrets: [] },
      secretOf: (name) => (name === "ARBOR_TEST_SECRET" ? VALUE : undefined),
    });
    assert.ok(environment !== undefined);
    // The settings item is one file, the way a window writes it in its workspace.
    const draft = join(root, "settings.json");
    await writeFile(draft, `${JSON.stringify({ secrets: ["ARBOR_TEST_SECRET"] }, null, 2)}\n`, "utf8");
    await environment.install([{ kind: "settings", name: "settings", path: draft }]);

    await arbor.start();
    backend.script([{ tool: "echo", args: {} }, { text: "完成" }]);
    const record = await arbor.open(task);
    await backend.finished();

    const results = await journal.list({ window: record.window, kinds: ["tool_result"] });
    assert.equal(results.items[0]?.body, "key=[hidden:ARBOR_TEST_SECRET]");
  });

  it("asks the judge about a scrubbed state, and logs no secret value", async () => {
    const asked: unknown[] = [];
    const quiet = new QuietJudge();
    const judge: Judge = {
      name: "recording",
      decide: async (request) => {
        asked.push(request.state);
        return quiet.decide(request);
      },
    };
    const { arbor, journal } = await host({
      settings: { secrets: ["ARBOR_TEST_SECRET"] },
      secretOf: (name) => (name === "ARBOR_TEST_SECRET" ? VALUE : undefined),
      judge,
    });
    await arbor.dispatch({ ...task, content: [{ kind: "data", fields: { content: `密钥是 ${VALUE}` } }] });

    assert.ok(asked.length > 0, "the judge was asked");
    const state = JSON.stringify(asked);
    assert.ok(!state.includes(VALUE), "the state the judge saw holds no raw value");
    assert.ok(state.includes("[hidden:ARBOR_TEST_SECRET]"), "the placeholder stands in its place");
    const decisions = await journal.list({ kinds: ["judge_decision"] });
    for (const decision of decisions.items) {
      assert.ok(!(decision.body ?? "").includes(VALUE), "no decision log holds the raw value");
    }
  });
});

describe("the window's own words", () => {
  it("records what the model wrote, so the transcript replays it", async () => {
    const { arbor, journal, backend } = await host();
    backend.script([{ textDelta: "我看一下" }, { text: "CI 是网络问题" }]);
    const record = await arbor.open(task);
    await backend.finished();

    const said = await journal.list({ window: record.window, kinds: ["assistant"] });
    assert.equal(said.items.length, 1);
    assert.equal(said.items[0]?.body, "CI 是网络问题");
    // `windows.show` reads the window's events, so the transcript holds it.
    const shown = await arbor.services.windowTranscript(record.window);
    assert.ok(shown.some((event) => event.kind === "assistant" && event.body === "CI 是网络问题"));
  });

  it("records nothing for a turn that only made tool calls", async () => {
    const { arbor, journal, backend } = await host();
    backend.script([{ tool: "probe", args: {} }]);
    const record = await arbor.open(task);
    await backend.finished();

    assert.equal((await journal.list({ window: record.window, kinds: ["assistant"] })).items.length, 0);
  });

  it("opens a continuation when the window's model call failed, saying it was interrupted", async () => {
    const { arbor, backend } = await host();
    backend.script([{ ended: "failed" }, { text: "接着做" }]);
    const record = await arbor.open(task);
    await backend.finished();
    // The failure is settled inside the window's own run, which opens the
    // continuation, so the run is what a test waits for.
    await record.running;

    const continuation = backend.opened[1];
    assert.ok(continuation !== undefined, "a failed window's work goes on");
    assert.ok(continuation?.firstInput?.includes("上一轮因模型服务异常中断"));
    assert.equal(record.state, "ended");
  });
});

describe("a window's own effect result", () => {
  it("comes back to the window that made it, in the text table's words", async () => {
    let now = 1700000000000;
    const { arbor, journal, backend } = await host({ now: () => now });
    arbor.effects.addExecutor({
      id: "test-send",
      can: (effect: Effect) => effect.kind === "send",
      run: async () => ({ ok: true }),
    });
    backend.script([{ tool: "send", args: { to: "qq:group:123", content: "已修好" } }, { text: "完成" }]);
    const record = await arbor.open(task);
    // Past the protection period, so what the send brought back may go in: the
    // window is on another conversation, and only the current target enters
    // during the period (docs/dispatch.md#insertion-timing).
    now += 120_000;
    await backend.finished();
    await settle();

    const results = await journal.list({ kinds: ["effect_result"] });
    assert.equal(results.items.length, 1);
    assert.match(results.items[0]?.body ?? "", /^效果 r\d+ 已执行。$/);
    // The window that sent it hears the result, as a delivery it may read.
    const deliveries = await journal.list({ window: record.window, kinds: ["delivery"] });
    assert.ok(
      deliveries.items.some((event) => (event.body ?? "").includes("已执行。")),
      "the window's own result is delivered to it",
    );
  });

  it("says an effect did not run, and why", async () => {
    let now = 1700000000000;
    const { arbor, journal, backend } = await host({ now: () => now });
    arbor.effects.addExecutor({
      id: "test-send",
      can: (effect: Effect) => effect.kind === "send",
      run: async () => ({
        ok: false,
        error: { code: "unavailable", rule: "channel.refused", message: "频道拒收了这条消息" },
      }),
    });
    backend.script([{ tool: "send", args: { to: "qq:group:123", content: "已修好" } }, { text: "完成" }]);
    const record = await arbor.open(task);
    now += 120_000;
    await backend.finished();
    await settle();

    const results = await journal.list({ kinds: ["effect_result"] });
    assert.equal(results.items.length, 1);
    assert.ok((results.items[0]?.body ?? "").includes("没有执行"));
    assert.ok((results.items[0]?.body ?? "").includes("频道拒收了这条消息"));
    const deliveries = await journal.list({ window: record.window, kinds: ["delivery"] });
    assert.ok(deliveries.items.some((event) => (event.body ?? "").includes("没有执行")));
    assert.equal(record.window, "c1");
  });
});

describe("a refusal to open a window", () => {
  it("records the rule and answers the task as unrouted, without throwing", async () => {
    const plugin: Plugin = {
      name: "gate",
      hooks: {
        windowStart: () => ({
          allow: false,
          error: {
            code: "refused",
            rule: "policy.window.denied",
            message: "本部署不允许为这个来源开窗。",
            nextAction: "换一个被允许的来源。",
          },
        }),
      },
    };
    const { arbor, journal, backend } = await host({ plugins: [plugin] });
    backend.script([{ text: "不会运行" }]);

    const result = await arbor.dispatch(task);

    assert.equal(result.route, "refused");
    assert.equal(result.window, null);
    assert.equal(backend.opened.length, 0, "no window opened");
    const recorded = await journal.list({ kinds: ["dispatch"] });
    assert.equal(recorded.items.length, 1);
    assert.ok((recorded.items[0]?.body ?? "").includes("policy.window.denied"));
  });
});

/**
 * The host's own refusals (docs/prompting.md#language-and-the-text-table): the
 * rules the core enforces outside a tool - no environment, no such window, a
 * window that ended, a plugin refusing the model request, no note store - read
 * the one text table like every other refusal, so a deployment that replaces
 * the table replaces these too.
 */

describe("the host's own refusals", () => {
  const delivery = {
    kind: "window_message" as const,
    refs: [] as readonly `r${number}`[],
    time: 1_700_000_000_000,
    content: [{ kind: "data" as const, fields: { content: "在吗" } }],
  };

  it("names no such window in the table's words", async () => {
    const { arbor, backend } = await host();
    backend.script([{ text: "完成" }]);
    const record = await arbor.open(task);
    await backend.finished();
    await arbor.end(record.window);
    await record.running;

    // The window that ended is gone from the host, which is what a delivery to
    // it is answered with; the same table entry answers a window that never was.
    await assert.rejects(
      () => arbor.deliver(record.window, delivery),
      (error: { rule?: string; message?: string; nextAction?: string }) => {
        assert.equal(error.rule, "window.not_found");
        assert.equal(error.message, textOf(zhTextTable, "refused.windows.notfound", { window: record.window }));
        assert.equal(error.nextAction, textOf(zhTextTable, "next.windows.notfound"));
        return true;
      },
    );
  });

  it("names an absent note store and an absent environment in the table's words", async () => {
    const { arbor, backend } = await host();
    backend.script([{ text: "完成" }]);
    const record = await arbor.open(task);
    await backend.finished();

    // The host this test runs with configures neither.
    await assert.rejects(
      () => arbor.services.writeNote(record.window, { title: "标题", body: "正文" }),
      (error: { rule?: string; message?: string; nextAction?: string }) => {
        assert.equal(error.rule, "notes.absent");
        assert.equal(error.message, textOf(zhTextTable, "refused.notes.absent"));
        assert.equal(error.nextAction, textOf(zhTextTable, "next.notes.absent"));
        return true;
      },
    );
    await assert.rejects(
      () => arbor.services.reload(record.window, { drafts: [], remove: [] }),
      (error: { rule?: string; message?: string; nextAction?: string }) => {
        assert.equal(error.rule, "env.absent");
        assert.equal(error.message, textOf(zhTextTable, "refused.env.absent"));
        assert.equal(error.nextAction, textOf(zhTextTable, "next.env.absent"));
        return true;
      },
    );
  });
});
