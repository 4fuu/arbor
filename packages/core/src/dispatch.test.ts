/**
 * Dispatch: for every task, whether a live window takes it or a new window
 * opens (docs/dispatch.md).
 *
 * The order is fixed - filter, hard rule, judge, act - and the rules around the
 * judge are the service layer's own, so these tests drive the whole path with a
 * scripted backend and a judge a test scripts, and check which window ended up
 * with the task and why.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SqliteJournal } from "@4fu/arbor-journal-sqlite";
import type {
  Delivery,
  ExternalRef,
  Judge,
  JudgeAnswer,
  JudgeRequest,
  OutsideEvent,
  Ref,
  RouteAnswer,
  RouteScore,
  Settings,
  TaskInput,
  WindowRef,
} from "@4fu/arbor-interfaces";
import { Arbor } from "./host.ts";
import { ManualTimers, ScriptedBackend, turn } from "./testing.ts";

/** A judge that answers the way one test scripts it. */
class StubJudge implements Judge {
  readonly name = "stub";
  readonly requests: JudgeRequest[] = [];
  /** Set to make every request fail, the way an unreachable judge does. */
  broken = false;

  private readonly answer: (request: JudgeRequest, judge: StubJudge) => JudgeAnswer;

  constructor(answer: (request: JudgeRequest, judge: StubJudge) => JudgeAnswer) {
    this.answer = answer;
  }

  async decide(request: JudgeRequest): Promise<JudgeAnswer> {
    this.requests.push(request);
    if (this.broken) {
      throw Object.assign(new Error("the judge is unreachable"), {
        code: "unavailable",
        rule: "judge.jev.unreachable",
      });
    }
    return this.answer(request, this);
  }

  /** The route requests it was asked. */
  routes(): readonly Extract<JudgeRequest, { decision: "route" }>[] {
    return this.requests.filter(
      (request): request is Extract<JudgeRequest, { decision: "route" }> => request.decision === "route",
    );
  }
}

/** One score per item, for a route answer. */
function routeAnswerOf(scores: ReadonlyArray<[WindowRef | "new", number]>): RouteAnswer {
  const entries: RouteScore[] = scores.map(([item, score]) => ({ item, score }));
  const best = entries.reduce<RouteScore>(
    (winner, entry) => (entry.score > winner.score || (entry.score === winner.score && entry.item !== "new") ? entry : winner),
    { item: "new", score: Number.NEGATIVE_INFINITY },
  );
  return { decision: "route", scores: entries, best: best.item };
}

/** A judge that routes every task to a new window. */
function newWindowJudge(): StubJudge {
  return new StubJudge((request) => {
    if (request.decision === "filter") return { decision: "filter", needsHandling: true };
    if (request.decision === "model_tier") return { decision: "model_tier", tier: request.state.tiers[0] ?? "" };
    return routeAnswerOf([["new", 3]]);
  });
}

/** A judge that routes every task to the window a test names. */
function windowJudge(window: WindowRef): StubJudge {
  return new StubJudge((request) => {
    if (request.decision === "filter") return { decision: "filter", needsHandling: true };
    if (request.decision === "model_tier") return { decision: "model_tier", tier: request.state.tiers[0] ?? "" };
    return routeAnswerOf([[window, 3], ["new", 0]]);
  });
}

async function host(options: { judge?: StubJudge; settings?: Settings } = {}): Promise<{
  arbor: Arbor;
  journal: SqliteJournal;
  backend: ScriptedBackend;
  judge: StubJudge;
  setNow: (value: number) => void;
}> {
  const journal = new SqliteJournal({ path: ":memory:" });
  const backend = new ScriptedBackend();
  const timers = new ManualTimers();
  let now = 1_700_000_000_000;
  const judge = options.judge ?? newWindowJudge();
  const arbor = new Arbor({
    journal,
    backend,
    timers,
    now: () => now,
    judge,
    ...(options.settings === undefined ? {} : { settings: options.settings }),
  });
  backend.attach(arbor.windowControl());
  return { arbor, journal, backend, judge, setNow: (value: number) => (now = value) };
}

/** One outside event, the way a channel hands it over. */
function event(external: ExternalRef, text: string, overrides: Partial<OutsideEvent> = {}): OutsideEvent {
  return {
    source: "qq",
    external,
    target: "qq:group:1",
    time: 1_700_000_000_000,
    content: [{ kind: "data", fields: { content: text } }],
    ...overrides,
  };
}

/** One batch of outside events, the way a chat source hands it over. */
function batch(target: string, text: string, overrides: Partial<TaskInput> = {}): TaskInput {
  return {
    kind: "batch",
    reason: `a message arrived in ${target}`,
    targets: [target],
    time: 1_700_000_000_000,
    content: [{ kind: "data", fields: { content: text } }],
    ...overrides,
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

/** The windows a window_start event names. */
async function started(journal: SqliteJournal): Promise<string[]> {
  const page = await journal.list({ kinds: ["window_start"] });
  return page.items.map((event) => event.window ?? "");
}

describe("filter", () => {
  it("drops a batch the judge says needs no handling, and passes an explicit one", async () => {
    const judge = new StubJudge((request) => {
      if (request.decision === "filter") return { decision: "filter", needsHandling: false };
      return routeAnswerOf([["new", 3]]);
    });
    const { arbor, backend } = await host({ judge });

    const dropped = await arbor.dispatch(batch("qq:group:1", "心跳"));
    assert.equal(dropped.route, "filtered");
    assert.equal(dropped.window, null);
    assert.equal(arbor.live().length, 0, "a batch nobody needs opens no window");

    // An explicit request always passes, whatever the judge would say.
    const passed = await arbor.dispatch(batch("qq:group:1", "@arbor 看下这个", { explicit: true }));
    assert.notEqual(passed.route, "filtered");
    await opened(backend, 1);
  });

  it("passes a batch whose question was not answered, which is this decision's fallback", async () => {
    const judge = new StubJudge((request) => {
      if (request.decision === "filter") return { decision: "filter", needsHandling: false, score: 0.1 };
      return routeAnswerOf([["new", 3]]);
    });
    const { arbor } = await host({ judge });
    // The service layer's own threshold decides, and 0.1 is below it.
    const dropped = await arbor.dispatch(batch("qq:group:1", "自动状态"));
    assert.equal(dropped.route, "filtered");

    judge.broken = true;
    const passed = await arbor.dispatch(batch("qq:group:1", "CI 红了", { explicit: true }));
    assert.notEqual(passed.route, "filtered");
  });
});

describe("the hard rule", () => {
  it("sends a batch that answers something a live window produced to that window", async () => {
    const { arbor, journal, judge } = await host();
    // The question arrived, window c1 answered it, and the reply names it.
    await journal.append({
      kind: "input",
      body: "CI 是什么情况",
      targets: ["qq:group:1"],
      external: "qq:100",
    });
    const first = await arbor.open(batch("qq:group:1", "CI 是什么情况"));
    await journal.append({
      kind: "send",
      window: first.window,
      body: "是 flaky 测试",
      targets: ["qq:group:1"],
      refs: ["qq:100"],
    });

    const routed = await arbor.dispatch(
      batch("qq:group:1", "那把测试修了", {
        events: [
          {
            source: "qq",
            external: "qq:101",
            target: "qq:group:1",
            time: 1_700_000_000_000,
            replyTo: "qq:100",
            content: [{ kind: "data", fields: { content: "那把测试修了" } }],
          },
        ],
      }),
    );

    assert.equal(routed.route, "hard_rule");
    assert.equal(routed.window, first.window);
    assert.equal(judge.routes().length, 0, "the hard rule asks no route decision");
  });

  it("sends a batch that matches a window's exact expectation to that window", async () => {
    const { arbor, backend, judge } = await host();
    const first = await arbor.open(batch("gh:pr:57", "看下 CI"));
    await arbor.services.expect(first.window, "gh:pr:57");

    const routed = await arbor.dispatch(batch("gh:pr:57", "CI 又红了"));

    assert.equal(routed.route, "hard_rule");
    assert.equal(routed.window, first.window);
    assert.equal(judge.routes().length, 0);
    await opened(backend, 1);
  });

  it("lets the judge choose between two windows that expect the same item", async () => {
    const judge = new StubJudge((request) => {
      if (request.decision === "filter") return { decision: "filter", needsHandling: true };
      if (request.decision === "model_tier") return { decision: "model_tier", tier: "" };
      const candidates = request.decision === "route" ? request.state.candidates : [];
      const wanted = candidates.find((candidate) => candidate.window === "c2");
      return routeAnswerOf([[wanted === undefined ? "new" : "c2", 3], ["new", 0]]);
    });
    const { arbor, backend } = await host({ judge });
    const first = await arbor.open(batch("gh:pr:57", "看下 CI"));
    const second = await arbor.open(batch("gh:issue:9", "看下 issue"));
    await arbor.services.expect(first.window, "gh:pr:57");
    await arbor.services.expect(second.window, "gh:pr:57");

    const routed = await arbor.dispatch(batch("gh:pr:57", "CI 又红了"));

    assert.equal(routed.route, "judge");
    assert.equal(routed.window, second.window);
    assert.equal(judge.routes().length, 1);
    await opened(backend, 2);
  });
});

describe("the judge", () => {
  it("inserts a task into the candidate the judge scores above the threshold", async () => {
    const { arbor, journal, backend, judge, setNow } = await host({ judge: windowJudge("c1") });
    await arbor.open(batch("gh:pr:57", "看下 CI"));
    await opened(backend, 1);
    // The protection period is over, so the task the judge routes here goes in.
    setNow(1_700_000_000_000 + 61_000);

    const routed = await arbor.dispatch(batch("gh:issue:9", "看下 issue"));

    assert.equal(routed.route, "judge");
    assert.equal(routed.window, "c1");
    await opened(backend, 1);
    const delivered = await journal.list({ kinds: ["delivery"] });
    assert.equal(delivered.items.length, 1);
    assert.equal(delivered.items[0]?.window, "c1");
    assert.ok(delivered.items[0]?.body?.includes("看下 issue"));
    assert.equal(judge.routes().length, 1);
  });

  it("opens a new window when the judge's best candidate is below the service layer's threshold", async () => {
    // The judge names c1 as the best fit, but only weakly: the threshold is the
    // service layer's own, so the task still opens a window.
    const judge = new StubJudge((request) => {
      if (request.decision === "filter") return { decision: "filter", needsHandling: true };
      if (request.decision === "model_tier") return { decision: "model_tier", tier: "" };
      return routeAnswerOf([["c1", 1], ["new", 1]]);
    });
    const { arbor, journal, backend } = await host({ judge });
    await arbor.open(batch("gh:pr:57", "看下 CI"));

    const routed = await arbor.dispatch(batch("gh:issue:9", "看下 issue"));

    assert.equal(routed.window, "c2");
    await opened(backend, 2);
    const delivered = await journal.list({ kinds: ["delivery"] });
    assert.equal(delivered.items.length, 0, "a window that did not take it is not handed it");
  });

  it("opens a new window when the judge is unreachable, which is this decision's fallback", async () => {
    const judge = windowJudge("c1");
    const { arbor, backend } = await host({ judge });
    await arbor.open(batch("gh:pr:57", "看下 CI"));
    judge.broken = true;

    const routed = await arbor.dispatch(batch("gh:issue:9", "看下 issue"));

    assert.equal(routed.window, "c2");
    await opened(backend, 2);
    const decisions = await arbor.judgeDecisions();
    const failed = decisions.filter((one) => one.decision === "route" && !one.ok);
    assert.equal(failed.length, 1);
    assert.match(failed[0]?.error ?? "", /unreachable/);
  });

  it("asks nothing for a decision that is off, and acts on its own default", async () => {
    const { arbor, backend } = await host({
      judge: windowJudge("c1"),
      settings: { judge: { modes: { route: "off" } } },
    });
    await arbor.open(batch("gh:pr:57", "看下 CI"));

    const routed = await arbor.dispatch(batch("gh:issue:9", "看下 issue"));

    assert.equal(routed.window, "c2", "a decision that is off falls back to a new window");
    await opened(backend, 2);
  });

  it("asks in shadow and acts on the fallback", async () => {
    const judge = windowJudge("c1");
    const { arbor, backend } = await host({
      judge,
      settings: { judge: { modes: { route: "shadow" } } },
    });
    await arbor.open(batch("gh:pr:57", "看下 CI"));

    const routed = await arbor.dispatch(batch("gh:issue:9", "看下 issue"));

    assert.equal(routed.window, "c2", "shadow acts on nothing, so the fallback acts");
    assert.equal(judge.routes().length, 1, "the judge was still asked");
    await opened(backend, 2);
  });

  it("asks about at most eight candidates", async () => {
    const { arbor, backend, judge } = await host();
    for (let index = 0; index < 10; index += 1) {
      await arbor.open(batch(`gh:pr:${index}`, `看下 ${index}`));
    }

    await arbor.dispatch(batch("gh:pr:57", "CI 又红了"));
    await opened(backend, 10);

    const routes = judge.routes();
    assert.equal(routes.length, 1);
    assert.equal(routes[0]?.state.candidates.length, 8);
  });

  it("does not offer a window past its final usage reminder as a candidate", async () => {
    const { arbor, backend, judge } = await host({
      judge: windowJudge("c1"),
      settings: { window: { contextTokens: 200000, reserveTokens: 20000 } },
    });
    backend.script([{ usage: { used: 160000, limit: 200000, reserve: 20000 } }, { text: "继续" }]);
    await arbor.open(batch("gh:pr:57", "看下 CI"));
    await backend.finished();
    const reminders = await arbor.journal.list({ kinds: ["reminder"] });
    assert.match(reminders.items[0]?.body ?? "", /上下文即将用尽/);

    const routed = await arbor.dispatch(batch("gh:pr:57", "CI 又红了"));

    assert.equal(routed.window, "c2", "the window is past its final reminder, so a new one opens");
    await opened(backend, 2);
    assert.equal(judge.routes()[0]?.state.candidates.length, 0);
  });
});

describe("model tiers", () => {
  const tiers: Settings = {
    modelTiers: { light: "model-light", strong: "model-strong" },
    defaultTier: "light",
    // These tests end a window by hand to keep its tier; the handoff floor is
    // its own test's subject.
    window: { handoffFloor: 0 },
  };

  it("gives a new window the tier the judge picked", async () => {
    const judge = new StubJudge((request) => {
      if (request.decision === "filter") return { decision: "filter", needsHandling: true };
      if (request.decision === "model_tier") return { decision: "model_tier", tier: "strong" };
      return routeAnswerOf([["new", 3]]);
    });
    const { arbor, backend } = await host({ judge, settings: tiers });

    await arbor.dispatch(batch("gh:pr:57", "重构购物车合计"));
    await opened(backend, 1);

    assert.equal(backend.opened[0]?.model, "model-strong");
  });

  it("falls back to the default tier when the judge is unreachable", async () => {
    const judge = newWindowJudge();
    const { arbor, backend } = await host({ judge, settings: tiers });
    judge.broken = true;

    await arbor.dispatch(batch("gh:pr:57", "看下 CI"));
    await opened(backend, 1);

    assert.equal(backend.opened[0]?.model, "model-light");
  });

  it("keeps a window's tier in its continuation", async () => {
    const judge = new StubJudge((request) => {
      if (request.decision === "filter") return { decision: "filter", needsHandling: true };
      if (request.decision === "model_tier") return { decision: "model_tier", tier: "strong" };
      return routeAnswerOf([["new", 3]]);
    });
    const { arbor, backend } = await host({ judge, settings: tiers });
    await arbor.dispatch(batch("gh:pr:57", "重构购物车合计"));
    await opened(backend, 1);
    await arbor.services.endWindow("c1", {
      topics: ["购物车"],
      progress: ["已定位"],
      pending: ["改测试"],
      agreements: ["先改测试"],
      refs: [],
    });
    await opened(backend, 2);

    assert.equal(backend.opened[1]?.model, "model-strong");
  });

  it("offers only the configured tiers to the choice question", async () => {
    const judge = newWindowJudge();
    const { arbor, backend } = await host({ judge, settings: tiers });
    await arbor.dispatch(batch("gh:pr:57", "看下 CI"));
    await opened(backend, 1);
    const asked = judge.requests.find((request) => request.decision === "model_tier");
    assert.deepEqual(asked?.state.tiers, ["light", "strong"]);
  });

  it("describes each configured tier with what settings say it is for", async () => {
    const judge = newWindowJudge();
    const { arbor, backend } = await host({
      judge,
      settings: {
        modelTiers: { chat: "model-chat", code: "model-code" },
        defaultTier: "chat",
        judge: {
          tierCriteria: {
            chat: "回复、查询和转述：快且便宜的模型就够。",
            code: "代码、设计和排查：需要深度推理，错的代价高。",
          },
        },
      },
    });

    await arbor.dispatch(batch("gh:pr:57", "看下 CI"));
    await opened(backend, 1);

    const asked = judge.requests.find((request) => request.decision === "model_tier");
    assert.deepEqual(asked?.state.tiers, ["chat", "code"]);
    // The judge reads the deployment's own tiers through its own words, so a
    // tier that is not the judge's own is not described as light or strong.
    assert.deepEqual(asked?.state.criteria, {
      chat: "回复、查询和转述：快且便宜的模型就够。",
      code: "代码、设计和排查：需要深度推理，错的代价高。",
    });
    assert.equal(backend.opened[0]?.model, "model-chat");
  });

  it("leaves the tier criteria out when settings name none", async () => {
    const judge = newWindowJudge();
    const { arbor, backend } = await host({ judge, settings: tiers });

    await arbor.dispatch(batch("gh:pr:57", "看下 CI"));
    await opened(backend, 1);

    const asked = judge.requests.find((request) => request.decision === "model_tier");
    assert.equal(asked?.state.criteria, undefined);
  });
});

describe("the active set", () => {
  it("adds the judge's bounded share, and never drops what the rule score picked", async () => {
    const journal = new SqliteJournal({ path: ":memory:" });
    const { SqliteNoteStore } = await import("@4fu/arbor-notes-sqlite");
    const notes = new SqliteNoteStore({ path: ":memory:", journal });
    const backend = new ScriptedBackend();
    const timers = new ManualTimers();
    const judge = new StubJudge((request) => {
      if (request.decision === "active_set") {
        // The judge keeps the note the rule score did not pick, and says so at
        // the top level of its own scale.
        return {
          decision: "active_set",
          keep: request.state.notes.filter((note) => note.score === 0).map((note) => note.ref),
          drop: request.state.notes.filter((note) => note.score > 0).map((note) => note.ref),
          scores: request.state.notes.map((note) => ({ ref: note.ref, score: note.score === 0 ? 2 : 0 })),
        };
      }
      if (request.decision === "filter") return { decision: "filter", needsHandling: true };
      if (request.decision === "model_tier") return { decision: "model_tier", tier: "" };
      return routeAnswerOf([["new", 3]]);
    });
    const arbor = new Arbor({ journal, backend, timers, now: () => 1_700_000_000_000, judge, notes });
    backend.attach(arbor.windowControl());
    const used = await notes.write({ title: "部署", summary: "灰度步骤", body: "先灰度" });
    const stale = await notes.write({ title: "旧事", summary: "上个月的事故", body: "已复盘" });
    // One note was used; the other was not, so the rule score does not pick it.
    await notes.recordUse({ ref: used.ref, kind: "read", window: "c1" });

    backend.script([{ text: "完成" }]);
    await arbor.open(batch("gh:pr:57", "看下 CI"));
    await backend.finished();

    const memory = backend.opened[0]?.prompt.memory ?? "";
    assert.ok(memory.includes(`${used.ref} 部署`), "the rule score picks the note a window used");
    assert.ok(memory.includes(`${stale.ref} 旧事`), "the judge adds the one it says is still needed");
  });
});

describe("backpressure", () => {
  it("holds a new window while the backend reports rate limits, and opens it after", async () => {
    const journal = new SqliteJournal({ path: ":memory:" });
    const backend = new ScriptedBackend();
    backend.script([{ text: "第一轮" }]);
    let limited = true;
    (backend as { rateLimits?: () => { limited: boolean; retryAfterMs?: number } }).rateLimits = () => ({
      limited,
      retryAfterMs: 1000,
    });
    const timers = new ManualTimers();
    let now = 1_700_000_000_000;
    const arbor = new Arbor({ journal, backend, timers, now: () => now, judge: newWindowJudge() });
    backend.attach(arbor.windowControl());

    const held = await arbor.dispatch(batch("gh:pr:57", "看下 CI"));
    assert.equal(held.route, "waiting");
    assert.equal(held.window, null);
    assert.equal(arbor.live().length, 0, "no window opens while the backend is limited");

    limited = false;
    timers.fireAll();
    await opened(backend, 1);
    assert.deepEqual(await started(journal), ["c1"]);
  });
});

describe("insertion timing", () => {
  it("dispatches again what a window past its final reminder will never take", async () => {
    const judge = windowJudge("c1");
    const { arbor, journal, backend } = await host({
      judge,
      settings: { window: { contextTokens: 200000, reserveTokens: 20000 } },
    });
    backend.script([{ text: "第一轮" }]);
    await arbor.open(batch("gh:pr:57", "看下 CI"));
    await backend.finished();

    // A task for another target waits: the window protects the one it started on.
    const routed = await arbor.dispatch(batch("gh:issue:9", "看下 issue"));
    assert.equal(routed.window, "c1");
    const waiting = await journal.list({ kinds: ["delivery"] });
    assert.equal(waiting.items.length, 0, "the input waits during the protection period");

    // The final reminder arrives, so what waits is dispatched again.
    backend.script([{ usage: { used: 160000, limit: 200000, reserve: 20000 } }]);
    await arbor.deliver("c1", {
      kind: "conversation_update",
      role: "input",
      refs: ["r1"],
      time: 1_700_000_000_000,
      content: [],
    });
    await opened(backend, 2);

    assert.deepEqual(await started(journal), ["c1", "c2"]);
    const delivered = await journal.list({ kinds: ["delivery"] });
    assert.ok(
      !delivered.items.some((event) => (event.body ?? "").includes("任务 t2")),
      "the waiting task was dispatched again, not inserted into a window that will never take it",
    );
  });

  it("holds an input for another target during the protection period, and lets it in after", async () => {
    const { arbor, journal, backend, setNow } = await host({ judge: windowJudge("c1") });
    await arbor.open(batch("gh:pr:57", "看下 CI"));
    await opened(backend, 1);

    await arbor.dispatch(batch("gh:issue:9", "看下 issue"));
    const held = await journal.list({ kinds: ["delivery"] });
    assert.equal(held.items.length, 0, "an input for another target waits");

    setNow(1_700_000_000_000 + 61_000);
    await arbor.dispatch(batch("gh:pr:60", "看下另一个 PR"));
    const delivered = await journal.list({ kinds: ["delivery"] });
    assert.equal(delivered.items.length, 2, "the period is over, so both go in");
    assert.deepEqual(
      delivered.items.map((event) => event.refs[0]),
      ["t2", "t3"],
    );
  });

  it("inserts nothing while a window is paused, and lets it in when it resumes", async () => {
    const { arbor, journal, backend } = await host({ judge: windowJudge("c1") });
    const first = await arbor.open(batch("gh:pr:57", "看下 CI"));
    await opened(backend, 1);
    await arbor.pause(first.window);

    await arbor.dispatch(batch("gh:pr:57", "CI 又红了"));
    assert.equal((await journal.list({ kinds: ["delivery"] })).items.length, 0, "a paused window takes nothing");

    await arbor.resume(first.window);
    assert.equal((await journal.list({ kinds: ["delivery"] })).items.length, 1);
  });

  it("puts an input for the current target in first, whatever its priority", async () => {
    const { arbor, journal, backend, setNow } = await host();
    const first = await arbor.open(batch("gh:pr:57", "看下 CI"));
    await opened(backend, 1);
    // Both inputs wait at once: the protection period is over, and the window is
    // paused, so nothing goes in until it resumes.
    setNow(1_700_000_000_000 + 61_000);
    await arbor.pause(first.window);
    const delivery = (refs: readonly Ref[], text: string): Delivery => ({
      kind: "notice",
      role: "input",
      refs,
      time: 1_700_000_000_000,
      content: [{ kind: "data", fields: { content: text } }],
    });
    await arbor.deliver(first.window, delivery(["r9"], "另一个目标"), { priority: 5, targets: ["gh:issue:9"] });
    await arbor.deliver(first.window, delivery(["r8"], "同一个目标"), { priority: 0, targets: ["gh:pr:57"] });
    assert.equal((await journal.list({ kinds: ["delivery"] })).items.length, 0);

    await arbor.resume(first.window);

    const delivered = await journal.list({ kinds: ["delivery"] });
    assert.deepEqual(
      delivered.items.map((event) => event.refs[0]),
      ["r8", "r9"],
      "the current target goes first, then priority and age",
    );
  });
});

describe("outside events and their native ids", () => {
  it("stores a redelivered message once, and dispatches nothing for it", async () => {
    const { arbor, journal, backend } = await host({ judge: windowJudge("c1") });
    backend.script([{ text: "完成" }]);
    const message = event("qq:100", "CI 是什么情况");

    const first = await arbor.dispatch(batch("qq:group:1", "CI 是什么情况", { events: [message] }));
    assert.equal(first.window, "c1");
    await opened(backend, 1);

    // The same native id again: the channel retried, the way a webhook does.
    const again = await arbor.dispatch(batch("qq:group:1", "CI 是什么情况", { events: [message] }));

    // The message is stored once, and the retry is not new input: no task was
    // recorded for it, no window opened, and the first window was not asked to
    // answer it twice (docs/journal.md#external-ids).
    assert.equal(again.route, "redelivered");
    assert.equal(again.window, null);
    assert.equal((await journal.list({ external: "qq:100" })).items.length, 1);
    assert.equal((await journal.list({ kinds: ["task"] })).items.length, 1);
    assert.equal((await journal.list({ kinds: ["window_start"] })).items.length, 1);
    assert.equal((await journal.list({ kinds: ["delivery"] })).items.length, 0);
  });

  it("dispatches the new message of a batch that also carries a redelivery", async () => {
    const { arbor, journal, backend } = await host({ judge: windowJudge("c1") });
    backend.script([{ text: "完成" }, { text: "完成" }]);

    await arbor.dispatch(batch("qq:group:1", "第一条", { events: [event("qq:100", "第一条")] }));
    await opened(backend, 1);
    // The retry of the first message arrives together with a new one.
    const routed = await arbor.dispatch(
      batch("qq:group:1", "第二条", {
        events: [event("qq:100", "第一条"), event("qq:101", "第二条")],
      }),
    );

    // The new message is routed into the window already in the conversation.
    assert.equal(routed.route, "judge");
    assert.equal(routed.window, "c1");
    assert.equal((await journal.list({ external: "qq:100" })).items.length, 1);
    assert.equal((await journal.list({ external: "qq:101" })).items.length, 1);
    // The task names both: the new one it carries, and the one it answers.
    const task = (await journal.list({ kinds: ["task"] })).items.at(-1);
    assert.ok(task?.refs.includes("qq:100"));
    assert.ok(task?.refs.includes("qq:101"));
    await opened(backend, 1);
  });
});

describe("the criteria a plugin adds", () => {
  it("rides on the request its own decision is asked with", async () => {
    const { arbor, judge } = await host();
    arbor.register({
      name: "chatbot",
      judgeCriteria: [{ decision: "route", criteria: ["一个来源只进一个窗口"] }],
    });

    await arbor.dispatch(batch("qq:group:1", "在吗"));

    // The plugin's criterion reaches the judge as part of the question, and it
    // steers the wording rather than entering the state.
    const asked = judge.routes();
    assert.equal(asked.length, 1);
    assert.deepEqual(asked[0]?.criteria, ["一个来源只进一个窗口"]);
    assert.deepEqual(asked[0]?.state.candidates, []);
    // A decision the plugin registered no criterion for carries none.
    const filters = judge.requests.filter((request) => request.decision === "filter");
    assert.equal(filters.at(-1)?.criteria, undefined);
  });
});
