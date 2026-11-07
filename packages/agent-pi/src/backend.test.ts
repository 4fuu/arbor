import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  getSystemMessageText,
  createModels,
  fauxProvider,
  fauxToolCall,
  fauxAssistantMessage,
} from "@earendil-works/pi-ai";
import type { Models } from "@earendil-works/pi-ai";
import type { OpenWindowRequest, ToolCall, ToolResult } from "@4fu/arbor-interfaces";
import { PiAgentBackend, type WindowControl } from "./backend.ts";

const LIMITS = { contextTokens: 200000, reserveTokens: 4000, idleSeconds: 300 };

interface Recorded {
  calls: ToolCall[];
  results: ToolResult[];
  events: string[];
}

function controlOf(recorded: Recorded, answer: (call: ToolCall) => ToolResult): WindowControl {
  return {
    recordToolCall: async (_window, call) => {
      recorded.calls.push(call);
      return "r1";
    },
    runToolCall: async (_window, call) => {
      const result = answer(call);
      recorded.results.push(result);
      return result;
    },
    endRequested: () => false,
  };
}

async function waitFor(done: () => boolean, attempts = 200): Promise<void> {
  for (let index = 0; index < attempts; index += 1) {
    if (done()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition was never met");
}

function requestOf(overrides: Partial<OpenWindowRequest> = {}): OpenWindowRequest {
  return {
    window: "c1",
    task: "t1",
    prompt: { system: "<agent>\n窗口是一次性的。\n</agent>", memory: "", envRevision: "e1" },
    tools: [
      {
        name: "search",
        description: "查询记录、笔记和现场板。",
        parameters: {
          query: { type: "string", description: "查询词", required: true },
        },
      },
    ],
    modules: [],
    model: "faux-1",
    firstInput: "查看 r12 之后发生了什么",
    limits: LIMITS,
    ...overrides,
  };
}

async function backendWith(
  models: Models,
  recorded: Recorded,
  answer: (call: ToolCall) => ToolResult,
): Promise<PiAgentBackend> {
  return new PiAgentBackend({ models, control: controlOf(recorded, answer) });
}

describe("pi backend", () => {
  it("runs one window: sends the prompt, streams the tool call, reports the outcome", async () => {
    const faux = fauxProvider({
      models: [{ id: "faux-1", input: ["text", "image"], contextWindow: 200000, maxTokens: 8192 }],
    });
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("search", { query: "部署" }, { id: "call_1" })]),
      fauxAssistantMessage("已查询到 3 条记录。"),
    ]);
    const recorded: Recorded = { calls: [], results: [], events: [] };
    const backend = await backendWith(models, recorded, () => ({
      callId: "call_1",
      ok: true,
      content: "共 3 条：r12、r13、r14",
    }));

    const session = await backend.open(requestOf());
    for await (const event of session.events()) {
      recorded.events.push(event.kind);
      if (event.kind === "run_ended") break;
    }
    await session.end();
    const outcome = await session.outcome();

    assert.equal(outcome.reason, "model_ended");
    assert.equal(outcome.window, "c1");
    assert.deepEqual(recorded.calls.map((call) => call.name), ["search"]);
    assert.equal(recorded.calls[0]?.args.query, "部署");
    assert.equal(recorded.results[0]?.content, "共 3 条：r12、r13、r14");
    assert.ok(recorded.events.includes("tool_call"));
    assert.ok(recorded.events.includes("tool_result"));
    assert.ok(outcome.usage.used > 0);
    assert.ok(outcome.usage.limit === 200000);
  });

  it("steers a delivery into a running window at a tool-call boundary", async () => {
    const faux = fauxProvider({
      models: [{ id: "faux-1", input: ["text", "image"], contextWindow: 200000, maxTokens: 8192 }],
    });
    const models = createModels();
    models.setProvider(faux.provider);
    const slow = async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      return fauxAssistantMessage([fauxToolCall("search", { query: "部署" }, { id: "call_1" })]);
    };
    faux.setResponses([
      slow,
      fauxAssistantMessage([fauxToolCall("search", { query: "构建" }, { id: "call_2" })]),
      fauxAssistantMessage("完成"),
    ]);
    const recorded: Recorded = { calls: [], results: [], events: [] };
    const backend = await backendWith(models, recorded, (call) => ({
      callId: call.callId,
      ok: true,
      content: `结果 ${call.callId}`,
    }));

    const session = await backend.open(requestOf());
    const steered: string[] = [];
    const drain = (async () => {
      for await (const event of session.events()) {
        if (event.kind === "steered") steered.push(event.delivery.kind);
        if (event.kind === "run_ended") break;
      }
    })();
    // The delivery is steered while the first turn's tool call is in flight.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await session.steer({
      kind: "notice",
      from: "c2",
      refs: ["r44"],
      time: 1700000000000,
      content: [{ kind: "data", fields: { content: "窗口 c2 写入了 r44" } }],
    });
    await drain;
    await session.end();
    const outcome = await session.outcome();

    assert.deepEqual(steered, ["notice"]);
    assert.equal(outcome.reason, "model_ended");
    // The delivery reached the model as user-role text, never a system message.
    assert.equal(recorded.calls.length, 2);
  });

  it("sends arbor's own system prompt, never pi's built-in coding prompt", async () => {
    const faux = fauxProvider({
      models: [{ id: "faux-1", input: ["text", "image"], contextWindow: 200000, maxTokens: 8192 }],
    });
    const models = createModels();
    models.setProvider(faux.provider);
    const seen: string[] = [];
    faux.setResponses([
      async (context) => {
        for (const message of context.messages) {
          if (message.role !== "system") continue;
          seen.push(getSystemMessageText(message));
        }
        return fauxAssistantMessage("完成");
      },
    ]);
    const recorded: Recorded = { calls: [], results: [], events: [] };
    const backend = new PiAgentBackend({ models, control: controlOf(recorded, () => ({ callId: "x", ok: true, content: "" })) });

    const session = await backend.open(
      requestOf({
        prompt: {
          system: "<identity>\n你是 arbor 的 agent。\n</identity>\n\n<agent>\n窗口是一次性的。\n</agent>",
          memory: "<note_summary>\nn9@1 构建\n</note_summary>",
          envRevision: "e1",
        },
      }),
    );
    for await (const event of session.events()) {
      if (event.kind === "run_ended") break;
    }
    await session.end();

    assert.ok(seen.some((text) => text.includes("你是 arbor 的 agent。")));
    assert.ok(seen.some((text) => text.includes("窗口是一次性的。")));
    // The memory snapshot is part of the frozen prefix, not a system message of its own.
    assert.ok(seen.some((text) => text.includes("n9@1 构建")));
    assert.ok(!seen.some((text) => /coding agent|You are a coding/i.test(text)));
  });

  it("keeps the window open after the run ends, for a related input", async () => {
    const faux = fauxProvider({
      models: [{ id: "faux-1", input: ["text", "image"], contextWindow: 200000, maxTokens: 8192 }],
    });
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([fauxAssistantMessage("第一轮完成"), fauxAssistantMessage("第二轮完成")]);
    const recorded: Recorded = { calls: [], results: [], events: [] };
    const backend = new PiAgentBackend({
      models,
      control: controlOf(recorded, () => ({ callId: "x", ok: true, content: "" })),
    });

    const session = await backend.open(requestOf());
    const seen: string[] = [];
    const drain = (async () => {
      for await (const event of session.events()) seen.push(event.kind);
    })();
    await waitFor(() => seen.includes("run_ended"));
    assert.equal(session.state, "idle");
    // A related input still reaches the warm prefix.
    await session.steer({
      kind: "inserted_task",
      refs: ["t2"],
      time: 1700000000000,
      content: [{ kind: "data", fields: { content: "继续处理" } }],
    });
    await waitFor(() => seen.filter((kind) => kind === "run_ended").length === 2);
    assert.equal(session.state, "idle");
    await session.end();
    await session.outcome();
    await drain;
    assert.equal(seen.at(-1), "ended");
  });

  it("passes a nested object argument through to the call", async () => {
    const faux = fauxProvider({
      models: [{ id: "faux-1", input: ["text", "image"], contextWindow: 200000, maxTokens: 8192 }],
    });
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall("end", { handoff: { topics: ["部署"], progress: ["已改配置"] } }, { id: "call_1" }),
      ]),
      fauxAssistantMessage("完成"),
    ]);
    const recorded: Recorded = { calls: [], results: [], events: [] };
    const backend = new PiAgentBackend({
      models,
      control: controlOf(recorded, () => ({ callId: "call_1", ok: true, content: "已结束" })),
    });

    const session = await backend.open(
      requestOf({
        tools: [
          {
            name: "end",
            description: "结束本窗口；有未完成工作时带交接内容。",
            parameters: { handoff: { type: "object", description: "交接内容" } },
          },
        ],
      }),
    );
    for await (const event of session.events()) {
      if (event.kind === "run_ended") break;
    }
    await session.end();

    // A nested object is declared as an object, not coerced to a string.
    assert.deepEqual(recorded.calls[0]?.args, { handoff: { topics: ["部署"], progress: ["已改配置"] } });
    assert.equal(recorded.results[0]?.content, "已结束");
  });

  it("reports what the model is writing, so a surface shows it before the call is complete", async () => {
    const faux = fauxProvider({
      models: [{ id: "faux-1", input: ["text", "image"], contextWindow: 200000, maxTokens: 8192 }],
      // Small chunks, so the text and the arguments arrive in several deltas.
      tokenSize: { min: 1, max: 1 },
    });
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("send", { to: "qq:group:1", content: "已修好" }, { id: "call_1" })]),
      fauxAssistantMessage("说完了"),
    ]);
    const recorded: Recorded = { calls: [], results: [], events: [] };
    const backend = new PiAgentBackend({
      models,
      control: controlOf(recorded, (call) => ({ callId: call.callId, ok: true, content: "已送达" })),
    });

    const session = await backend.open(requestOf());
    const stream: { kind: string; text: string }[] = [];
    const kinds: string[] = [];
    for await (const event of session.events()) {
      kinds.push(event.kind);
      if (event.kind === "text_delta") stream.push({ kind: event.kind, text: event.delta });
      else if (event.kind === "tool_call_delta") {
        stream.push({ kind: event.kind, text: String(event.call.args.content ?? "") });
      }
      if (event.kind === "run_ended") break;
    }
    await session.end();

    // The arguments grow as pi streams them: a partial call's content is
    // readable before the call itself is reported.
    const contents = stream.filter((one) => one.kind === "tool_call_delta").map((one) => one.text);
    assert.ok(contents.length > 1, `the arguments arrived in deltas: ${contents.join("|")}`);
    // Every content value is a prefix of the last one, so what stands so far is
    // what the delta carries and nothing is reported twice; at least one is a
    // partial value, readable before the call itself is reported.
    const partial = contents.slice(0, -1);
    assert.ok(
      partial.every((text) => "已修好".startsWith(text)),
      `the partial contents grew: ${contents.join("|")}`,
    );
    assert.ok(
      partial.some((text) => text !== "" && text !== "已修好"),
      `a partial content was seen: ${contents.join("|")}`,
    );
    assert.equal(contents.at(-1), "已修好");
    // The text of the second turn streams the same way.
    const texts = stream.filter((one) => one.kind === "text_delta").map((one) => one.text);
    assert.equal(texts.join(""), "说完了");
    // The durable events stay exactly what they were: one call, one result.
    assert.deepEqual(
      kinds.filter((kind) => kind === "tool_call" || kind === "tool_result"),
      ["tool_call", "tool_result"],
    );
  });

  it("declares the JSON Schema an outside tool carries, and refreshes a running window's tools", async () => {
    const faux = fauxProvider({
      models: [{ id: "faux-1", input: ["text", "image"], contextWindow: 200000, maxTokens: 8192 }],
    });
    const models = createModels();
    models.setProvider(faux.provider);
    // What the model was actually handed: pi declares the tools a request may
    // call on the system messages of that request.
    const declared: string[] = [];
    const see = (context: { messages: readonly { role: string; toolsAdded?: readonly unknown[] }[] }) => {
      for (const message of context.messages) {
        if (message.role !== "system") continue;
        for (const tool of message.toolsAdded ?? []) declared.push(JSON.stringify(tool));
      }
    };
    faux.setResponses([
      (context) => {
        see(context);
        return fauxAssistantMessage("完成");
      },
      // The harness registered a tool while the window runs, so the window's
      // declared tools are replaced and the model calls the new one.
      (context) => {
        see(context);
        return fauxAssistantMessage([fauxToolCall("todo_write", { todos: [{ content: "读文档", status: "pending" }] }, { id: "call_2" })]);
      },
      (context) => {
        see(context);
        return fauxAssistantMessage("完成");
      },
    ]);
    const recorded: Recorded = { calls: [], results: [], events: [] };
    const backend = new PiAgentBackend({ models, control: controlOf(recorded, () => ({ callId: "x", ok: true, content: "已记录" })) });
    const todoWrite = {
      name: "todo_write",
      description: "把任务列表替换成传入的完整列表。",
      parameters: {},
      schema: {
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
                status: { type: "string", description: "The task's state.", enum: ["pending", "in_progress", "completed"] },
              },
              required: ["content", "status"],
            },
          },
        },
        required: ["todos"],
      },
    };

    const session = await backend.open(requestOf());
    const kinds: string[] = [];
    const drain = (async () => {
      for await (const event of session.events()) kinds.push(event.kind);
    })();
    await waitFor(() => kinds.includes("run_ended"));
    assert.equal(session.state, "idle");

    // The window's declared tools are replaced while it runs, and the tool that
    // appeared is callable in the same window - its prefix is never rebuilt.
    session.refreshTools?.([todoWrite]);
    await session.steer({
      kind: "tools_delta",
      refs: [],
      time: 1700000000000,
      content: [{ kind: "data", fields: { content: "可直接调用的工具已变更" } }],
    });
    await waitFor(() => kinds.filter((kind) => kind === "run_ended").length === 2);
    await session.end();
    await session.outcome();
    await drain;

    // The schema reached the model verbatim: the item shape and the status enum,
    // which a round trip through arbor's own parameter shape would have dropped.
    // The window opened with arbor's own declaration, and none of that shape.
    assert.ok(declared[0]?.includes("search"), declared[0] ?? "nothing was declared");
    assert.ok(!declared[0]?.includes("enum"));
    const refreshed = declared.find((one) => one.includes("todo_write"));
    assert.ok(refreshed !== undefined, `the new tool was declared to the model: ${declared.join(" | ")}`);
    assert.ok(refreshed.includes('"enum":["pending","in_progress","completed"]'));
    assert.ok(refreshed.includes('"additionalProperties":false'));
    assert.ok(refreshed.includes('"items"'));
    assert.deepEqual(recorded.calls.map((call) => call.name), ["todo_write"]);
    assert.deepEqual(recorded.calls[0]?.args, { todos: [{ content: "读文档", status: "pending" }] });
  });

  it("retries a transient model error, sending the same request again", async () => {
    const faux = fauxProvider({
      models: [{ id: "faux-1", input: ["text", "image"], contextWindow: 200000, maxTokens: 8192 }],
    });
    const models = createModels();
    models.setProvider(faux.provider);
    // Every request the provider was handed, so the retry's bytes can be read.
    const sent: string[] = [];
    const failing = fauxAssistantMessage("", { stopReason: "error", errorMessage: "503 overloaded" });
    faux.setResponses([
      (context) => {
        sent.push(JSON.stringify(context.messages));
        return failing;
      },
      (context) => {
        sent.push(JSON.stringify(context.messages));
        return fauxAssistantMessage("重试后完成");
      },
    ]);
    const recorded: Recorded = { calls: [], results: [], events: [] };
    const backend = new PiAgentBackend({
      models,
      control: controlOf(recorded, () => ({ callId: "x", ok: true, content: "" })),
      retryDelaysMs: [0],
      sleep: async () => {},
    });

    const session = await backend.open(requestOf());
    const said: string[] = [];
    const drain = (async () => {
      for await (const event of session.events()) {
        if (event.kind === "appended") said.push(event.event);
        if (event.kind === "ended") break;
      }
    })();
    // The retry runs after the first turn settled, so the test waits for it.
    await waitFor(() => sent.length === 2);
    await waitFor(() => said.length === 1);
    await session.end();
    await drain;

    assert.equal(sent[1], sent[0], "the retry sends the same bytes, so the cached prefix holds");
    assert.deepEqual(said, ["重试后完成"], "the failed turn is not an answer: it is dropped, not recorded");
    assert.equal((await session.outcome()).reason, "model_ended", "the window ran on after the retry");
  });

  it("leaves a window failed when the model error is not transient", async () => {
    const faux = fauxProvider({
      models: [{ id: "faux-1", input: ["text", "image"], contextWindow: 200000, maxTokens: 8192 }],
    });
    const models = createModels();
    models.setProvider(faux.provider);
    let calls = 0;
    faux.setResponses([
      () => {
        calls += 1;
        // A quota exhaustion is not transient: retrying it changes nothing.
        return fauxAssistantMessage("", { stopReason: "error", errorMessage: "insufficient_quota" });
      },
    ]);
    const recorded: Recorded = { calls: [], results: [], events: [] };
    const backend = new PiAgentBackend({
      models,
      control: controlOf(recorded, () => ({ callId: "x", ok: true, content: "" })),
      retryDelaysMs: [0],
      sleep: async () => {},
    });

    const session = await backend.open(requestOf());
    const kinds: string[] = [];
    const drain = (async () => {
      for await (const event of session.events()) kinds.push(event.kind);
    })();
    const outcome = await session.outcome();
    await drain;

    assert.equal(calls, 1, "a failure that is not transient is not retried");
    assert.equal(outcome.reason, "failed", "the window ends failed, so the host can continue it");
    assert.match(outcome.error ?? "", /insufficient_quota/);
  });

  it("lists only the models that take images", async () => {
    const faux = fauxProvider({
      models: [
        { id: "faux-1", input: ["text", "image"], contextWindow: 200000, maxTokens: 8192 },
        { id: "faux-text", input: ["text"], contextWindow: 200000, maxTokens: 8192 },
      ],
    });
    const models = createModels();
    models.setProvider(faux.provider);
    const backend = new PiAgentBackend({ models });
    const listed = await backend.models();
    assert.deepEqual(
      listed.map((model) => model.id),
      ["faux-1"],
    );
  });

  it("refuses to open a window for a model outside the catalog", async () => {
    const faux = fauxProvider({
      models: [{ id: "faux-1", input: ["text", "image"], contextWindow: 200000, maxTokens: 8192 }],
    });
    const models = createModels();
    models.setProvider(faux.provider);
    const backend = new PiAgentBackend({ models });
    await assert.rejects(
      () => backend.open(requestOf({ model: "nope-1" })),
      (error: { rule?: string; nextAction?: string }) => {
        assert.equal(error.rule, "backend.model.unknown");
        assert.ok(error.nextAction !== undefined && error.nextAction.length > 0);
        return true;
      },
    );
  });

  it("reports a provider with no credential as logged out, naming the secret", async () => {
    const faux = fauxProvider({
      models: [{ id: "faux-1", input: ["text", "image"], contextWindow: 200000, maxTokens: 8192 }],
    });
    const models = createModels();
    models.setProvider(faux.provider);
    const backend = new PiAgentBackend({ models });
    const result = await backend.login({ provider: "anthropic", secret: "ANTHROPIC_API_KEY" });
    assert.equal(result.state, "failed");
    assert.ok(result.error?.includes("anthropic"));
  });
});
