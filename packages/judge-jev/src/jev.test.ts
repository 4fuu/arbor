import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isArborError } from "@arbor/errors";
import type {
  ActiveSetAnswer,
  ActiveSetState,
  BroadcastAnswer,
  BroadcastState,
  CandidateWindow,
  FilterAnswer,
  FilterRequest,
  FilterState,
  JudgeRequest,
  JudgeTask,
  ModelTierAnswer,
  ModelTierState,
  NoticeAnswer,
  NoticeState,
  RouteAnswer,
  RouteState,
  WindowRef,
} from "@arbor/interfaces";

import { Jev, isJevUnavailable } from "./jev.ts";
import type { JevDecisionLog, JevOptions } from "./options.ts";

/** One request as the fake transport received it. */
interface SentRequest {
  url: string;
  authorization: string;
  model: string;
  state: Record<string, unknown>;
  questions: Record<string, { type: string; instructions: string; criteria: unknown }>;
}

/** A judge wired to a fake transport that answers with fixed wire answers. */
function jevWith(
  answers: Record<string, unknown>,
  options: JevOptions = {},
): { jev: Jev; sent: SentRequest[]; logs: JevDecisionLog[] } {
  const sent: SentRequest[] = [];
  const logs: JevDecisionLog[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body)) as {
      model: string;
      state: Record<string, unknown>;
      questions: Record<string, { type: string; instructions: string; criteria: unknown }>;
    };
    sent.push({
      url: String(input),
      authorization: String((init?.headers as Record<string, string>).authorization),
      model: body.model,
      state: body.state,
      questions: body.questions,
    });
    return new Response(JSON.stringify({ answers }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  const jev = new Jev({
    getApiKey: () => "test-key",
    fetchImpl,
    onDecision: (log) => logs.push(log),
    now: () => 1_000,
    ...options,
  });
  return { jev, sent, logs };
}

/** A judge whose transport fails, for the unreachable cases. */
function jevBroken(
  failure: () => void,
  options: JevOptions = {},
): { jev: Jev; sent: SentRequest[]; logs: JevDecisionLog[] } {
  const sent: SentRequest[] = [];
  const logs: JevDecisionLog[] = [];
  const fetchImpl = (async (): Promise<Response> => {
    failure();
    throw new Error("the network is gone");
  }) as unknown as typeof fetch;
  const jev = new Jev({
    getApiKey: () => "test-key",
    fetchImpl,
    onDecision: (log) => logs.push(log),
    now: () => 1_000,
    ...options,
  });
  return { jev, sent, logs };
}

function task(overrides: Partial<JudgeTask> = {}): JudgeTask {
  return {
    ref: "t1",
    kind: "batch",
    reason: "a message arrived in a chat",
    targets: ["qq:group:123"],
    content: [{ kind: "outside_message", fields: { sender: "alice", text: "is the deploy done?" } }],
    time: 1_700_000_000_000,
    ...overrides,
  };
}

function window(ref: WindowRef, overrides: Partial<CandidateWindow> = {}): CandidateWindow {
  return {
    window: ref,
    doing: "fixing the cart total",
    targets: ["file:src/cart.ts"],
    expects: ["the reviewer's answer"],
    state: "running",
    usage: { used: 1_200, limit: 8_000 },
    tasks: ["t9", "t8"],
    lastInputs: [{ ref: "r902", summary: "the reviewer left a comment" }],
    finalReminderSent: false,
    ...overrides,
  };
}

function filterRequest(patch: Partial<FilterState> = {}, mode: FilterRequest["mode"] = "on"): FilterRequest {
  return { decision: "filter", mode, state: { task: task(), explicit: false, ...patch } };
}

describe("filter", () => {
  it("asks one bool question about the whole batch, in the service's wire form", async () => {
    const { jev, sent } = jevWith({ filter: { type: "noul", noul: 0.91 } });
    const answer = (await jev.decide(filterRequest())) as FilterAnswer;

    assert.equal(answer.decision, "filter");
    assert.equal(answer.needsHandling, true);
    assert.equal(sent.length, 1, "one request per decision");
    const request = sent[0];
    assert.ok(request !== undefined);
    assert.equal(request.url, "https://api.typesafe.ai/v1/systemone");
    assert.equal(request.model, "jev-latest");
    assert.equal(request.authorization, "Bearer test-key");

    const question = request.questions.filter;
    assert.ok(question !== undefined);
    // The wire form of a bool question is `noul`, with both outcomes described.
    assert.equal(question.type, "noul");
    const criteria = question.criteria as { true: string; false: string };
    assert.ok(criteria.true.length > 0, "the yes outcome is described");
    assert.ok(criteria.false.length > 0, "the no outcome is described");
    assert.match(question.instructions, /task\.content/);

    // The state is data only, with a note that defines every field.
    const state = request.state;
    assert.equal(state.explicit, false);
    assert.equal(typeof state.state_note, "string");
    const task0 = state.task as { content: Array<{ kind: string; fields: Record<string, unknown> }> };
    assert.equal(task0.content[0]?.kind, "outside_message");
    assert.equal(task0.content[0]?.fields.text, "is the deploy done?");
  });

  it("passes a batch at the threshold and drops one below it", async () => {
    const at = jevWith({ filter: { type: "noul", noul: 0.5 } });
    assert.equal(((await at.jev.decide(filterRequest())) as FilterAnswer).needsHandling, true);

    const below = jevWith({ filter: { type: "noul", noul: 0.49 } });
    assert.equal(((await below.jev.decide(filterRequest())) as FilterAnswer).needsHandling, false);
  });

  it("passes a batch whose question was not answered, which is this decision's fallback", async () => {
    const { jev } = jevWith({});
    assert.equal(((await jev.decide(filterRequest())) as FilterAnswer).needsHandling, true);
  });

  it("scrubs a secret out of the request and out of the decision log", async () => {
    const secret = "sk-live-4fuu-arbor-1234";
    const { jev, sent, logs } = jevWith(
      { filter: { type: "noul", noul: 0.9 } },
      { scrub: (text) => text.split(secret).join("[hidden:JEV_API_KEY]") },
    );
    await jev.decide(
      filterRequest({
        task: task({ content: [{ kind: "data", fields: { text: `the key is ${secret}` } }] }),
      }),
    );

    const wire = JSON.stringify(sent[0]);
    assert.ok(!wire.includes(secret), "no secret value reaches Jev");
    assert.ok(wire.includes("[hidden:JEV_API_KEY]"), "the placeholder does");
    assert.ok(!JSON.stringify(logs[0]?.state).includes(secret), "no secret value reaches the log");
  });

  it("logs the decision with its probability, its mode and the state the judge saw", async () => {
    const { jev, logs } = jevWith({ filter: { type: "noul", noul: 0.77 } });
    await jev.decide(filterRequest({}, "shadow"));

    const log = logs[0];
    assert.ok(log !== undefined);
    assert.equal(log.decision, "filter");
    assert.equal(log.mode, "shadow");
    assert.equal(log.ok, true);
    const logged = log.answers?.filter;
    assert.ok(logged !== undefined && logged.type === "bool");
    assert.equal(logged.probability, 0.77);
    assert.equal(log.durationMs, 0);
    assert.equal(typeof log.state.state_note, "string");
  });
});

describe("route", () => {
  function routeRequest(candidates: readonly CandidateWindow[]): JudgeRequest {
    return {
      decision: "route",
      mode: "on",
      state: { task: task(), candidates } satisfies RouteState,
    };
  }

  it("scores every candidate and a new window in one request, and names the best", async () => {
    const { jev, sent } = jevWith({
      "route[0]": { type: "score", score: 1 },
      "route[1]": { type: "score", score: 3 },
      "route[new]": { type: "score", score: 2 },
    });
    const answer = (await jev.decide(routeRequest([window("c1"), window("c2")]))) as RouteAnswer;

    assert.equal(answer.decision, "route");
    assert.equal(answer.best, "c2");
    assert.deepEqual(
      answer.scores.map((entry) => [entry.item, entry.score]),
      [
        ["c1", 1],
        ["c2", 3],
        ["new", 2],
      ],
    );
    assert.equal(sent.length, 1, "every question of the decision is batched into one request");
    assert.deepEqual(Object.keys(sent[0]?.questions ?? {}), ["route[0]", "route[1]", "route[new]"]);
  });

  it("takes a live window over a new one when they fit equally well", async () => {
    const { jev } = jevWith({
      "route[0]": { type: "score", score: 2 },
      "route[new]": { type: "score", score: 2 },
    });
    const answer = (await jev.decide(routeRequest([window("c1")]))) as RouteAnswer;

    assert.equal(answer.best, "c1", "a tie keeps the window: opening one pays for a fresh prefix");
  });

  it("takes a new window when it fits best", async () => {
    const { jev } = jevWith({
      "route[0]": { type: "score", score: 0 },
      "route[new]": { type: "score", score: 3 },
    });
    assert.equal(((await jev.decide(routeRequest([window("c1")]))) as RouteAnswer).best, "new");
  });

  it("asks about at most the configured number of candidates, and never picks one it left out", async () => {
    const candidates = ["c1", "c2", "c3", "c4", "c5"].map((ref) => window(ref as WindowRef));
    const { jev, sent } = jevWith(
      { "route[0]": { type: "score", score: 0 }, "route[new]": { type: "score", score: 0 } },
      { maxItems: 2 },
    );
    const answer = (await jev.decide(routeRequest(candidates))) as RouteAnswer;

    assert.deepEqual(Object.keys(sent[0]?.questions ?? {}), ["route[0]", "route[1]", "route[new]"]);
    assert.equal(sent[0]?.state.dropped_candidates, 3);
    assert.equal(sent[0]?.state.window_count, 5);
    // Every candidate the host passed is scored, and the best is one that was asked.
    assert.equal(answer.scores.length, 6);
    assert.ok(["c1", "c2"].includes(answer.best), "a candidate the request left out is never the best");
    assert.equal(answer.scores.find((entry) => entry.item === "c5")?.score, 0);
  });
});

describe("model tier", () => {
  it("offers the configured tiers as the choice question's options and names one", async () => {
    const { jev, sent } = jevWith({ model_tier: { type: "choice", choice: "strong" } });
    const state: ModelTierState = { task: task(), tiers: ["light", "strong"] };
    const answer = (await jev.decide({ decision: "model_tier", mode: "on", state })) as ModelTierAnswer;

    assert.equal(answer.decision, "model_tier");
    assert.equal(answer.tier, "strong");
    const criteria = sent[0]?.questions.model_tier?.criteria as Record<string, string>;
    assert.deepEqual(Object.keys(criteria), ["light", "strong"]);
    assert.ok((criteria.strong ?? "").length > 0, "every option is described");
    assert.deepEqual(sent[0]?.state.tiers, ["light", "strong"]);
  });

  it("falls back to the first configured tier for a choice outside them", async () => {
    const { jev } = jevWith({ model_tier: { type: "choice", choice: "enormous" } });
    const state: ModelTierState = { task: task(), tiers: ["light", "strong"] };
    assert.equal(((await jev.decide({ decision: "model_tier", mode: "on", state })) as ModelTierAnswer).tier, "light");
  });

  it("asks nothing when no tier is configured", async () => {
    const { jev, sent, logs } = jevWith({});
    const state: ModelTierState = { task: task(), tiers: [] };
    const answer = (await jev.decide({ decision: "model_tier", mode: "on", state })) as ModelTierAnswer;

    assert.equal(answer.tier, "");
    assert.equal(sent.length, 0, "no request is made when there is nothing to ask");
    assert.equal(logs[0]?.skipped, "no_items");
  });
});

describe("notice", () => {
  function noticeRequest(candidates: readonly CandidateWindow[]): JudgeRequest {
    return {
      decision: "notice",
      mode: "on",
      state: {
        event: { ref: "r903", kind: "note_revision", target: "n012", summary: "the runbook was revised" },
        candidates,
      } satisfies NoticeState,
    };
  }

  it("asks one question per window and names the ones that need the notice", async () => {
    const { jev, sent } = jevWith({
      "notice[0]": { type: "noul", noul: 0.82 },
      "notice[1]": { type: "noul", noul: 0.11 },
    });
    const answer = (await jev.decide(noticeRequest([window("c1"), window("c2")]))) as NoticeAnswer;

    assert.equal(answer.decision, "notice");
    assert.deepEqual(answer.windows, [
      { window: "c1", needs: true },
      { window: "c2", needs: false },
    ]);
    assert.deepEqual(Object.keys(sent[0]?.questions ?? {}), ["notice[0]", "notice[1]"]);
    const state = sent[0]?.state;
    assert.deepEqual(state?.event, {
      ref: "r903",
      kind: "note_revision",
      target: "n012",
      summary: "the runbook was revised",
    });
  });

  it("leaves a window whose question was not answered without a notice", async () => {
    const { jev } = jevWith({ "notice[0]": { type: "noul", noul: 0.9 } });
    const answer = (await jev.decide(noticeRequest([window("c1"), window("c2")]))) as NoticeAnswer;

    assert.deepEqual(answer.windows, [
      { window: "c1", needs: true },
      { window: "c2", needs: false },
    ]);
  });
});

describe("broadcast", () => {
  function broadcastRequest(candidates: readonly CandidateWindow[], unfiltered = false): JudgeRequest {
    return {
      decision: "broadcast",
      mode: "on",
      state: {
        broadcast: { from: "c4", summary: "a skill was installed", refs: ["e7"] },
        candidates,
        ...(unfiltered ? { unfiltered: true } : {}),
      } satisfies BroadcastState,
    };
  }

  it("asks one question per window and names the ones that need the broadcast", async () => {
    const { jev } = jevWith({
      "broadcast[0]": { type: "noul", noul: 0.3 },
      "broadcast[1]": { type: "noul", noul: 0.6 },
    });
    const answer = (await jev.decide(broadcastRequest([window("c1"), window("c2")]))) as BroadcastAnswer;

    assert.deepEqual(answer.windows, [
      { window: "c1", needs: false },
      { window: "c2", needs: true },
    ]);
  });

  it("never filters an environment delta: every window needs it, and nothing is asked", async () => {
    const { jev, sent, logs } = jevWith({});
    const answer = (await jev.decide(broadcastRequest([window("c1"), window("c2")], true))) as BroadcastAnswer;

    assert.deepEqual(answer.windows, [
      { window: "c1", needs: true },
      { window: "c2", needs: true },
    ]);
    assert.equal(sent.length, 0, "an environment delta is never filtered");
    assert.equal(logs[0]?.skipped, "unfiltered");
  });

  it("delivers to a window whose question was not answered, which is this decision's fallback", async () => {
    const { jev } = jevWith({ "broadcast[0]": { type: "noul", noul: 0.1 } });
    const answer = (await jev.decide(broadcastRequest([window("c1"), window("c2")]))) as BroadcastAnswer;

    assert.deepEqual(answer.windows, [
      { window: "c1", needs: false },
      { window: "c2", needs: true },
    ]);
  });
});

describe("active set", () => {
  function activeSetRequest(notes: ActiveSetState["notes"], maxNotes = 20): JudgeRequest {
    return {
      decision: "active_set",
      mode: "on",
      state: {
        notes,
        budget: { count: maxNotes, tokens: 4_000 },
        judgeShare: 0.15,
      } satisfies ActiveSetState,
    };
  }

  const notes: ActiveSetState["notes"] = [
    { ref: "n1", summary: "the deploy runbook", score: 10 },
    { ref: "n2", summary: "the reviewer's preferences", score: 5 },
    { ref: "n3", summary: "last month's incident", score: 1 },
  ];

  it("asks one score question per note, strongest rule score first, and keeps the needed ones", async () => {
    const { jev, sent } = jevWith({
      "active_set[0]": { type: "score", score: 2 },
      "active_set[1]": { type: "score", score: 1 },
      "active_set[2]": { type: "score", score: 0 },
    });
    const answer = (await jev.decide(activeSetRequest(notes))) as ActiveSetAnswer;

    assert.equal(answer.decision, "active_set");
    assert.deepEqual(answer.keep, ["n1", "n2"]);
    assert.deepEqual(answer.drop, ["n3"]);
    // The candidates are ordered by rule score, so the question ids follow it.
    const asked = (sent[0]?.state.notes as Array<{ ref: string; score: number }>).map((note) => note.ref);
    assert.deepEqual(asked, ["n1", "n2", "n3"]);
    assert.deepEqual(Object.keys(sent[0]?.questions ?? {}), ["active_set[0]", "active_set[1]", "active_set[2]"]);
  });

  it("leaves a note it could not ask about to the rule score alone", async () => {
    const { jev, sent } = jevWith(
      {
        "active_set[0]": { type: "score", score: 2 },
        "active_set[1]": { type: "score", score: 2 },
      },
      { maxItems: 2 },
    );
    const answer = (await jev.decide(activeSetRequest(notes))) as ActiveSetAnswer;

    assert.deepEqual(answer.keep, ["n1", "n2"]);
    assert.deepEqual(answer.drop, ["n3"]);
    assert.equal(sent[0]?.state.dropped_notes, 1);
  });
});

describe("the request", () => {
  it("asks nothing for a decision that is off, and answers with its own default", async () => {
    const { jev, sent, logs } = jevWith({ filter: { type: "noul", noul: 0.99 } });
    const filter = (await jev.decide(filterRequest({}, "off"))) as FilterAnswer;
    assert.equal(filter.needsHandling, true, "the fallback is to pass the batch");
    assert.equal(sent.length, 0, "a decision that acts on nothing costs no request");
    assert.equal(logs[0]?.skipped, "off");
    assert.equal(logs[0]?.mode, "off");

    const route = (await jev.decide({
      decision: "route",
      mode: "off",
      state: { task: task(), candidates: [window("c1")] },
    })) as RouteAnswer;
    assert.equal(route.best, "new", "the fallback is a new window");
    assert.equal(sent.length, 0);
  });

  it("appends a plugin's extra criteria to every question's criteria", async () => {
    const { jev, sent } = jevWith({ filter: { type: "noul", noul: 0.9 } });
    await jev.decide({ ...filterRequest(), criteria: ["only chat batches count"] });

    const criteria = sent[0]?.questions.filter?.criteria as { true: string; false: string };
    assert.ok(criteria.true.includes("Extra criterion: only chat batches count"));
    assert.ok(criteria.false.includes("Extra criterion: only chat batches count"));
  });

  it("bounds what one request carries, and reports every cut as a labelled fact", async () => {
    // 200 blocks of 400 characters each: far more than one request may carry.
    const blocks = Array.from({ length: 200 }, (_unused, index) => ({
      kind: "data",
      fields: { text: `block ${index} ${"x".repeat(380)}` },
    }));
    const { jev, sent } = jevWith({ filter: { type: "noul", noul: 0.9 } });
    await jev.decide(filterRequest({ task: task({ content: blocks }) }));

    const content = sent[0]?.state.task as { content: unknown[]; dropped_content: number };
    assert.ok(content.dropped_content > 0, "the oldest whole blocks are the ones left out");
    assert.ok(content.content.length < 200);
    // The newest block survives, because it is the one the decision is about.
    const newest = content.content[content.content.length - 1] as { fields: { text: string } };
    assert.match(newest.fields.text, /^block 199 /);
    assert.ok(JSON.stringify(sent[0]?.state).length < 60_000, "the request stays inside Jev's window");
  });

  it("sends the same bytes for the same state, so a decision is reproducible", async () => {
    const first = jevWith({ filter: { type: "noul", noul: 0.9 } });
    const second = jevWith({ filter: { type: "noul", noul: 0.9 } });
    await first.jev.decide(filterRequest());
    await second.jev.decide(filterRequest());

    assert.deepEqual(first.sent[0]?.state, second.sent[0]?.state);
    assert.deepEqual(first.sent[0]?.questions, second.sent[0]?.questions);
  });
});

describe("when Jev cannot answer", () => {
  it("refuses with the rule and the next action, and logs the failure", async () => {
    const { jev, logs } = jevBroken(() => undefined);
    const error = await jev.decide(filterRequest()).then(
      () => undefined,
      (caught: unknown) => caught,
    );

    assert.ok(error !== undefined);
    assert.ok(isArborError(error), "the refusal is in the core error shape");
    assert.equal((error as { rule: string }).rule, "judge.jev.unreachable");
    assert.equal((error as { code: string }).code, "unavailable");
    assert.match(String((error as { nextAction: string }).nextAction), /rule fallback/);
    assert.equal(isJevUnavailable(error), true);
    assert.equal(logs[0]?.ok, false);
    assert.equal(logs[0]?.answers, null);
  });

  it("refuses when no key is configured, and sends nothing", async () => {
    const { jev, sent } = jevWith({}, { getApiKey: () => undefined });
    const error = await jev.decide(filterRequest()).then(
      () => undefined,
      (caught: unknown) => caught,
    );

    assert.ok(isArborError(error));
    assert.match(String((error as { message: string }).message), /JEV_API_KEY/);
    assert.equal(sent.length, 0, "no request is sent without a key");
  });

  it("refuses when the service answers with a status it should not", async () => {
    const fetchImpl = (async (): Promise<Response> => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    const jev = new Jev({ getApiKey: () => "test-key", fetchImpl, now: () => 1_000 });
    const error = await jev.decide(filterRequest()).then(
      () => undefined,
      (caught: unknown) => caught,
    );

    assert.ok(isJevUnavailable(error));
    assert.match(String((error as { message: string }).message), /500/);
  });

  it("refuses when the service answers a question with the wrong shape", async () => {
    const { jev } = jevWith({ filter: { type: "score", score: 1 } });
    const error = await jev.decide(filterRequest()).then(
      () => undefined,
      (caught: unknown) => caught,
    );

    assert.ok(isJevUnavailable(error));
    assert.match(String((error as { message: string }).message), /instead of a probability/);
  });
});
