import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { SqliteJournal } from "@arbor/journal-sqlite";
import { DirectoryEnvironment } from "@arbor/environment-dir";
import { DirectoryWorkspace } from "@arbor/workspace-dir";
import type { Judge, JudgeAnswer, JudgeRequest } from "@arbor/interfaces";
import type { CallContext, DirectToolSpec, ToolCall, ToolGroup, ToolResult } from "@arbor/interfaces";
import { Arbor } from "./host.ts";
import { ManualTimers, ScriptedBackend } from "./testing.ts";

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
async function host(options: { workspace?: boolean; environment?: boolean } = {}): Promise<{
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
    now: () => 1700000000000,
    judge: new QuietJudge(),
    ...(options.workspace === false ? {} : { workspace: new DirectoryWorkspace({ root }) }),
    ...(environment === undefined ? {} : { environment }),
    groups: [probe],
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
    backend.script([
      { tool: "end", args: {}, result: { ok: true, content: "已结束" } },
      { text: "继续" },
    ]);
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
    const started = await journal.list({ kinds: ["window_start"] });
    assert.equal(started.items.length, 2);
    const continuation = started.items[1];
    assert.equal(continuation?.window, "c2");
    assert.ok(continuation?.refs.includes("c1"));
    const opened = backend.opened[1];
    assert.ok(opened?.continuation?.previous === "c1");
    assert.ok(opened?.firstInput?.includes("上一个窗口 c1 的记录没有加载"));
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
    const { arbor, journal, backend, root, probe } = await host();
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
    // the restart section describes.
    const reopened = new Arbor({
      journal,
      backend,
      timers: new ManualTimers(),
      now: () => 1700000000000,
      workspace: new DirectoryWorkspace({ root }),
      groups: [probe],
    });
    backend.attach(reopened.windowControl());
    backend.script([{ tool: "probe", args: { text: "第二轮" } }, { text: "读到了" }]);
    await reopened.start();
    await backend.finished();
    const continued = await journal.list({ kinds: ["window_start"] });
    assert.equal(continued.items.length, 2);
    assert.equal(continued.items[1]?.window, "c2");
    const opened = backend.opened[1];
    assert.ok(opened?.continuation?.previous === "c1");
    assert.ok(opened?.continuation?.midTaskReset === true);
    assert.ok(opened?.firstInput?.includes("窗口 c1 在任务中途被重置"));
    const probed = await journal.list({ window: "c2", kinds: ["tool_result"] });
    assert.ok(probed.items[0]?.body?.includes("探测完成"));
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
    const { SqliteNoteStore } = await import("@arbor/notes-sqlite");
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
    await arbor.open(task);
    await backend.finished();
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
    assert.ok(body.includes("用 end 带上交接内容结束本窗口"));
    assert.ok(body.includes("忽略本条"));
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
    const { arbor, journal, backend, root, probe } = await host();
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
      groups: [probe],
    });
    // A restart is a new host, so the backend takes its control, the way pi does.
    backend.attach(reopened.windowControl());
    backend.script([{ tool: "probe", args: { text: "第二轮" } }, { text: "读到了" }]);
    await reopened.start();
    await backend.finished();
    const started = await journal.list({ kinds: ["window_start"] });
    assert.equal(started.items.length, 2);
    assert.equal(started.items[1]?.window, "c2");
    const opened = backend.opened[1];
    assert.ok(opened?.continuation?.midTaskReset === true);
    assert.ok(opened?.firstInput?.includes("窗口 c1 在任务中途被重置"));
    assert.equal(record.state, "idle");
    const probed = await journal.list({ window: "c2", kinds: ["tool_result"] });
    assert.ok(probed.items[0]?.body?.includes("探测完成"));
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
    const sends = await journal.list({ kinds: ["send"] });
    assert.equal(sends.items.length, 1);
    assert.equal(sends.items[0]?.window, "c1");
    assert.ok(sends.items[0]?.targets.includes("qq:group:123"));
    const continuation = backend.opened[1];
    assert.ok(continuation?.firstInput?.includes("已产生的效果：r"));
  });

  it("refuses end without a handoff while the window is behind on a target", async () => {
    const { arbor, journal, backend } = await host();
    // Another window wrote on the target after this one's watermark.
    await journal.append({ kind: "input", window: "c9", body: "新的 CI 结果", targets: ["gh:pr:57"] });
    backend.script([{ text: "完成" }]);
    const record = await arbor.open(task);
    await arbor.journal.advanceWatermark(record.window, "gh:pr:57", 1);
    const result = await arbor.services.endWindow(record.window);
    assert.equal(result.ok, false);
    assert.equal(result.error?.rule, "end.handoff.required");
    assert.ok(result.error?.message.includes("当前话题"));
  });

  it("fills a note write's anchor in, so the model never declares one", async () => {
    const journal = new SqliteJournal({ path: ":memory:" });
    const { SqliteNoteStore } = await import("@arbor/notes-sqlite");
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
    const { SqliteNoteStore } = await import("@arbor/notes-sqlite");
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
