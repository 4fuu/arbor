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
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@arbor/agent-pi/testing";
import { SqliteJournal } from "@arbor/journal-sqlite";
import { DirectoryWorkspace } from "@arbor/workspace-dir";
import { PiAgentBackend } from "@arbor/agent-pi";
import { Arbor } from "./host.ts";
import { ManualTimers } from "./testing.ts";

const FAUX_MODEL = {
  id: "faux-1",
  input: ["text", "image"] as ("text" | "image")[],
  contextWindow: 200000,
  maxTokens: 8192,
};

async function stack(): Promise<{ arbor: Arbor; journal: SqliteJournal; script: (steps: readonly unknown[]) => void }> {
  const journal = new SqliteJournal({ path: ":memory:" });
  const root = await mkdtemp(join(tmpdir(), "arbor-stack-"));
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

  it("writes a file through the mount's own capability and records its snapshot", async () => {
    const { arbor, journal, script } = await stack();
    script([
      fauxAssistantMessage([fauxToolCall("write", { path: "notes/a.txt", text: "已确认" }, { id: "call_1" })]),
      fauxAssistantMessage("完成"),
    ]);

    await arbor.open(task);
    await settle();

    const results = await journal.list({ kinds: ["tool_result"] });
    assert.ok(results.items[0]?.body?.includes("已写入 notes/a.txt"));
    // Every write ends with a snapshot, recorded at the event it happened at.
    assert.match(results.items[0]?.snapshot ?? "", /^ws1@r\d+$/);
    const calls = await journal.list({ kinds: ["tool_call"] });
    assert.equal(results.items[0]?.snapshot, `ws1@${calls.items[0]?.ref}`);
  });
});
