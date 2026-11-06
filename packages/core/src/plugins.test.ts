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
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { SqliteJournal } from "@4fu/arbor-journal-sqlite";
import { DirectoryWorkspace } from "@4fu/arbor-workspace-dir";
import type {
  Block,
  BlockKindSpec,
  Effect,
  Note,
  Plugin,
  StreamEvent,
  TextTable,
} from "@4fu/arbor-interfaces";
import { Arbor } from "./host.ts";
import { ManualTimers, ScriptedBackend, turn } from "./testing.ts";

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

async function host(options: { plugins?: readonly Plugin[] } = {}): Promise<Harness> {
  const journal = new SqliteJournal({ path: ":memory:" });
  const root = await mkdtemp(join(tmpdir(), "arbor-plugin-"));
  const backend = new ScriptedBackend();
  const timers = new ManualTimers();
  const arbor = new Arbor({
    journal,
    backend,
    timers,
    now: () => 1700000000000,
    workspace: new DirectoryWorkspace({ root }),
    plugins: options.plugins,
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
    assert.ok((results.items.at(-1)?.body ?? "").includes("dropped 负责人不同意"));
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
    // lifecycle's own events and nothing else, and the call is recorded once,
    // when it is complete - never once per delta.
    const recorded = await journal.list({ limit: 200 });
    assert.deepEqual(
      recorded.items.map((event) => event.kind),
      ["window_start", "tool_call", "send", "tool_result"],
    );
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
