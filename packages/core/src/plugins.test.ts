/**
 * Plugins: the one unit that extends the host, every part optional
 * (docs/architecture.md#plugins).
 *
 * The plugin under test is a review plugin, the smallest one that shows the two
 * things a deployment builds policy from: it adds its own fields to the blocks
 * the core builds - a note, an outside message - and the one renderer writes
 * them; and it filters and refuses through hooks, hiding a note from the windows
 * that are not reviewing it. Visibility itself is not implemented here: this is
 * the shape a later visibility plugin takes.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { SqliteJournal } from "@4fu/arbor-journal-sqlite";
import { DirectoryWorkspace } from "@4fu/arbor-workspace-dir";
import type {
  Block,
  BlockKindSpec,
  DispatchContext,
  Effect,
  EffectExecutor,
  ExternalTool,
  Judge,
  JudgeAnswer,
  JudgeContext,
  JudgeRequest,
  ModelRequestContext,
  Note,
  Plugin,
  Settings,
  StreamEvent,
  TextTable,
  ToolCallContext,
  ToolResult,
} from "@4fu/arbor-interfaces";
import { Arbor } from "./host.ts";
import { ManualTimers, ScriptedBackend, turn } from "./testing.ts";
import { dataBlock } from "@4fu/arbor-prompt";

/** The block kinds the plugin adds to the ones the core builds. */
const REVIEW_BLOCKS: readonly BlockKindSpec[] = [
  {
    kind: "note",
    extends: "note",
    lines: ["note.review"],
    fields: [{ name: "review", type: "string", required: true }],
  },
  {
    kind: "outside_message",
    extends: "outside_message",
    lines: ["outside_message.trust"],
    fields: [{ name: "trust", type: "string" }],
  },
];

/** The fixed strings its own blocks write. */
const REVIEW_TEXT: TextTable = {
  "note.review": "复核：{review}",
  "outside_message.trust": "来源可信度：{trust}",
};

/**
 * A channel a test plugs in, so a `send` has an executor that owns its target -
 * the way a deployment with a channel registered runs. A test that leaves it
 * out is a host with no channel at all.
 */
function testChannel(ran?: string[]): EffectExecutor {
  return {
    id: "test-send",
    can: (effect: Effect) => effect.kind === "send",
    run: async (effect) => {
      ran?.push(effect.target);
      return { ok: true };
    },
  };
}

/** One note the plugin hands the host, with the field it added. */
function reviewedNote(review: string): Block {
  return {
    kind: "note",
    fields: {
      ref: "n012@3",
      title: "部署",
      summary: "上线步骤",
      revision: 3,
      status: "active",
      review,
      body: [{ kind: "data", fields: { content: "先灰度，再全量" } }],
    },
  };
}

/** Let the host's watchers run, so a test observes what it recorded. */
async function settle(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await turn();
}

/**
 * Wait for the live output a plugin's `windowStream` hook sees. The host hands
 * each delta on without waiting for the watcher, so a test waits for what it
 * expects rather than for a fixed number of passes.
 */
async function streamed(seen: readonly StreamEvent[], count: number): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (seen.length >= count) return;
    await turn();
  }
  throw new Error(`only ${seen.length} deltas reached the plugin`);
}

/** The windows a note may reach: the ones whose board line says they review. */
function reviewing(window: string): boolean {
  return window === "c1";
}

/** The review plugin: a prompt section, its own block kinds, and two hooks. */
function reviewPlugin(options: { hold?: string } = {}): Plugin {
  // An approval holds each effect once: a released one is carried out, and a
  // dropped one never comes back.
  const held = new Set<string>();
  return {
    name: "review",
    promptSection: {
      tag: "review",
      blocks: REVIEW_BLOCKS,
      text: REVIEW_TEXT,
      content: () => [
        reviewedNote("未复核"),
        { kind: "outside_message", fields: { external: "qq:12345", source: "qq", time: "2026-11-05 07:42:35", trust: "未知" } },
      ],
    },
    hooks: {
      // A note nobody reviewed reaches only the windows that are reviewing.
      beforeDelivery: (context) => {
        const holds = context.delivery.content.some(
          (block) => block.kind === "note" && block.fields.review === "未复核",
        );
        if (!holds || reviewing(context.window)) return { allow: true };
        return {
          allow: false,
          error: {
            code: "refused",
            rule: "review.note.hidden",
            message: `窗口 ${context.window} 不在复核这份笔记的窗口中`,
            nextAction: "需要这份笔记时用 notes.read 读取它。",
          },
        };
      },
      // An effect can be held for an approval, and released or dropped later.
      beforeEffect: (context) => {
        if (options.hold === undefined || !context.effect.target.includes("hold")) return { action: "release" };
        if (held.has(context.effect.event)) return { action: "release" };
        held.add(context.effect.event);
        return { action: "hold", approval: options.hold };
      },
    },
  };
}

interface Harness {
  arbor: Arbor;
  journal: SqliteJournal;
  backend: ScriptedBackend;
  timers: ManualTimers;
}

/**
 * A temporary directory this file's tests own, removed when they are all done,
 * so a run leaves nothing behind in the system's temporary directory.
 */
const tempRoots: string[] = [];

after(() => Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true }))));

async function tempDir(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

async function host(
  options: {
    plugins?: readonly Plugin[];
    judge?: Judge;
    /** The settings the host runs with, secrets included. */
    settings?: Settings;
    /** Where a named secret's value comes from. */
    secretOf?: (name: string) => string | undefined;
    /** The tools the backend injects, from the harness around the host. */
    injected?: readonly ExternalTool[];
  } = {},
): Promise<Harness> {
  const journal = new SqliteJournal({ path: ":memory:" });
  const root = await tempDir("arbor-plugin-");
  const backend = new ScriptedBackend();
  // The tools the harness around the host registered, handed in the way a host
  // embedded in one hands them in (docs/tools.md#external-tools).
  backend.injected.push(...(options.injected ?? []));
  const timers = new ManualTimers();
  const arbor = new Arbor({
    journal,
    backend,
    timers,
    now: () => 1700000000000,
    workspace: new DirectoryWorkspace({ root }),
    plugins: options.plugins,
    ...(options.judge === undefined ? {} : { judge: options.judge }),
    ...(options.settings === undefined ? {} : { settings: options.settings }),
    ...(options.secretOf === undefined ? {} : { secretOf: options.secretOf }),
  });
  backend.attach(arbor.windowControl());
  return { arbor, journal, backend, timers };
}

const task = {
  kind: "batch" as const,
  reason: "查看 CI 结果",
  targets: ["gh:pr:57"],
  time: 1700000000000,
  content: [{ kind: "data" as const, fields: { content: "CI 红了" } }],
};

describe("plugins", () => {
  it("adds its own fields to note and outside-message blocks, and the one renderer writes them", async () => {
    const { arbor, backend } = await host({ plugins: [reviewPlugin()] });
    backend.script([{ text: "完成" }]);
    await arbor.open(task);
    await backend.finished();
    const prompt = backend.opened[0]?.prompt.system ?? "";
    // The plugin's section renders in a tag named after it.
    assert.ok(prompt.includes("<review>"));
    // Its own field on a note block has its own line, from its own table entry.
    assert.ok(prompt.includes("复核：未复核"));
    assert.ok(prompt.includes("n012@3 部署"));
    assert.ok(prompt.includes("摘要：上线步骤"));
    // The same for an outside message.
    assert.ok(prompt.includes("外部消息 qq:12345（qq，2026-11-05 07:42:35）"));
    assert.ok(prompt.includes("来源可信度：未知"));
    // A note stays data, and a block without the field renders as it always did.
    assert.ok(prompt.includes("<data>"));
    const plain = arbor.renderer.render([
      { kind: "note", fields: { ref: "n1@1", title: "构建", summary: "CI", revision: 1, status: "active" } },
    ]);
    assert.ok(plain.includes("n1@1 构建"));
    assert.ok(!plain.includes("复核"));
    // The plugin's kinds are the host's own renderer, shared with the backend.
    assert.ok(arbor.renderer.knownKinds().includes("note"));
  });

  it("hides a note from the windows that are not reviewing it", async () => {
    const { arbor, journal, backend } = await host({ plugins: [reviewPlugin()] });
    backend.script([{ text: "第一个窗口" }, { text: "第二个窗口" }]);
    const first = await arbor.open(task);
    await backend.finished();
    const second = await arbor.open({ ...task, reason: "另一个任务" });
    await backend.finished();

    const note: Note = {
      ref: "n012@3",
      id: "n012",
      title: "部署",
      summary: "上线步骤",
      body: "先灰度，再全量",
      status: "active",
      revision: 3,
      time: 1700000000000,
      window: "c1",
    };
    for (const window of [first.window, second.window]) {
      await arbor.deliver(
        window,
        {
          kind: "window_message",
          role: "input",
          from: first.window,
          refs: [note.ref],
          time: 1700000000000,
          content: [reviewedNote("未复核")],
        },
        // The message is about the target both windows are on, so the insertion
        // rules let it in during the protection period.
        { targets: [...task.targets] },
      );
    }
    await settle();
    const deliveries = await journal.list({ kinds: ["delivery"] });
    // Only the window that is reviewing was told; the other never saw the block.
    assert.equal(deliveries.items.length, 1);
    assert.equal(deliveries.items[0]?.window, first.window);
    assert.ok((deliveries.items[0]?.body ?? "").includes("复核：未复核"));
  });

  it("lets a note through once it has been reviewed", async () => {
    const { arbor, journal, backend } = await host({ plugins: [reviewPlugin()] });
    backend.script([{ text: "第一个窗口" }, { text: "第二个窗口" }]);
    await arbor.open(task);
    await backend.finished();
    const second = await arbor.open({ ...task, reason: "另一个任务" });
    await backend.finished();
    await arbor.deliver(
      second.window,
      {
        kind: "window_message",
        role: "input",
        from: "c1",
        refs: ["n012@3"],
        time: 1700000000000,
        content: [reviewedNote("已复核")],
      },
      { targets: [...task.targets] },
    );
    await settle();
    const deliveries = await journal.list({ kinds: ["delivery"] });
    assert.equal(deliveries.items.length, 1);
    assert.ok((deliveries.items[0]?.body ?? "").includes("复核：已复核"));
  });

  it("holds an effect for an approval, then releases or drops it", async () => {
    const { arbor, journal, backend } = await host({ plugins: [reviewPlugin({ hold: "deploy-approval" })] });
    const ran: string[] = [];
    arbor.effects.addExecutor({
      id: "test-send",
      can: (effect: Effect) => effect.kind === "send",
      run: async (effect) => {
        ran.push(effect.target);
        return { ok: true };
      },
    });
    backend.script([{ text: "完成" }]);
    const record = await arbor.open(task);
    await backend.finished();
    await arbor.services.send(record.window, { to: "hold:deploy", content: "上线" });
    await settle();
    // The effect is recorded but not carried out: it waits for the approval.
    assert.deepEqual(ran, []);
    assert.equal(arbor.effects.heldCount(), 1);
    assert.equal(arbor.effects.pending(), 1);
    const released = await arbor.effects.release("deploy-approval");
    assert.equal(released, 1);
    await turn();
    assert.deepEqual(ran, ["hold:deploy"]);

    // A held effect can also be dropped, and the drop is recorded.
    await arbor.services.send(record.window, { to: "hold:rollback", content: "回滚" });
    await settle();
    assert.equal(arbor.effects.heldCount(), 1);
    const dropped = await arbor.effects.drop("deploy-approval", "负责人不同意");
    assert.equal(dropped, 1);
    await turn();
    assert.deepEqual(ran, ["hold:deploy"]);
    const results = await journal.list({ kinds: ["effect_result"] });
    assert.ok((results.items.at(-1)?.body ?? "").includes("负责人不同意"));
  });

  it("refuses a tool call through a hook, in the core's error shape", async () => {
    const plugin: Plugin = {
      name: "guard",
      hooks: {
        beforeToolCall: (context) =>
          context.call.name === "send"
            ? {
                allow: false,
                error: {
                  code: "refused",
                  rule: "guard.send.refused",
                  message: "本部署禁止发送",
                  nextAction: "把结论写进笔记，不要发送。",
                },
              }
            : { allow: true },
      },
    };
    const { arbor, journal, backend } = await host({ plugins: [plugin] });
    backend.script([
      { tool: "send", args: { to: "qq:group:1", content: "已修好" } },
      { text: "完成" },
    ]);
    const record = await arbor.open(task);
    await backend.finished();
    await arbor.end(record.window);
    await backend.finished();
    const results = await journal.list({ kinds: ["tool_result"] });
    assert.ok((results.items[0]?.body ?? "").includes("guard.send.refused"));
    assert.ok((results.items[0]?.body ?? "").includes("把结论写进笔记"));
    // The call never reached the effect queue.
    const sends = await journal.list({ kinds: ["send"] });
    assert.equal(sends.items.length, 0);
  });

  it("registers its hooks in the order its plugins registered", async () => {
    const seen: string[] = [];
    const first: Plugin = {
      name: "first",
      hooks: { afterToolCall: (context) => void seen.push(`first ${context.call.name}`) },
    };
    const second: Plugin = {
      name: "second",
      hooks: { afterToolCall: (context) => void seen.push(`second ${context.call.name}`) },
    };
    const { arbor, backend } = await host({ plugins: [first, second] });
    backend.script([{ tool: "probe", args: {} }, { text: "完成" }]);
    await arbor.open(task);
    await backend.finished();
    assert.deepEqual(seen, ["first probe", "second probe"]);
    assert.deepEqual(
      arbor.registered().map((plugin) => plugin.name),
      ["first", "second"],
    );
  });

  it("changes the task a window opens with, through the window start hook", async () => {
    const plugin: Plugin = {
      name: "label",
      hooks: {
        windowStart: (context) => ({
          allow: true,
          context: { ...context, task: { ...context.task, reason: "复核部署流程" } },
        }),
      },
    };
    const { arbor, backend, journal } = await host({ plugins: [plugin] });
    backend.script([{ text: "完成" }]);
    await arbor.open(task);
    await backend.finished();
    // The board line and the window's own start carry what the hook changed.
    const started = await journal.list({ kinds: ["window_start"] });
    assert.ok((started.items[0]?.body ?? "").includes("复核部署流程"));
    assert.equal(arbor.boardLines()[0]?.doing, "复核部署流程");
  });

  it("collects the criteria its plugins add for the judge", async () => {
    const plugin: Plugin = {
      name: "chatbot",
      judgeCriteria: [{ decision: "route", criteria: ["一个来源只进一个窗口"] }],
    };
    const { arbor } = await host({ plugins: [plugin] });
    assert.deepEqual(arbor.judgeCriteria(), [
      { plugin: "chatbot", decision: "route", criteria: ["一个来源只进一个窗口"] },
    ]);
  });

  it("hands a window's live output to a plugin, and journals none of it", async () => {
    const seen: StreamEvent[] = [];
    const plugin: Plugin = {
      name: "harness",
      hooks: {
        // A surface that shows what a window is writing: the assistant text, and
        // above all the `send` it is composing, because what a window says to
        // the outside is that call's content argument.
        windowStream: (context) => void seen.push(context.event),
      },
    };
    const { arbor, journal, backend } = await host({ plugins: [plugin] });
    arbor.effects.addExecutor(testChannel());
    backend.script([
      { textDelta: "我看一下" },
      { toolCallDelta: { name: "send", callId: "call_1_send", args: { to: "qq:group:1", content: "已修" } } },
      { toolCallDelta: { name: "send", callId: "call_1_send", args: { to: "qq:group:1", content: "已修好" } } },
      { tool: "send", args: { to: "qq:group:1", content: "已修好" } },
      { textDelta: "说完了" },
      { text: "完成" },
    ]);
    await arbor.open(task);
    await backend.finished();
    await streamed(seen, 4);

    // Text arrives as the model writes it, and the send's content is visible
    // before the call is complete - the last delta is the call itself.
    assert.deepEqual(
      seen.map((event) => (event.kind === "text_delta" ? `text ${event.delta}` : `send ${String(event.call.args.content)}`)),
      ["text 我看一下", "send 已修", "send 已修好", "text 说完了"],
    );
    // The stream is ephemeral: the deltas are not events. The run records the
    // lifecycle's own events, the call is recorded once - when it is complete,
    // never once per delta - the run's end with what it cost, and the text the
    // turn finished with is the one thing the deltas leave behind in the
    // record (docs/journal.md).
    const recorded = await journal.list({ limit: 200 });
    assert.deepEqual(
      // What the deltas leave in the record, and nothing else. The send's own
      // result event and the delivery that carried it back to this window are
      // the queue's, not the stream's (docs/coordination.md#effects).
      recorded.items
        .map((event) => event.kind)
        .filter((kind) => kind !== "effect_result" && kind !== "delivery"),
      ["window_start", "tool_call", "send", "tool_result", "assistant", "run_ended"],
    );
    assert.equal(recorded.items.findLast((event) => event.kind === "assistant")?.body, "完成");
    assert.ok((recorded.items[1]?.body ?? "").includes("已修好"));
    // The window ran to its end all the same.
    assert.equal(arbor.live()[0]?.state, "idle");
  });

  it("keeps the window running when a live-output hook throws", async () => {
    const plugin: Plugin = {
      name: "broken",
      hooks: { windowStream: () => { throw new Error("the surface is down"); } },
    };
    const { arbor, journal, backend } = await host({ plugins: [plugin] });
    backend.script([
      { textDelta: "我看一下" },
      { toolCallDelta: { name: "send", callId: "call_1_send", args: { to: "qq:group:1", content: "已修好" } } },
      { tool: "send", args: { to: "qq:group:1", content: "已修好" } },
      { text: "完成" },
    ]);
    await arbor.open(task);
    await backend.finished();
    await settle();
    // The deltas are lost, the window is not: its calls and its end are recorded.
    const calls = await journal.list({ kinds: ["tool_call"] });
    assert.equal(calls.items.length, 1);
    const ended = await journal.list({ kinds: ["window_end"] });
    assert.equal(ended.items.length, 0, "the window is still open, not failed");
    assert.equal(arbor.live()[0]?.state, "idle");
  });
});

describe("the hooks the core runs", () => {
  /** A judge that answers every decision the way the quiet one does. */
  class AnsweringJudge implements Judge {
    readonly name = "answering";
    /** Every request the judge was handed, in order. */
    readonly asked: JudgeRequest[] = [];

    async decide(request: JudgeRequest): Promise<JudgeAnswer> {
      this.asked.push(request);
      if (request.decision === "filter") return { decision: "filter", needsHandling: true };
      if (request.decision === "model_tier") return { decision: "model_tier", tier: "" };
      if (request.decision === "route") {
        // The best of the candidates it was asked about, or a new window when
        // there are none.
        const candidates = request.state.candidates;
        const first = candidates[0]?.window;
        return first === undefined
          ? { decision: "route", scores: [{ item: "new", score: 3 }], best: "new" }
          : { decision: "route", scores: [{ item: first, score: 3 }], best: first };
      }
      return { decision: "active_set", keep: [], drop: [] };
    }
  }

  it("runs the dispatch hooks around a routing decision, with the window it went to", async () => {
    const before: DispatchContext[] = [];
    const after: DispatchContext[] = [];
    const plugin: Plugin = {
      name: "watcher",
      hooks: {
        beforeDispatch: (context) => {
          before.push({ ...context, task: { ...context.task } });
          return { allow: true };
        },
        afterDispatch: (context) => void after.push({ ...context, task: { ...context.task } }),
      },
    };
    const { arbor, backend } = await host({ plugins: [plugin], judge: new AnsweringJudge() });
    backend.script([{ text: "第一个窗口" }]);
    const first = await arbor.open(task);
    await backend.finished();

    const result = await arbor.dispatch({ ...task, reason: "再看一次 CI", time: 1700000001000 });

    assert.equal(result.route, "judge");
    assert.equal(result.window, first.window);
    assert.equal(before.length, 1);
    assert.equal(before[0]?.window, first.window, "the decision names the window the task goes to");
    assert.equal(before[0]?.answer?.decision, "route", "the judge's answer rides on the decision");
    assert.equal(after.length, 1);
    assert.equal(after[0]?.window, result.window, "the after hook sees the window that took it");
  });

  it("runs the judge hooks around a judge request, with the state it saw", async () => {
    const before: JudgeContext[] = [];
    const after: JudgeContext[] = [];
    const plugin: Plugin = {
      name: "watcher",
      hooks: {
        beforeJudge: (context) => {
          before.push(context);
          return { allow: true };
        },
        afterJudge: (context) => void after.push(context),
      },
    };
    const { arbor, backend } = await host({ plugins: [plugin], judge: new AnsweringJudge() });
    backend.script([{ text: "第一个窗口" }]);

    await arbor.dispatch(task);

    assert.ok(before.length > 0, "every decision was watched");
    assert.equal(before[0]?.scrubbed, true, "the state was through the host's scrub");
    assert.equal(before[0]?.request.decision, "filter");
    assert.equal(after.length, before.length);
    assert.equal(after[0]?.answer?.decision, "filter");
  });

  it("falls back on a judge request a hook refused", async () => {
    const plugin: Plugin = {
      name: "gate",
      hooks: {
        beforeJudge: () => ({
          allow: false,
          error: { code: "refused", rule: "policy.judge.denied", message: "本部署禁止询问判官。" },
        }),
      },
    };
    const { arbor, backend } = await host({ plugins: [plugin], judge: new AnsweringJudge() });
    backend.script([{ text: "仍然开窗" }]);

    const result = await arbor.dispatch(task);

    // The filter's own fallback passes the batch, so a window opens all the same.
    assert.equal(result.route, "fallback");
    await settle();
    assert.equal(backend.opened.length, 1);
  });

  it("uses the result an after-tool-call hook answered with", async () => {
    const plugin: Plugin = {
      name: "rewriter",
      hooks: {
        afterToolCall: (context: ToolCallContext) => ({
          allow: true,
          context: { ...context, result: { ...(context.result as ToolResult), content: "钩子改写后的结果" } },
        }),
      },
    };
    const { arbor, journal, backend } = await host({ plugins: [plugin] });
    arbor.effects.addExecutor(testChannel());
    backend.script([{ tool: "send", args: { to: "qq:group:1", content: "已修好" } }, { text: "完成" }]);
    const record = await arbor.open(task);
    await backend.finished();

    const results = await journal.list({ window: record.window, kinds: ["tool_result"] });
    assert.equal(results.items[0]?.body, "钩子改写后的结果", "the record holds what the hook answered with");
    // The window's own effect was made before the hook ran, so the send stands.
    assert.equal((await journal.list({ kinds: ["send"] })).items.length, 1);
  });

  it("opens the window with the inputs a model-request hook answered with", async () => {
    const plugin: Plugin = {
      name: "injector",
      hooks: {
        beforeModelRequest: (context: ModelRequestContext) => ({
          allow: true,
          context: { ...context, inputs: [dataBlock(`${context.inputs[0]?.fields.content ?? ""}\n注入的一行`)] },
        }),
      },
    };
    const { arbor, backend } = await host({ plugins: [plugin] });
    backend.script([{ text: "完成" }]);

    await arbor.open(task);
    await backend.finished();

    const opened = backend.opened[0];
    assert.ok(opened?.firstInput?.includes("CI 红了"), "the input the host built is still there");
    assert.ok(opened?.firstInput?.includes("注入的一行"), "what the hook added is rendered into it");
  });
});

describe("direct tools a plugin or a backend declares", () => {
  /** The secret's value. The settings name it; only this test holds it. */
  const TOKEN = "dsh-value-9182";

  /** One plugin's tool and one the backend injects, recording the calls they take. */
  function declaredTools(calls: { tool: string; args: Record<string, unknown> }[]): {
    plugin: ExternalTool;
    injected: ExternalTool;
  } {
    const answering = (name: string, description: string, content: string): ExternalTool => ({
      name,
      description,
      parameters: { text: { type: "string", description: "内容", required: true } },
      execute: async (request) => {
        calls.push({ tool: request.name, args: request.args });
        return { callId: request.callId, ok: true, content };
      },
    });
    return {
      // The plugin's tool answers with the secret's value, so the scrub is on
      // the path the result leaves by.
      plugin: answering("dsh_review", "评审一段改动。", `评审完成，令牌 ${TOKEN}`),
      injected: answering("dsh_search", "检索知识库。", "检索完成"),
    };
  }

  it("declares them to the model with where they come from, and calls them like any direct tool", async () => {
    const calls: { tool: string; args: Record<string, unknown> }[] = [];
    const { plugin, injected } = declaredTools(calls);
    const seen: string[] = [];
    const watcher: Plugin = {
      name: "lint",
      tools: [plugin],
      hooks: {
        beforeToolCall: (context) => {
          seen.push(`before ${context.call.name}`);
          return { allow: true };
        },
        afterToolCall: (context) => {
          seen.push(`after ${context.call.name}`);
        },
      },
    };
    const { arbor, journal, backend } = await host({
      plugins: [watcher],
      injected: [injected],
      settings: { secrets: ["dsh_token"] },
      secretOf: (name) => (name === "dsh_token" ? TOKEN : undefined),
    });
    backend.script([
      { tool: "dsh_review", args: { text: "src/app.ts" } },
      { tool: "dsh_search", args: { text: "部署" } },
      { text: "完成" },
    ]);
    await arbor.open(task);
    await backend.finished();

    // Both are declared to the model, under their own names, and the tools list
    // says where each one comes from.
    const declared = (backend.opened[0]?.tools ?? []).map((tool) => `${tool.name}${tool.source === undefined ? "" : `（${tool.source}）`}`);
    assert.deepEqual(declared.filter((one) => one.startsWith("dsh_")), ["dsh_review（lint）", "dsh_search（scripted）"]);
    const prompt = backend.opened[0]?.prompt.system ?? "";
    const tools = prompt.slice(prompt.indexOf("<tools>"), prompt.indexOf("</tools>"));
    assert.ok(tools.includes("dsh_review：评审一段改动。（来自lint）"));
    assert.ok(tools.includes("dsh_search：检索知识库。（来自scripted）"));

    // Each call ran its own execute, was seen by both hooks, and is recorded.
    assert.deepEqual(calls, [
      { tool: "dsh_review", args: { text: "src/app.ts" } },
      { tool: "dsh_search", args: { text: "部署" } },
    ]);
    assert.deepEqual(seen, ["before dsh_review", "after dsh_review", "before dsh_search", "after dsh_search"]);
    const recorded = await journal.list({ kinds: ["tool_call", "tool_result"] });
    assert.deepEqual(
      recorded.items.map((event) => event.kind),
      ["tool_call", "tool_result", "tool_call", "tool_result"],
    );
    assert.ok((recorded.items[0]?.body ?? "").includes("dsh_review"));
    // The secret in the plugin tool's answer never reaches the record.
    assert.ok((recorded.items[1]?.body ?? "").includes("评审完成，令牌 [hidden:dsh_token]"));
    assert.ok(!(recorded.items[1]?.body ?? "").includes(TOKEN));
    assert.equal(recorded.items[3]?.body, "检索完成");
    // The window ran to its end all the same.
    assert.equal(arbor.live()[0]?.state, "idle");
  });

  it("leaves a name the model already has to the core, and records the collision with its rule", async () => {
    const calls: string[] = [];
    const shadow: ExternalTool = {
      name: "send",
      description: "另一个发送。",
      parameters: {},
      execute: async (request) => {
        calls.push("shadow");
        return { callId: request.callId, ok: true, content: "不应该到达" };
      },
    };
    const { arbor, journal, backend } = await host({ plugins: [{ name: "lint", tools: [shadow] }] });
    arbor.effects.addExecutor(testChannel());
    backend.script([{ tool: "send", args: { to: "qq:group:1", content: "已修好" } }, { text: "完成" }]);
    await arbor.open(task);
    await backend.finished();
    await settle();

    // The colliding tool is not declared to the model: the core's own is.
    const prompt = backend.opened[0]?.prompt.system ?? "";
    assert.ok(prompt.includes("send："));
    assert.ok(!prompt.includes("另一个发送"));
    // And it never runs: the core tool answers instead.
    const results = await journal.list({ kinds: ["tool_result"] });
    assert.ok((results.items[0]?.body ?? "").includes("已记录"));
    assert.deepEqual(calls, []);
    // The collision is recorded, not thrown: one event naming the source, the
    // tool and the rule, so an operator sees what the model will not get.
    const refused = await journal.list({ kinds: ["tool_registration"] });
    assert.equal(refused.items.length, 1);
    assert.deepEqual(JSON.parse(refused.items[0]?.body ?? "{}"), {
      source: "lint",
      tool: "send",
      rule: "tool.name_taken",
    });
  });

  it("lets a script call a plugin tool, and keeps arbor's own tools out of a script", async () => {
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
    const { arbor, journal, backend } = await host({ plugins: [{ name: "lint", tools: [lint] }] });
    backend.script([
      { tool: "code_exec", args: { script: "return await dsh_lint({ text: 'a: 1' })" } },
      { text: "完成" },
    ]);
    const record = await arbor.open(task);
    await backend.finished();

    // The script reached the plugin's tool as a global of its own name, and the
    // answer is the tool's.
    assert.deepEqual(calls, ["a: 1"]);
    const results = await journal.list({ window: record.window, kinds: ["tool_result"] });
    assert.ok((results.items[0]?.body ?? "").includes("检查完成 a: 1"));

    // A script that names one of arbor's own is still refused with the rule.
    backend.script([
      { tool: "code_exec", args: { script: "send('qq:group:1', 'hi')" } },
      { text: "完成" },
    ]);
    await arbor.open({ ...task, reason: "再看一次 CI" });
    await backend.finished();
    const refused = await journal.list({ kinds: ["tool_result"] });
    assert.ok((refused.items[1]?.body ?? "").includes("script.decision_tool"));
    assert.ok((refused.items[1]?.body ?? "").includes("直接工具只在本回合内直接调用"));
  });
});
