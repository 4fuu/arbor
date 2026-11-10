/**
 * The whole stack, end to end: the pi backend, the prompt layers, the tools and
 * the window lifecycle, driven by pi's scripted faux provider.
 *
 * This is the one test that crosses every package. It needs no API key, and it
 * proves the seams hold: no pi type crosses the interface, the host's renderer
 * is the one the model reads, and a tool call reaches the service layer and
 * comes back as the core's own result.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@4fu/arbor-agent-pi/testing";
import { SqliteJournal } from "@4fu/arbor-journal-sqlite";
import { DirectoryWorkspace } from "@4fu/arbor-workspace-dir";
import { PiAgentBackend } from "@4fu/arbor-agent-pi";
import type { ExternalRef, Judge, JudgeAnswer, JudgeRequest } from "@4fu/arbor-interfaces";
import { Arbor } from "./host.ts";
import { ManualTimers } from "./testing.ts";

const FAUX_MODEL = {
  id: "faux-1",
  input: ["text", "image"] as ("text" | "image")[],
  contextWindow: 200000,
  maxTokens: 8192,
};

/**
 * The judge this stack is wired with: every batch opens a window, except the
 * third, which goes to the window already in the conversation. The decision
 * count is the script, because every batch makes exactly one route request.
 */
class StackJudge implements Judge {
  readonly name = "stack";
  private routes = 0;

  async decide(request: JudgeRequest): Promise<JudgeAnswer> {
    if (request.decision === "filter") return { decision: "filter", needsHandling: true };
    if (request.decision === "model_tier") return { decision: "model_tier", tier: "" };
    if (request.decision === "route") {
      this.routes += 1;
      // Every batch opens a window, except the third, which the window already
      // in the conversation takes as an inserted input.
      const wanted = this.routes >= 3 ? "c1" : "new";
      return {
        decision: "route",
        scores: [
          { item: wanted, score: 3 },
          { item: "new", score: 0 },
        ],
        best: wanted,
      };
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

async function stack(): Promise<{ arbor: Arbor; journal: SqliteJournal; script: (steps: readonly unknown[]) => void }> {
  const journal = new SqliteJournal({ path: ":memory:" });
  const root = await tempDir("arbor-stack-");
  const faux = fauxProvider({ models: [FAUX_MODEL] });
  const models = createModels();
  models.setProvider(faux.provider);
  const backend = new PiAgentBackend({ models });
  const arbor = new Arbor({
    journal,
    backend,
    timers: new ManualTimers(),
    now: () => 1700000000000,
    workspace: new DirectoryWorkspace({ root }),
    judge: new StackJudge(),
    // This test is the seam, not the handoff floor: it ends one window by hand
    // to prove the handoff crosses every layer.
    settings: { window: { handoffFloor: 0 } },
  });
  return { arbor, journal, script: (steps) => faux.setResponses(steps as never) };
}

const task = {
  kind: "batch" as const,
  reason: "确认部署流程",
  targets: ["gh:pr:57"],
  time: 1700000000000,
  content: [{ kind: "data" as const, fields: { content: "部署流程是什么" } }],
};

/** Let the window's run finish before a test reads the journal. */
async function settle(): Promise<void> {
  for (let index = 0; index < 60; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("the whole stack", () => {
  it("runs one window over pi, with a tool call and a handoff", async () => {
    const { arbor, journal, script } = await stack();
    script([
      fauxAssistantMessage([fauxToolCall("search", { query: "部署" }, { id: "call_1" })]),
      fauxAssistantMessage([
        fauxToolCall(
          "end",
          {
            handoff: {
              topics: ["部署"],
              progress: ["已查询记录"],
              pending: ["等待确认"],
              agreements: ["先灰度"],
              refs: ["r1"],
            },
          },
          { id: "call_2" },
        ),
      ]),
      fauxAssistantMessage("交接完成"),
    ]);

    await arbor.open(task);
    await settle();

    const calls = await journal.list({ kinds: ["tool_call"] });
    assert.deepEqual(
      calls.items.map((event) => event.window),
      ["c1", "c1"],
    );
    const results = await journal.list({ kinds: ["tool_result"] });
    assert.ok(results.items[0]?.body?.includes("确认部署流程"));
    assert.ok(results.items[1]?.body?.includes("窗口 c1 已结束"));

    // The window ended with a handoff, so the host opened a continuation.
    const started = await journal.list({ kinds: ["window_start"] });
    assert.equal(started.items.length, 2);
    assert.equal(started.items[1]?.window, "c2");
    assert.ok(started.items[1]?.refs.includes("c1"));
    const ended = await journal.list({ kinds: ["window_end"] });
    assert.equal(ended.items[0]?.window, "c1");
    assert.equal(JSON.parse(ended.items[0]?.body ?? "{}").reason, "model_ended");
  });

  it("sends arbor's own prefix, and pi's coding prompt never reaches the model", async () => {
    const { arbor, script } = await stack();
    const seen: string[] = [];
    script([
      async (context: { messages: readonly { role: string }[] }) => {
        for (const message of context.messages) {
          if (message.role !== "system") continue;
          seen.push(JSON.stringify(message));
        }
        return fauxAssistantMessage("完成");
      },
    ]);

    await arbor.open(task);
    await settle();

    const text = seen.join("\n");
    assert.ok(text.includes("<agent>"));
    assert.ok(text.includes("<tools>"));
    assert.ok(text.includes("search："));
    assert.ok(text.includes("journal："));
    assert.ok(!text.includes("coding agent"));
  });

  it("writes a file through the mount's own capability", async () => {
    const { arbor, journal, script } = await stack();
    script([
      fauxAssistantMessage([fauxToolCall("write", { path: "notes/a.txt", text: "已确认" }, { id: "call_1" })]),
      fauxAssistantMessage("完成"),
    ]);

    await arbor.open(task);
    await settle();

    const results = await journal.list({ kinds: ["tool_result"] });
    assert.ok(results.items[0]?.body?.includes("已写入 notes/a.txt"));
    // No event carries a snapshot id: the directory holds the file, and nothing
    // names a state of it.
    for (const event of results.items) assert.equal("snapshot" in event, false);
  });

  it("runs several windows at once, and steers a new message into the one in the conversation", async () => {
    const { arbor, journal, script } = await stack();
    const seen: string[] = [];
    const record = async (context: { messages: readonly { role: string; content: unknown }[] }) => {
      seen.push(JSON.stringify(context.messages));
      return fauxAssistantMessage("完成");
    };
    script([record, record, record, record, record, record, record, record]);
    const message = (external: ExternalRef, text: string) => ({
      source: "qq",
      external,
      target: "qq:group:1",
      time: 1700000000000,
      content: [{ kind: "data", fields: { content: text } }],
    });

    // Three messages on one conversation: two of them open windows, and the
    // third is routed into the window that is already in it.
    await arbor.ingest([message("qq:100", "部署流程是什么")]);
    await settle();
    await arbor.ingest([message("qq:101", "灰度比例是多少")]);
    await settle();

    const started = await journal.list({ kinds: ["window_start"] });
    assert.equal(started.items.length, 2, "two windows run at once");
    assert.deepEqual(
      started.items.map((event) => event.window),
      ["c1", "c2"],
    );
    // A new window's first input lists the live windows related to its task.
    assert.ok(seen[1]?.includes("c1"), "the second window's first input names the first");
    assert.ok(seen[1]?.includes("目标：qq:group:1"), "and the target they share");

    await arbor.ingest([message("qq:102", "那把测试修了")]);
    await settle();

    assert.ok(seen.some((one) => one.includes("那把测试修了")), "the new message reached a model");
    assert.ok(seen.some((one) => one.includes("任务 t3")), "it went in as the task the judge routed");
    const deliveries = await journal.list({ kinds: ["delivery"] });
    assert.ok(
      deliveries.items.some((event) => event.window === "c1" && (event.body ?? "").includes("任务 t3")),
      "c1 is the window that took it",
    );
    const board = arbor.boardLines();
    assert.equal(board.length, 2);
    assert.ok(board.every((line) => line.targets.includes("qq:group:1")));
  });
});
