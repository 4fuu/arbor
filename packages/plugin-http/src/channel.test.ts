/**
 * The HTTP test channel, through the public interface
 * (docs/architecture.md#plugins, packages/interfaces/src/channel.ts).
 *
 * This is the plugin's own test, and it composes the whole stack the way a
 * deployment does: the SQLite journal and notes, the directory environment, the
 * directory workspace, pi as the backend over its scripted faux provider, and
 * the default judge with a fake transport, so no key and no network are needed
 * (docs/prompting.md#no-built-in-pi-prompt is about the prompt, not the tests).
 *
 * What it proves is the channel end to end: a webhook message reaches dispatch
 * and opens a window; a second message in the same conversation is steered into
 * that window; a reply comes back out through the channel; and a redelivered
 * native id is stored once, by the journal's unique index
 * (docs/journal.md#external-ids).
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@4fu/arbor-agent-pi/testing";
import { PiAgentBackend } from "@4fu/arbor-agent-pi";
import { SqliteJournal } from "@4fu/arbor-journal-sqlite";
import { DirectoryEnvironment } from "@4fu/arbor-environment-dir";
import { DirectoryWorkspace } from "@4fu/arbor-workspace-dir";
import { Jev } from "@4fu/arbor-judge-jev";
import type { Judge, Settings } from "@4fu/arbor-interfaces";
import { Arbor } from "@4fu/arbor-core";
import { HttpChannel } from "./channel.ts";
import { httpPlugin } from "./plugin.ts";

/** The one model the faux provider serves, which takes images as arbor requires. */
const FAUX_MODEL = {
  id: "faux-1",
  input: ["text", "image"] as ("text" | "image")[],
  contextWindow: 200000,
  maxTokens: 8192,
};

/** The settings the host opens with, installed into `/env` so the model can change them. */
const SETTINGS: Settings = {
  modelTiers: { chat: "faux-1" },
  defaultTier: "chat",
  judge: { tierCriteria: { chat: "A short conversational message on the test channel." } },
};

/**
 * The default judge over a fake transport, so no key and no network are needed.
 *
 * `route` is answered the way a chat channel wants it: a candidate scores at the
 * top of the scale when it shares the task's targets, and zero when it does not,
 * so the first message opens a window, the second goes to the window already in
 * the conversation, and a message in another conversation opens its own. Every
 * other question is answered at the top of its own scale, which is what a
 * permissive judge does.
 */
function judge(): Judge {
  const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body)) as {
      state: { task?: { targets?: readonly string[] }; candidates?: readonly { targets?: readonly string[] }[] };
      questions: Record<string, { type: string; criteria?: Record<string, unknown> }>;
    };
    const wanted = new Set(body.state.task?.targets ?? []);
    const answers: Record<string, unknown> = {};
    for (const [id, question] of Object.entries(body.questions)) {
      if (question.type === "noul") answers[id] = { type: "noul", noul: 1 };
      else if (question.type === "score") answers[id] = { type: "score", score: routeScore(id, body.state, wanted) };
      else answers[id] = { type: "choice", choice: Object.keys(question.criteria ?? {})[0] ?? "" };
    }
    return new Response(JSON.stringify({ answers }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return new Jev({ getApiKey: () => "test-key", fetchImpl });
}

/**
 * How well one `route` item fits. A candidate that shares the task's targets is
 * the window already in the conversation; anything else, including a new window,
 * is not.
 */
function routeScore(
  id: string,
  state: { candidates?: readonly { targets?: readonly string[] }[] },
  wanted: ReadonlySet<string>,
): number {
  const match = /^route\[(\d+)\]$/u.exec(id);
  if (match === null) return 3;
  const candidate = state.candidates?.[Number(match[1])];
  return (candidate?.targets ?? []).some((target) => wanted.has(target)) ? 3 : 0;
}

interface Harness {
  arbor: Arbor;
  journal: SqliteJournal;
  channel: HttpChannel;
  /** Where the page and the webhook are served. */
  base: string;
  /** Script the faux provider's answers, one per model turn. */
  script: (steps: readonly unknown[]) => void;
  /** Everything the model was sent, as JSON, in order. */
  seen: string[];
}

/** One host with the plugin plugged in, the way a deployment composes it. */
async function host(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "arbor-http-"));
  const journal = new SqliteJournal({ path: ":memory:" });
  const faux = fauxProvider({ models: [FAUX_MODEL] });
  const models = createModels();
  models.setProvider(faux.provider);
  const backend = new PiAgentBackend({ models });
  const environment = new DirectoryEnvironment({ root: join(root, "env") });
  // The settings are installed, so the host reads them from `/env` like any
  // deployment's and the model can change them with `reload`.
  const seed = join(root, "seed");
  await mkdir(seed, { recursive: true });
  await writeFile(join(seed, "settings.json"), JSON.stringify(SETTINGS), "utf8");
  await environment.install([{ kind: "settings", name: "settings", path: join(seed, "settings.json") }]);

  // The channel is created before the host, and reads the board from it: the
  // plugin holds no reference to the host, and the deployment supplies one.
  let arbor: Arbor | undefined;
  const channel = new HttpChannel({ board: () => arbor?.boardLines() ?? [] });
  const created = new Arbor({
    journal,
    backend,
    settings: SETTINGS,
    workspace: new DirectoryWorkspace({ root: join(root, "workspaces") }),
    environment,
    judge: judge(),
    plugins: [httpPlugin({ channel })],
  });
  arbor = created;
  await created.start();
  const base = await channel.listen();
  return {
    arbor: created,
    journal,
    channel,
    base,
    script: (steps) => faux.setResponses(steps as never),
    seen: [],
  };
}

/** One webhook message, posted the way the page or an outside system posts it. */
async function post(base: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await fetch(`${base}/webhook`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await response.json()) as Record<string, unknown>;
}

/** Wait for something the host does asynchronously, or fail saying what. */
async function until(label: string, check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 15000;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/**
 * Release the host and the channel, so a test leaves nothing listening.
 *
 * Every window is ended by hand first: `Arbor.close` ends a window the way a
 * host restart does, which opens its continuation, and a test that only wants to
 * let go of the host has no use for a window that starts another turn
 * (docs/windows.md#restart).
 */
async function release(harness: Harness): Promise<void> {
  for (const record of harness.arbor.live()) await harness.arbor.end(record.window);
  await harness.arbor.close();
  await harness.channel.close();
}

describe("the http channel plugin", () => {
  it("takes a webhook message in, and a window opens for it", async () => {
    const harness = await host();
    try {
      harness.seen.length = 0;
      harness.script([
        async (context: { messages: readonly { role: string }[] }) => {
          harness.seen.push(JSON.stringify(context.messages));
          return fauxAssistantMessage("收到，我来查。");
        },
      ]);
      const answer = await post(harness.base, {
        conversation: "demo",
        id: "1",
        from: "alice",
        text: "部署流程是什么",
      });
      // The message keeps the sender's own id, with the channel prefix.
      assert.equal(answer.external, "http:1");
      assert.equal(answer.target, "http:demo");
      assert.equal(answer.redelivered, false);

      await until("a window to open", async () => (await harness.journal.list({ kinds: ["window_start"] })).items.length === 1);
      await until("the run to finish", async () => harness.seen.length > 0);

      // The message is recorded as an input on the conversation, with its native id.
      const inputs = await harness.journal.list({ external: "http:1" });
      assert.equal(inputs.items.length, 1);
      assert.equal(inputs.items[0]?.kind, "input");
      assert.deepEqual(inputs.items[0]?.targets, ["http:demo"]);
      // The window opened on that conversation, and the model read the message.
      const started = await harness.journal.list({ kinds: ["window_start"] });
      assert.deepEqual(started.items[0]?.targets, ["http:demo"]);
      assert.ok(harness.seen[0]?.includes("部署流程是什么"), "the model read the message");
      assert.ok(harness.seen[0]?.includes("http:1"), "and its native id");
      // The plugin's own prompt section reached the one renderer the model reads.
      const prompt = harness.arbor.renderer.render([
        { kind: "http_channel", fields: { channel: "http", conversations: ["demo"] } },
      ]);
      assert.ok(prompt.includes("HTTP 测试频道 http"), "the section's fixed line");
      assert.ok(prompt.includes("当前来源：demo"), "and the conversations it carries");
    } finally {
      await release(harness);
    }
  });

  it("steers a second message in the same conversation into the window already in it", async () => {
    const harness = await host();
    try {
      // One response per turn: the first message, the second one steered in, and
      // the message that opens a window of its own.
      harness.script([
        async (context: { messages: readonly { role: string }[] }) => {
          harness.seen.push(JSON.stringify(context.messages));
          return fauxAssistantMessage("收到。");
        },
        async (context: { messages: readonly { role: string }[] }) => {
          harness.seen.push(JSON.stringify(context.messages));
          return fauxAssistantMessage("这个也收到了。");
        },
        async (context: { messages: readonly { role: string }[] }) => {
          harness.seen.push(JSON.stringify(context.messages));
          return fauxAssistantMessage("另一个来源也收到了。");
        },
      ]);
      await post(harness.base, { conversation: "demo", id: "1", text: "部署流程是什么" });
      await until("a window to open", async () => (await harness.journal.list({ kinds: ["window_start"] })).items.length === 1);
      await until("the first run to finish", async () => harness.seen.length > 0);

      await post(harness.base, { conversation: "demo", id: "2", text: "灰度比例是多少" });
      await until("the second message to reach the window", async () => {
        const deliveries = await harness.journal.list({ kinds: ["delivery"] });
        return deliveries.items.some((event) => (event.body ?? "").includes("灰度比例是多少"));
      });

      // No second window: the message went into the one already in the conversation.
      const started = await harness.journal.list({ kinds: ["window_start"] });
      assert.equal(started.items.length, 1);
      const window = started.items[0]?.window;
      const deliveries = await harness.journal.list({ kinds: ["delivery"] });
      const steered = deliveries.items.filter((event) => (event.body ?? "").includes("灰度比例是多少"));
      assert.ok(steered.length > 0, "the message was delivered");
      assert.ok(
        steered.every((event) => event.window === window),
        `it went into ${window}`,
      );
      // The window stayed current: its watermark moved past the new input.
      await until("the model to read the second message", async () =>
        harness.seen.some((one) => one.includes("灰度比例是多少")),
      );
      // A different conversation is a different target, so it opens its own window.
      await post(harness.base, { conversation: "ops", id: "3", text: "另一个来源" });
      await until("a second window to open", async () =>
        (await harness.journal.list({ kinds: ["window_start"] })).items.length === 2,
      );
      assert.deepEqual(
        (await harness.journal.list({ kinds: ["window_start"] })).items.map((event) => event.window),
        ["c1", "c2"],
      );
    } finally {
      await release(harness);
    }
  });

  it("carries a window's reply back out through the channel", async () => {
    const harness = await host();
    try {
      harness.script([
        fauxAssistantMessage([
          fauxToolCall("send", { to: "http:demo", content: "灰度比例是 10%", reply_to: "http:1" }, { id: "call_1" }),
        ]),
        fauxAssistantMessage("已回复。"),
      ]);
      await post(harness.base, { conversation: "demo", id: "1", text: "灰度比例是多少" });
      await until("the reply to be carried out", async () =>
        harness.channel.list().some((message) => message.direction === "out"),
      );

      // The reply is on the channel, in the conversation the window answered.
      const sent = harness.channel.list().find((message) => message.direction === "out");
      assert.equal(sent?.conversation, "http:demo");
      assert.equal(sent?.text, "灰度比例是 10%");
      assert.equal(sent?.replyTo, "http:1");
      // The effect's result names the native id the channel gave it, so a ref
      // resolves to what was sent.
      const results = await harness.journal.list({ kinds: ["effect_result"] });
      const last = results.items.at(-1);
      assert.equal(last?.external, sent?.external);
      assert.equal(last?.body, "ok");
      // The send is recorded as an effect on the conversation, not on a window.
      const sends = await harness.journal.list({ kinds: ["send"] });
      assert.deepEqual(sends.items.at(-1)?.targets, ["http:demo"]);

      // The page reads both directions of the conversation.
      const page = (await (await fetch(`${harness.base}/api/messages?conversation=demo`)).json()) as {
        items: { direction: string; text: string }[];
      };
      assert.deepEqual(
        page.items.map((item) => `${item.direction} ${item.text}`),
        ["in 灰度比例是多少", "out 灰度比例是 10%"],
      );
    } finally {
      await release(harness);
    }
  });

  it("stores a redelivered message id once", async () => {
    const harness = await host();
    try {
      harness.script([
        async (context: { messages: readonly { role: string }[] }) => {
          harness.seen.push(JSON.stringify(context.messages));
          return fauxAssistantMessage("收到。");
        },
      ]);
      const first = await post(harness.base, { conversation: "demo", id: "7", text: "同一条消息" });
      assert.equal(first.redelivered, false);
      const again = await post(harness.base, { conversation: "demo", id: "7", text: "同一条消息" });
      assert.equal(again.redelivered, true);

      await until("the window to open", async () =>
        (await harness.journal.list({ kinds: ["window_start"] })).items.length === 1,
      );
      // The journal's unique index on the native id is what keeps it once.
      const stored = await harness.journal.list({ external: "http:7" });
      assert.equal(stored.items.length, 1);
      // The page shows it once, and the retry opened no second window.
      assert.equal(harness.channel.list().filter((message) => message.external === "http:7").length, 1);
      assert.equal((await harness.journal.list({ kinds: ["window_start"] })).items.length, 1);
      // The retry is not new input, so no task was recorded for it and the
      // window that answered it was not asked to answer it again.
      assert.equal((await harness.journal.list({ kinds: ["task"] })).items.length, 1);
      assert.equal((await harness.journal.list({ kinds: ["delivery"] })).items.length, 0);
      // The stored copy is what a lookup by native id answers with.
      const found = await harness.channel.get("http:7");
      assert.equal(found?.target, "http:demo");
      assert.equal(found?.stored, false);
    } finally {
      await release(harness);
    }
  });

  it("serves the page and the board it reads", async () => {
    const harness = await host();
    try {
      harness.script([fauxAssistantMessage("收到。")]);
      await post(harness.base, { conversation: "demo", id: "1", text: "你好" });
      await until("the window to open", async () =>
        (await harness.journal.list({ kinds: ["window_start"] })).items.length === 1,
      );

      const page = await fetch(`${harness.base}/`);
      assert.equal(page.status, 200);
      assert.match(page.headers.get("content-type") ?? "", /text\/html/);
      const html = await page.text();
      assert.ok(html.includes("现场板"), "the page holds the board's section");
      const app = await fetch(`${harness.base}/app.js`);
      assert.equal(app.status, 200);
      assert.match(app.headers.get("content-type") ?? "", /javascript/);

      // The state the page polls: the connection, the conversations and the board.
      const state = (await (await fetch(`${harness.base}/api/state`)).json()) as {
        channel: string;
        online: boolean;
        conversations: { target: string; messages: number }[];
        board: { window: string; doing: string; targets: string[] }[];
      };
      assert.equal(state.channel, "http");
      assert.equal(state.online, true);
      assert.deepEqual(state.conversations, [{ target: "http:demo", messages: 1 }]);
      assert.equal(state.board.length, 1);
      assert.equal(state.board[0]?.window, "c1");
      assert.deepEqual(state.board[0]?.targets, ["http:demo"]);
      assert.ok(state.board[0]?.doing.length > 0, "and what the window is doing");

      // A refused message names the rule and the next action, in the core's shape.
      const refused = await fetch(`${harness.base}/webhook`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ conversation: "demo" }),
      });
      assert.equal(refused.status, 500);
      const error = (await refused.json()) as { ok: boolean; error: { rule: string } };
      assert.equal(error.ok, false);
      assert.equal(error.error.rule, "http.webhook.text");
    } finally {
      await release(harness);
    }
  });
});
