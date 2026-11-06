/**
 * Coordination: how windows that run in parallel stay current with each other
 * (docs/coordination.md).
 *
 * Windows share the board and share deliveries. These tests drive the host with
 * a scripted backend and a judge a test scripts, and check which window
 * received what - a conversation update, a notice, a broadcast, a window
 * message - and what the host refused.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SqliteJournal } from "@arbor/journal-sqlite";
import { SqliteNoteStore } from "@arbor/notes-sqlite";
import { callContext } from "@arbor/tools";
import type {
  EnvDelta,
  EnvItem,
  ExternalRef,
  Judge,
  JudgeAnswer,
  JudgeRequest,
  MessageRef,
  Ref,
  Settings,
  TaskInput,
  WindowRef,
} from "@arbor/interfaces";
import { Arbor } from "./host.ts";
import { ManualTimers, ScriptedBackend, turn } from "./testing.ts";

/** A judge that answers the way one test scripts it. */
class StubJudge implements Judge {
  readonly name = "stub";
  readonly requests: JudgeRequest[] = [];

  private readonly answer: (request: JudgeRequest) => JudgeAnswer;

  constructor(answer: (request: JudgeRequest) => JudgeAnswer) {
    this.answer = answer;
  }

  async decide(request: JudgeRequest): Promise<JudgeAnswer> {
    this.requests.push(request);
    return this.answer(request);
  }
}

/** A judge that answers every decision with its own fallback. */
function quietJudge(): StubJudge {
  return new StubJudge((request) => {
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
  });
}

/**
 * One host. The protection period is off here: it is what dispatch.test.ts
 * drives, and these tests are about which window receives what.
 */
async function host(options: { judge?: StubJudge; settings?: Settings; notes?: boolean } = {}): Promise<{
  arbor: Arbor;
  journal: SqliteJournal;
  backend: ScriptedBackend;
  judge: StubJudge;
}> {
  const journal = new SqliteJournal({ path: ":memory:" });
  const backend = new ScriptedBackend();
  const timers = new ManualTimers();
  const judge = options.judge ?? quietJudge();
  const arbor = new Arbor({
    journal,
    backend,
    timers,
    now: () => 1_700_000_000_000,
    judge,
    ...(options.notes === true ? { notes: new SqliteNoteStore({ path: ":memory:", journal }) } : {}),
    settings: {
      window: { protectionSeconds: 0 },
      ...(options.settings === undefined ? {} : { settings: options.settings }).settings,
    },
  });
  backend.attach(arbor.windowControl());
  return { arbor, journal, backend, judge };
}

/** One batch of outside events, the way a chat source hands it over. */
function batch(target: string, text: string, events?: TaskInput["events"]): TaskInput {
  return {
    kind: "batch",
    reason: `a message arrived in ${target}`,
    targets: [target],
    time: 1_700_000_000_000,
    content: [{ kind: "data", fields: { content: text } }],
    ...(events === undefined ? {} : { events }),
  };
}

/** One outside message on a conversation. */
function message(target: string, external: ExternalRef, text: string, replyTo?: ExternalRef) {
  return {
    source: "qq",
    external,
    target,
    time: 1_700_000_000_000,
    content: [{ kind: "data" as const, fields: { content: text } }],
    ...(replyTo === undefined ? {} : { replyTo }),
  };
}

/** Wait for the backend to have opened `count` windows. */
async function opened(backend: ScriptedBackend, count: number): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (backend.opened.length >= count) return;
    await turn();
  }
  throw new Error(`only ${backend.opened.length} windows opened`);
}

/** The delivery events one window received, as text. */
async function deliveredTo(journal: SqliteJournal, window: WindowRef): Promise<string[]> {
  const page = await journal.list({ kinds: ["delivery"], window });
  return page.items.map((event) => event.body ?? "");
}

describe("staying current", () => {
  it("steers a new event on a conversation into every window that is in it", async () => {
    const { arbor, journal, backend } = await host();
    const first = await arbor.open(batch("qq:group:1", "第一句"));
    const second = await arbor.open(batch("qq:group:1", "第二句"));
    await opened(backend, 2);

    await arbor.dispatch(batch("qq:group:1", "第三句", [message("qq:group:1", "qq:102", "第三句")]));

    // Both windows are in the conversation, and neither is filtered: a window
    // that is behind on a conversation it touched is brought up to date.
    for (const record of [first, second]) {
      const lines = await deliveredTo(journal, record.window);
      assert.ok(lines.some((line) => line.includes("第三句")), `${record.window} is current`);
      assert.ok(lines.some((line) => line.includes("来源 qq:group:1 有新事件")));
    }
  });

  it("leaves a window that never touched the conversation alone", async () => {
    const { arbor, journal, backend } = await host();
    const other = await arbor.open(batch("gh:pr:57", "看下 CI"));
    await opened(backend, 1);

    await arbor.dispatch(batch("qq:group:1", "第三句", [message("qq:group:1", "qq:102", "第三句")]));

    assert.deepEqual(await deliveredTo(journal, other.window), []);
  });

  it("does not hold a conversation update back for the protection period", async () => {
    const { arbor, journal, backend } = await host();
    const first = await arbor.open(batch("qq:group:1", "第一句"));
    await opened(backend, 1);

    // The window protects the conversation it started on, and an update on it is
    // never held back, whatever else the window is waiting for.
    await arbor.dispatch(batch("gh:pr:60", "看下别的", [message("qq:group:1", "qq:103", "第四句")]));

    const lines = await deliveredTo(journal, first.window);
    assert.ok(lines.some((line) => line.includes("第四句")));
  });
});

describe("notices", () => {
  it("sends a notice to the windows the judge says need it", async () => {
    const judge = new StubJudge((request) => {
      if (request.decision === "filter") return { decision: "filter", needsHandling: true };
      if (request.decision === "model_tier") return { decision: "model_tier", tier: "" };
      if (request.decision === "route") {
        return { decision: "route", scores: [{ item: "new", score: 3 }], best: "new" };
      }
      if (request.decision === "notice") {
        return {
          decision: "notice",
          windows: [
            { window: "c2", needs: true, score: 0.9 },
            { window: "c3", needs: false, score: 0.1 },
          ],
        };
      }
      return { decision: "active_set", keep: [], drop: [] };
    });
    const { arbor, journal, backend } = await host({ judge, notes: true });
    const writer = await arbor.open(batch("gh:pr:57", "改 CI"));
    const inIt = await arbor.open(batch("n1", "读部署笔记"));
    const other = await arbor.open(batch("n1", "改部署笔记"));
    await opened(backend, 3);

    // A window revised the note the other two are working on.
    await arbor.services.writeNote(writer.window, { title: "部署", summary: "灰度 10%", body: "先灰度" });

    const wanted = await deliveredTo(journal, inIt.window);
    assert.ok(wanted.some((line) => line.includes("灰度 10%")), "the window that needs it is told");
    assert.ok(wanted.some((line) => line.includes("推送：")), "the block says it is a notice");
    assert.deepEqual(await deliveredTo(journal, other.window), [], "the other one is not");
    assert.deepEqual(await deliveredTo(journal, writer.window), [], "the window that wrote it is not");
  });

  it("sends no notice when the decision is off", async () => {
    const { arbor, journal, backend } = await host({
      notes: true,
      settings: { judge: { modes: { notice: "off" } } },
    });
    const writer = await arbor.open(batch("gh:pr:57", "改 CI"));
    const inIt = await arbor.open(batch("n1", "读部署笔记"));
    await opened(backend, 2);
    await arbor.services.writeNote(writer.window, { title: "部署", summary: "灰度 10%", body: "先灰度" });

    assert.deepEqual(await deliveredTo(journal, inIt.window), []);
  });
});

describe("broadcasts", () => {
  it("delivers a broadcast to the windows the judge says need it", async () => {
    const judge = new StubJudge((request) => {
      if (request.decision === "broadcast") {
        return {
          decision: "broadcast",
          windows: [
            { window: "c2", needs: true, score: 0.8 },
            { window: "c3", needs: false, score: 0.2 },
          ],
        };
      }
      return quietJudgeAnswer(request);
    });
    const { arbor, journal, backend } = await host({ judge });
    const from = await arbor.open(batch("gh:pr:57", "改 CI"));
    const first = await arbor.open(batch("gh:issue:9", "看 issue"));
    const second = await arbor.open(batch("gh:pr:60", "看 PR"));
    await opened(backend, 3);

    const count = await arbor.services.broadcast(from.window, "CI 的 flaky 测试已隔离");

    assert.equal(count, 1);
    const wanted = await deliveredTo(journal, first.window);
    assert.ok(wanted.some((line) => line.includes("CI 的 flaky 测试已隔离")));
    assert.ok(wanted.some((line) => line.includes("无需回复")), "the block carries the fixed host line");
    assert.deepEqual(await deliveredTo(journal, second.window), []);
    assert.deepEqual(await deliveredTo(journal, from.window), [], "the sender is not a receiver");
  });

  it("delivers to every live window when the decision is off", async () => {
    const { arbor, journal, backend } = await host({ settings: { judge: { modes: { broadcast: "off" } } } });
    const from = await arbor.open(batch("gh:pr:57", "改 CI"));
    const first = await arbor.open(batch("gh:issue:9", "看 issue"));
    const second = await arbor.open(batch("gh:pr:60", "看 PR"));
    await opened(backend, 3);

    const count = await arbor.services.broadcast(from.window, "一个广播");

    assert.equal(count, 2, "a delivery is never the harmful action");
    for (const record of [first, second]) {
      assert.ok((await deliveredTo(journal, record.window)).some((line) => line.includes("一个广播")));
    }
  });

  it("sends an environment delta to every live window, unfiltered", async () => {
    const { arbor, journal, backend, judge } = await host();
    const first = await arbor.open(batch("gh:issue:9", "看 issue"));
    const second = await arbor.open(batch("gh:pr:60", "看 PR"));
    await opened(backend, 2);
    const delta: EnvDelta = {
      revision: "e7",
      previous: "e6",
      items: [
        {
          change: "added",
          item: {
          ref: "sk:deploy@4",
          kind: "skill",
          name: "deploy",
          description: "上线流程",
          revision: 4,
          time: 1_700_000_000_000,
        } satisfies EnvItem,
        },
      ],
    };

    const count = await arbor.broadcastEnvironment(delta);

    assert.equal(count, 2);
    assert.equal(judge.requests.length, 0, "an environment delta is never filtered, so nothing is asked");
    for (const record of [first, second]) {
      const lines = await deliveredTo(journal, record.window);
      assert.ok(lines.some((line) => line.includes("环境变更 e7")));
      assert.ok(lines.some((line) => line.includes("deploy")));
    }
  });
});

describe("window messages", () => {
  it("delivers a message to the window it names, and never to the sender", async () => {
    const { arbor, journal, backend } = await host();
    const from = await arbor.open(batch("gh:pr:57", "改 CI"));
    const to = await arbor.open(batch("gh:issue:9", "看 issue"));
    await opened(backend, 2);

    const sent = await arbor.services.windowMessage(from.window, to.window, "CI 的日志在 r12");

    assert.match(sent, /^m\d+$/);
    const lines = await deliveredTo(journal, to.window);
    assert.ok(lines.some((line) => line.includes("CI 的日志在 r12")));
    assert.ok(lines.some((line) => line.includes(`消息 ${sent}`)), "the block names the message, so a reply can");
    assert.deepEqual(await deliveredTo(journal, from.window), []);
  });

  it("refuses a message to an ended window, and names the next action", async () => {
    const { arbor, backend } = await host();
    const from = await arbor.open(batch("gh:pr:57", "改 CI"));
    const ended = await arbor.open(batch("gh:issue:9", "看 issue"));
    await opened(backend, 2);
    await arbor.end(ended.window);
    await turn();

    const result = await arbor.catalog.call(
      { name: "windows.send", args: { to: ended.window, text: "还在吗" }, callId: "call_1" },
      callContext(from.window),
    );

    assert.equal(result.ok, false);
    assert.equal(result.error?.rule, "window.not_found");
    assert.ok(result.error?.nextAction?.includes("windows.show"), "the refusal names what to do instead");
  });

  it("refuses a reply past the hop limit, so two windows cannot answer forever", async () => {
    const { arbor, backend } = await host();
    const first = await arbor.open(batch("gh:pr:57", "改 CI"));
    const second = await arbor.open(batch("gh:issue:9", "看 issue"));
    await opened(backend, 2);
    const send = (from: WindowRef, to: WindowRef, text: string, replyTo?: Ref): Promise<MessageRef> =>
      arbor.services.windowMessage(from, to, text, replyTo);

    const chain: MessageRef[] = [await send(first.window, second.window, "第一句")];
    for (let index = 0; index < 5; index += 1) {
      const from = index % 2 === 0 ? second.window : first.window;
      const to = index % 2 === 0 ? first.window : second.window;
      chain.push(await send(from, to, `第 ${index + 2} 句`, chain[index]));
    }

    const refused = await send(first.window, second.window, "第 7 句", chain[5]).then(
      () => undefined,
      (error: unknown) => error,
    );
    assert.ok(refused !== undefined, "the sixth reply in one chain is refused");
    assert.equal((refused as { rule: string }).rule, "window_message.hop_limit");
    assert.match(String((refused as { nextAction: string }).nextAction), /结论/);
  });

  it("lists what is queued for a window and not inserted yet", async () => {
    const { arbor, journal, backend } = await host();
    const from = await arbor.open(batch("gh:pr:57", "改 CI"));
    const to = await arbor.open(batch("gh:issue:9", "看 issue"));
    await opened(backend, 2);
    await arbor.pause(to.window);
    await arbor.services.windowMessage(from.window, to.window, "队列中的一条");

    const inbox = await arbor.services.inbox(to.window);
    assert.equal(inbox.length, 1);
    assert.equal(inbox[0]?.from, from.window);
    assert.ok(inbox[0]?.text.includes("队列中的一条"));
    assert.equal((await journal.list({ kinds: ["delivery"] })).items.length, 0);
  });
});

/** Every decision's own fallback, for a judge that only answers one of them. */
function quietJudgeAnswer(request: JudgeRequest): JudgeAnswer {
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
