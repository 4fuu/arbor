/**
 * Direct tools declared from outside the core: a plugin's own, and the ones a
 * backend injects from the harness the host is embedded in
 * (docs/tools.md#external-tools).
 *
 * The two take one shape and reach the model the same way, so what is tested
 * here is the path they share: a harness whose plugins register tools at runtime
 * must reach the model without a restart, and the JSON Schema such a tool
 * declares must survive the trip whole - what the backend hands the model, and
 * what the `<tools>` line and `tool_search` show.
 */

import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { SqliteJournal } from "@4fu/arbor-journal-sqlite";
import { DirectoryWorkspace } from "@4fu/arbor-workspace-dir";
import type { ExternalTool, Plugin, ToolResult } from "@4fu/arbor-interfaces";
import { Arbor } from "./host.ts";
import { ManualTimers, ScriptedBackend, turn } from "./testing.ts";

/** Let the host's watchers run, so a test observes what it recorded. */
async function settle(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await turn();
}

/**
 * Wait for a delivery to reach the journal. The host hands each delta on
 * without waiting for the window, so a test waits for what it expects rather
 * than for a fixed number of passes.
 */
async function delivered(journal: SqliteJournal, marker: string): Promise<string | undefined> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const found = (await journal.list({ kinds: ["delivery"] }))
      .items.map((event) => event.body ?? "")
      .find((body) => body.includes(marker));
    if (found !== undefined) return found;
    await turn();
  }
  return undefined;
}

/**
 * The schema DSH's `todo_write` registered, the shape a round trip through
 * arbor's own parameter declaration used to lose: the item object, the status
 * enum, `additionalProperties`.
 */
const TODO_WRITE_SCHEMA = {
  type: "object",
  properties: {
    todos: {
      type: "array",
      description: "The COMPLETE task list, replacing any previous list.",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          content: { type: "string", description: "One task." },
          status: {
            type: "string",
            description: "The task's state.",
            enum: ["pending", "in_progress", "completed"],
          },
        },
        required: ["content", "status"],
      },
    },
  },
  required: ["todos"],
};

/** The tool that schema belongs to, as the harness around the host declared it. */
function todoWrite(calls: Record<string, unknown>[]): ExternalTool {
  return {
    name: "todo_write",
    description: "把任务列表替换成传入的完整列表。",
    schema: TODO_WRITE_SCHEMA,
    execute: async (request): Promise<ToolResult> => {
      calls.push(request.args);
      return { callId: request.callId, ok: true, content: "已记录 2 项" };
    },
  };
}

interface Harness {
  arbor: Arbor;
  journal: SqliteJournal;
  backend: ScriptedBackend;
}

async function host(
  options: { backend?: ScriptedBackend; plugins?: readonly Plugin[] } = {},
): Promise<Harness> {
  const journal = new SqliteJournal({ path: ":memory:" });
  const root = await mkdtemp(join(tmpdir(), "arbor-external-"));
  const backend = options.backend ?? new ScriptedBackend();
  const arbor = new Arbor({
    journal,
    backend,
    timers: new ManualTimers(),
    now: () => 1700000000000,
    workspace: new DirectoryWorkspace({ root }),
    ...(options.plugins === undefined ? {} : { plugins: options.plugins }),
  });
  backend.attach(arbor.windowControl());
  return { arbor, journal, backend };
}

const task = {
  kind: "batch" as const,
  reason: "查看 CI 结果",
  targets: ["gh:pr:57"],
  time: 1700000000000,
  content: [{ kind: "data" as const, fields: { content: "CI 红了" } }],
};

/** One step of usage, which is where the host asks whether anything moved. */
const STEP = { used: 1000, limit: 200000, reserve: 4000 };

describe("external tools that change while the host runs", () => {
  it("gives a running window the tool its harness registers later, as a delta at the next tool-call boundary", async () => {
    const calls: Record<string, unknown>[] = [];
    const backend = new ScriptedBackend();
    // The harness's own plugin: registering a tool at runtime is what one does,
    // and the tool it registers is handed to the model the way any external
    // tool is - under its own name, called through the same path.
    const registrar: Plugin = {
      name: "harness",
      tools: [
        {
          name: "harness_register",
          description: "注册 harness 的工具。",
          parameters: {},
          execute: async (request): Promise<ToolResult> => {
            backend.injected.push(todoWrite(calls));
            return { callId: request.callId, ok: true, content: "已注册 todo_write" };
          },
        },
      ],
    };
    const { arbor, journal } = await host({ backend, plugins: [registrar] });
    backend.script([
      // The harness registers the tool while the window runs.
      { tool: "harness_register", args: {} },
      // One step later the host reads the tool sources again, and what moved
      // goes in at the next tool-call boundary - the window's prefix is never
      // rebuilt for it.
      { usage: STEP },
      { text: "完成" },
    ]);

    await arbor.open(task);
    await backend.finished();

    // The running window's own declaration was refreshed, so the tool it was
    // just told about is one it can call.
    const session = backend.running()[0];
    assert.ok(session !== undefined, "the window is still the backend's");
    assert.ok(
      (session.refreshed.at(-1) ?? []).some((tool) => tool.name === "todo_write"),
      "the running window's declared tools were refreshed",
    );
    // And the window was told: one delta naming what arrived.
    const delta = await delivered(journal, "todo_write");
    assert.match(delta ?? "", /\+ todo_write（来自scripted）/);
    assert.ok(delta?.includes("本窗口可直接调用的工具已变更"), "the delta says what it is");
    // The prompt the window opened with is the one it keeps.
    assert.ok(!(backend.opened[0]?.prompt.system ?? "").includes("todo_write"));

    // A window opened after the change gets the current set in its own request
    // and in its own prefix, with no delta of its own opening.
    backend.script([{ tool: "todo_write", args: { todos: [] } }, { text: "第二轮" }]);
    await arbor.open({ ...task, reason: "再跑一次" });
    await backend.finished();
    assert.ok((backend.opened[1]?.tools ?? []).some((tool) => tool.name === "todo_write"));
    assert.ok((backend.opened[1]?.prompt.system ?? "").includes("todo_write"));
    assert.equal((await journal.list({ kinds: ["delivery"] })).items.length, 1);
    assert.deepEqual(calls, [{ todos: [] }]);
    assert.equal(arbor.live()[0]?.state, "idle", "the window ran to its end all the same");
  });

  it("stops declaring a tool the harness drops, so a window opened after cannot call it", async () => {
    const calls: string[] = [];
    const dropped: ExternalTool = {
      name: "dsh_review",
      description: "评审一段改动。",
      parameters: { text: { type: "string", description: "内容", required: true } },
      execute: async (request): Promise<ToolResult> => {
        calls.push("dsh_review");
        return { callId: request.callId, ok: true, content: "评审完成" };
      },
    };
    const backend = new ScriptedBackend();
    backend.injected.push(dropped);
    const registrar: Plugin = {
      name: "harness",
      tools: [
        {
          name: "harness_drop",
          description: "注销 harness 的工具。",
          parameters: {},
          execute: async (request): Promise<ToolResult> => {
            backend.injected.splice(0, backend.injected.length);
            return { callId: request.callId, ok: true, content: "已注销 dsh_review" };
          },
        },
      ],
    };
    const { arbor, journal } = await host({ backend, plugins: [registrar] });
    backend.script([
      { tool: "dsh_review", args: { text: "src/app.ts" } },
      { tool: "harness_drop", args: {} },
      { usage: STEP },
      { text: "第一轮" },
    ]);
    await arbor.open(task);
    await backend.finished();
    await settle();

    // The window that had the tool is told it left, at its next boundary.
    const delta = await delivered(journal, "dsh_review");
    assert.match(delta ?? "", /- dsh_review（来自scripted）/);
    assert.ok(
      (backend.running()[0]?.refreshed.at(-1) ?? []).every((tool) => tool.name !== "dsh_review"),
      "the running window's declaration no longer carries it",
    );

    // A window opened after the drop neither declares it nor can call it.
    backend.script([{ tool: "dsh_review", args: { text: "src/app.ts" } }, { text: "第二轮" }]);
    await arbor.open({ ...task, reason: "再跑一次" });
    await backend.finished();
    assert.ok(!(backend.opened[1]?.tools ?? []).some((tool) => tool.name === "dsh_review"));
    const results = await journal.list({ kinds: ["tool_result"] });
    assert.ok((results.items.at(-1)?.body ?? "").includes("tool.unknown"));
    assert.deepEqual(calls, ["dsh_review"], "the dropped tool ran once, before it was dropped");
  });

  it("records a collision with its rule on every refresh, and a plugin's tools may be a source", async () => {
    const shadow: ExternalTool = {
      name: "send",
      description: "另一个发送。",
      parameters: {},
      execute: async (request): Promise<ToolResult> => ({
        callId: request.callId,
        ok: true,
        content: "不应该到达",
      }),
    };
    // A plugin whose tool set is a source: the host reads it again on every
    // refresh, so the plugin answers with what stands now.
    const declared: ExternalTool[] = [];
    const harness: Plugin = { name: "harness", tools: () => declared };
    const claimer: Plugin = {
      name: "claimer",
      tools: [
        {
          name: "harness_claim",
          description: "让 harness 注册一个工具。",
          parameters: {},
          execute: async (request): Promise<ToolResult> => {
            declared.push(shadow);
            return { callId: request.callId, ok: true, content: "已注册" };
          },
        },
      ],
    };
    const { arbor, journal, backend } = await host({ plugins: [harness, claimer] });
    backend.script([
      { tool: "harness_claim", args: {} },
      { usage: STEP },
      { text: "完成" },
    ]);
    await arbor.open(task);
    await backend.finished();
    await settle();

    // The collision is recorded, not thrown, and the core's own `send` stands.
    const refused = await journal.list({ kinds: ["tool_registration"] });
    assert.equal(refused.items.length, 1);
    assert.deepEqual(JSON.parse(refused.items[0]?.body ?? "{}"), {
      source: "harness",
      tool: "send",
      rule: "tool.name_taken",
    });
    const prompt = backend.opened[0]?.prompt.system ?? "";
    assert.ok(prompt.includes("send："));
    assert.ok(!prompt.includes("另一个发送"));
  });
});

describe("the JSON Schema an outside harness declares", () => {
  it("reaches the model whole: the backend's declaration, the tools line and tool_search", async () => {
    const calls: Record<string, unknown>[] = [];
    const backend = new ScriptedBackend();
    backend.injected.push(todoWrite(calls));
    const { arbor, journal } = await host({ backend });
    backend.script([
      { tool: "tool_search", args: { keywords: "todo_write" } },
      { tool: "todo_write", args: { todos: [{ content: "读文档", status: "pending" }] } },
      { text: "完成" },
    ]);

    await arbor.open(task);
    await backend.finished();

    // The backend hands the model the schema the harness declared, verbatim:
    // the item shape and the status enum are still there.
    const declared = (backend.opened[0]?.tools ?? []).find((tool) => tool.name === "todo_write");
    assert.deepEqual(declared?.schema, TODO_WRITE_SCHEMA);
    assert.deepEqual(declared?.parameters, {}, "a schema of its own needs no restatement in arbor's shape");

    // The `<tools>` line names it and its source without repeating the schema,
    // which the declaration above already carries.
    const prompt = backend.opened[0]?.prompt.system ?? "";
    assert.ok(prompt.includes("todo_write：把任务列表替换成传入的完整列表。（来自scripted）"));
    assert.ok(!prompt.includes('"enum":["pending","in_progress","completed"]'));

    // `tool_search` answers with the schema.
    const results = await journal.list({ kinds: ["tool_result"] });
    assert.ok((results.items[0]?.body ?? "").includes('"enum":["pending","in_progress","completed"]'));

    // Arbor's own tools are untouched: they declare no schema, and their line is
    // the one it always was.
    const send = (backend.opened[0]?.tools ?? []).find((tool) => tool.name === "send");
    assert.equal(send?.schema, undefined);
    assert.ok(prompt.includes("send：向一个目标发送内容"));
    assert.ok(!prompt.includes("send：向一个目标发送内容参数："));

    // The call itself runs through the same path a core tool takes.
    assert.deepEqual(calls, [{ todos: [{ content: "读文档", status: "pending" }] }]);
    const recorded = await journal.list({ kinds: ["tool_result"] });
    assert.equal(recorded.items.at(-1)?.body, "已记录 2 项");
  });
});
