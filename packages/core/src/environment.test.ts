/**
 * The host's environment: `/env` in the prompt, `reload` as one environment
 * revision, the delta reaching every live window, the settings the model changes
 * itself, and the services the supervisor runs (docs/environment.md).
 *
 * The environment under test is the default one on a real directory, and the
 * supervisor is a test double, so what is checked is the host's own wiring:
 * what it records, what it broadcasts and what it refuses.
 */

import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { DirectoryEnvironment } from "@4fu/arbor-environment-dir";
import { SqliteJournal } from "@4fu/arbor-journal-sqlite";
import { DirectoryWorkspace } from "@4fu/arbor-workspace-dir";
import type {
  EnvDraft,
  LogPage,
  Plugin,
  ServiceSpec,
  ServiceState,
  ServiceStatus,
  Supervisor,
  ToolResult,
  WorkspaceMount,
} from "@4fu/arbor-interfaces";
import type { Hooks } from "@4fu/arbor-interfaces";
import { Arbor } from "./host.ts";
import { callContext } from "@4fu/arbor-tools";
import { ManualTimers, ScriptedBackend } from "./testing.ts";

/** A tiny MCP server that lists one function and answers it. */
const MCP_SERVER = `
const reader = require("node:readline").createInterface({ input: process.stdin });
function send(message) { process.stdout.write(JSON.stringify(message) + "\\n"); }
reader.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "weather", version: "1" } } });
    return;
  }
  if (message.method === "tools/list") {
    send({ jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "forecast", description: "查一个城市的天气", inputSchema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } }] } });
    return;
  }
  if (message.method === "tools/call") {
    send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: message.params.arguments.city + " 晴" }] } });
  }
});
`;

/**
 * Let the host's watchers run, so a test observes what it recorded. A call that
 * reaches an MCP server starts a process, so this waits in real time.
 */
async function settle(): Promise<void> {
  for (let index = 0; index < 60; index += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
}

/** A supervisor a test drives by hand, so no service is really started. */
class FakeSupervisor implements Supervisor {
  readonly started: ServiceSpec[] = [];
  readonly states: ServiceStatus[] = [];
  private handler: ((status: ServiceStatus) => void | Promise<void>) | undefined;
  private state: ServiceState = "running";

  async start(spec: ServiceSpec): Promise<{ name: string; revision: number; state: ServiceState }> {
    this.started.push(spec);
    return { name: spec.name, revision: 1, state: this.state };
  }

  async status(name: string): Promise<ServiceStatus> {
    return {
      name,
      revision: 1,
      state: this.state,
      restarts: 0,
      since: 1700000000000,
      ports: [],
      refs: [],
    };
  }

  async stop(): Promise<void> {
    this.state = "stopped";
  }

  async restart(name: string): Promise<{ name: string; revision: number; state: ServiceState }> {
    return { name, revision: 1, state: this.state };
  }

  async logs(name: string): Promise<LogPage> {
    return { name, items: ["一行输出"], total: 1, limit: 20, nextCall: "services.logs(name)" };
  }

  onStateChange(handler: (status: ServiceStatus) => void | Promise<void>): void {
    this.handler = handler;
  }

  /** Report one state change the way the real supervisor does. */
  async report(name: string, state: ServiceState): Promise<void> {
    this.state = state;
    const status = await this.status(name);
    this.states.push(status);
    await this.handler?.(status);
  }
}

interface Harness {
  arbor: Arbor;
  journal: SqliteJournal;
  backend: ScriptedBackend;
  workspace: DirectoryWorkspace;
  environment: DirectoryEnvironment;
  supervisor: FakeSupervisor;
  /** The window's own directory, so a test writes a draft into it. */
  work(window: string): Promise<WorkspaceMount>;
  hooks: Hooks[];
  /** Move the clock, so a test crosses a snapshot epoch. */
  advance(ms: number): void;
}

async function host(options: { plugins?: readonly Plugin[] } = {}): Promise<Harness> {
  const journal = new SqliteJournal({ path: ":memory:" });
  const root = await mkdtemp(join(tmpdir(), "arbor-core-env-"));
  const backend = new ScriptedBackend();
  const workspace = new DirectoryWorkspace({ root: join(root, "ws") });
  const supervisor = new FakeSupervisor();
  const environment = new DirectoryEnvironment({
    root: join(root, "env"),
    mount: "/env",
    supervisor,
    now: () => 1700000000000,
  });
  const hooks: Hooks[] = (options.plugins ?? []).map((plugin) => plugin.hooks ?? {});
  let clock = 1700000000000;
  const arbor = new Arbor({
    journal,
    backend,
    timers: new ManualTimers(),
    now: () => clock,
    workspace,
    environment,
    supervisor,
    plugins: options.plugins,
  });
  backend.attach(arbor.windowControl());
  const mounts = new Map<string, WorkspaceMount>();
  return {
    arbor,
    journal,
    backend,
    workspace,
    environment,
    supervisor,
    hooks,
    work: async (window) => {
      const found = mounts.get(window);
      if (found !== undefined) return found;
      const mount = (await arbor.services.ensureWorkspace(window as `c${number}`)) as WorkspaceMount;
      mounts.set(window, mount);
      return mount;
    },
    advance: (ms) => {
      clock += ms;
    },
  };
}

/**
 * `reload` as the model calls it: through the catalog, with the window's own
 * workspace in the context the service layer fills in.
 */
async function reload(
  arbor: Arbor,
  window: string,
  mount: WorkspaceMount,
  request: { install?: readonly unknown[]; remove?: readonly string[] },
): Promise<ToolResult> {
  const args: Record<string, unknown> = {};
  if (request.install !== undefined) args.install = [...request.install];
  if (request.remove !== undefined) args.remove = [...request.remove];
  return arbor.catalog.call(
    { name: "reload", args, callId: "call_1" },
    callContext(window as `c${number}`, { workspace: mount }),
  );
}

const task = {
  kind: "batch" as const,
  reason: "查看 CI 结果",
  targets: ["gh:pr:57"],
  time: 1700000000000,
  content: [{ kind: "data" as const, fields: { content: "CI 红了" } }],
};

/** A skill draft in the window's own directory, the way a model writes one. */
async function draft(mount: WorkspaceMount, name: string, description: string): Promise<EnvDraft> {
  const write = mount.writeFile;
  assert.ok(write !== undefined);
  await write(`${name}/SKILL.md`, `# ${name}\n\n${description}\n\n1. 读这个文件。\n`);
  return { kind: "skill", name, path: `./${name}` };
}

describe("the environment in the host", () => {
  it("lists the environment in the system prompt, one line per item", async () => {
    const { arbor, backend } = await host();
    backend.script([{ text: "完成" }]);
    await arbor.open(task);
    await backend.finished();
    const prompt = backend.opened[0]?.prompt.system ?? "";
    assert.ok(prompt.includes("<env>"));
    // The built-in skills are listed like any other, with their path.
    assert.ok(prompt.includes("arbor-skill："));
    assert.ok(prompt.includes("/env/skills/arbor-skill"));
    // `reload` is named in one line, and the procedure is not in the prompt.
    const tools = backend.opened[0]?.tools ?? [];
    assert.ok(tools.some((tool) => tool.name === "reload"));
    const modules = (backend.opened[0]?.modules ?? []).map((module) => module.name);
    assert.ok(modules.includes("env"));
    assert.ok(modules.includes("services"));
  });

  it("installs a draft, records the revision and broadcasts the delta to every live window", async () => {
    const { arbor, journal, backend, advance } = await host();
    backend.script([{ text: "完成" }, { text: "另一个窗口" }]);
    const first = await arbor.open(task);
    await backend.finished();
    const second = await arbor.open({ ...task, reason: "另一个任务" });
    await backend.finished();

    const mount = await arbor.services.ensureWorkspace(first.window);
    assert.ok(mount !== undefined);
    const outcome = await reload(arbor, first.window, mount, { install: [await draft(mount, "deploy", "上线流程")] });
    assert.equal(outcome.ok, true);
    assert.ok(outcome.content.includes("环境已更新为 e1"));
    assert.ok(outcome.content.includes("变更已广播给 2 个窗口"));

    // The change is one event, and both live windows were told what arrived.
    const revisions = await journal.list({ kinds: ["environment_revision"] });
    assert.equal(revisions.items.length, 1);
    assert.equal(revisions.items[0]?.window, first.window);
    assert.ok((revisions.items[0]?.body ?? "").includes("e1"));
    const deliveries = await journal.list({ kinds: ["delivery"] });
    assert.equal(deliveries.items.length, 2);
    for (const event of deliveries.items) {
      assert.ok((event.body ?? "").includes("环境变更 e1"));
      assert.ok((event.body ?? "").includes("+ skill deploy"));
    }
    // The item is installed.
    const item = (await arbor.services.environment?.list())?.find((one) => one.name === "deploy");
    assert.equal(item?.path, "/env/skills/deploy");
    // A window opened inside the same epoch keeps the prefix it shares, and the
    // change reaches it as a delta in its first input.
    backend.script([{ text: "第三个窗口" }]);
    const third = await arbor.open({ ...task, reason: "第三个任务" });
    await backend.finished();
    const inside = backend.opened.find((one) => one.window === third.window);
    assert.ok(!(inside?.prompt.system ?? "").includes("deploy：上线流程"));
    assert.ok((inside?.firstInput ?? "").includes("环境变更 e1"));
    assert.ok((inside?.firstInput ?? "").includes("+ skill deploy"));
    // The next epoch folds it into the system prompt.
    advance(11 * 60 * 1000);
    backend.script([{ text: "第四个窗口" }]);
    const fourth = await arbor.open({ ...task, reason: "第四个任务" });
    await backend.finished();
    const opened = backend.opened.find((one) => one.window === fourth.window);
    assert.ok((opened?.prompt.system ?? "").includes("deploy：上线流程"));
    assert.ok(second.window.length > 0);
  });

  it("refuses a draft based on a revision another window moved on from", async () => {
    const { arbor, backend } = await host();
    backend.script([{ text: "完成" }, { text: "第二个窗口" }]);
    const first = await arbor.open(task);
    await backend.finished();
    const second = await arbor.open({ ...task, reason: "第二个任务" });
    await backend.finished();

    const mount = await arbor.services.ensureWorkspace(first.window);
    assert.ok(mount !== undefined);
    // The first window installs revision 1 and reads it, so its draft is based on 1.
    await reload(arbor, first.window, mount, { install: [await draft(mount, "deploy", "第一版")] });
    backend.script([{ tool: "read", args: { path: "/env/skills/deploy/SKILL.md" } }, { text: "读完了" }]);
    await arbor.deliver(
      first.window,
      {
        kind: "inserted_task",
        refs: ["t2"],
        time: 1700000000000,
        content: [{ kind: "data", fields: { content: "读一下技能" } }],
      },
      { targets: [...task.targets] },
    );
    await backend.finished();

    // Another window installs a newer revision while the first one edits.
    const other = await arbor.services.ensureWorkspace(second.window);
    assert.ok(other !== undefined);
    await reload(arbor, second.window, other, { install: [await draft(other, "deploy", "第二版")] });

    const result = await reload(arbor, first.window, mount, { install: [await draft(mount, "deploy", "基于第一版的修改")] });
    assert.equal(result.ok, false);
    assert.equal(result.error?.rule, "env.draft.stale");
    assert.match(result.error?.message ?? "", /第 2 版/);
    assert.match(result.error?.nextAction ?? "", /「修订冲突」一节/);
    // The refusal changed nothing: the item is still the newer revision.
    const item = (await arbor.services.environment?.list())?.find((one) => one.name === "deploy");
    assert.equal(item?.revision, 2);
    assert.equal(item?.description, "第二版");
  });

  it("reads the environment without a workspace, and refuses a write to it", async () => {
    const { arbor, backend, journal } = await host();
    backend.script([
      { tool: "read", args: { path: "/env/skills/arbor-mcp/SKILL.md" } },
      { tool: "write", args: { path: "/env/skills/arbor-mcp/SKILL.md", text: "改写" } },
      { text: "完成" },
    ]);
    const record = await arbor.open(task);
    await backend.finished();
    await arbor.end(record.window);
    await backend.finished();
    const results = await journal.list({ kinds: ["tool_result"] });
    assert.ok((results.items[0]?.body ?? "").includes("/env/skills/arbor-mcp/SKILL.md"));
    assert.ok((results.items[0]?.body ?? "").includes("接一个 MCP 服务器"));
    assert.ok((results.items[1]?.body ?? "").includes("env.readonly_path"));
  });

  it("removes an item, and refuses a call into a function the removal took away", async () => {
    const { arbor, backend } = await host();
    backend.script([{ text: "完成" }]);
    const record = await arbor.open(task);
    await backend.finished();
    const mount = await arbor.services.ensureWorkspace(record.window);
    assert.ok(mount !== undefined);
    const server = join(mount.path, "weather");
    await mkdir(server, { recursive: true });
    await writeFile(
      join(server, "weather.json"),
      `${JSON.stringify({ command: "definitely-not-a-command" })}\n`,
      "utf8",
    );
    // A server that never starts is refused, and nothing is installed.
    const failed = await reload(arbor, record.window, mount, { install: [{ kind: "mcp", name: "weather", path: "./weather" }] });
    assert.equal(failed.ok, false);
    assert.equal(failed.error?.rule, "env.draft.mcp");

    const removed = await reload(arbor, record.window, mount, { remove: ["skill:arbor-settings"] });
    assert.equal(removed.ok, false);
    assert.equal(removed.error?.rule, "env.readonly");
  });

  it("takes the settings from the environment, from the next epoch on", async () => {
    const { arbor, backend, advance } = await host();
    backend.script([{ text: "第一个窗口" }]);
    const first = await arbor.open(task);
    await backend.finished();
    assert.ok(!(backend.opened[0]?.prompt.system ?? "").includes("运维 agent"));

    const mount = await arbor.services.ensureWorkspace(first.window);
    assert.ok(mount !== undefined);
    const write = mount.writeFile;
    assert.ok(write !== undefined);
    await write("settings.json", `${JSON.stringify({ identity: "运维 agent", generalRules: ["先灰度，再全量"] })}\n`);
    const outcome = await reload(arbor, first.window, mount, {
      install: [{ kind: "settings", name: "settings", path: "./settings.json" }],
    });
    assert.equal(outcome.ok, true);
    // The settings item is installed, so the next epoch's prompt carries it.
    const settings = await arbor.services.environment?.settings();
    assert.equal(settings?.identity, "运维 agent");

    // The identity is part of the system prompt, so it applies from the next
    // epoch, not as a delta.
    advance(11 * 60 * 1000);
    backend.script([{ text: "第二个窗口" }]);
    const second = await arbor.open({ ...task, reason: "第二个任务" });
    await backend.finished();
    const opened = backend.opened.find((one) => one.window === second.window);
    assert.ok((opened?.prompt.system ?? "").includes("<identity>"));
    assert.ok((opened?.prompt.system ?? "").includes("运维 agent"));
    assert.ok((opened?.prompt.system ?? "").includes("先灰度，再全量"));
  });

  it("records a service's state change with the service as its target", async () => {
    const seen: string[] = [];
    const { arbor, journal, backend, supervisor } = await host({
      plugins: [
        {
          name: "watch",
          hooks: {
            serviceStateChange: (context) => {
              seen.push(`${context.service}:${context.status.state}`);
            },
          },
        },
      ],
    });
    backend.script([{ text: "完成" }]);
    await arbor.open(task);
    await backend.finished();
    await supervisor.report("crawler", "failed");
    const events = await journal.list({ kinds: ["service_state"] });
    assert.equal(events.items.length, 1);
    assert.ok(events.items[0]?.targets.includes("svc:crawler"));
    assert.ok((events.items[0]?.body ?? "").includes("failed"));
    // The hook saw the same change, with the event that recorded it.
    assert.deepEqual(seen, ["crawler:failed"]);
  });

  it("starts every installed service again after a host restart", async () => {
    const { arbor, backend, supervisor } = await host();
    backend.script([{ text: "完成" }]);
    const record = await arbor.open(task);
    await backend.finished();
    const mount = await arbor.services.ensureWorkspace(record.window);
    assert.ok(mount !== undefined);
    const write = mount.writeFile;
    assert.ok(write !== undefined);
    await mkdir(join(mount.path, "crawler"), { recursive: true });
    await write("crawler/svc.json", `${JSON.stringify({ command: "node", args: ["bot.js"], ports: [8080] })}\n`);
    const installed = await reload(arbor, record.window, mount, {
      install: [{ kind: "service", name: "crawler", path: "./crawler" }],
    });
    assert.equal(installed.ok, true);
    assert.equal(supervisor.started.length, 1);
    assert.deepEqual(supervisor.started[0]?.ports, [8080]);

    await arbor.start();
    // A restart starts the services the environment holds, from the directories
    // they own.
    assert.equal(supervisor.started.length, 2);
    assert.ok((supervisor.started[1]?.dir ?? "").endsWith("services/crawler"));
  });

  it("calls an installed MCP server's function from a script", async () => {
    const { arbor, journal, backend } = await host();
    backend.script([{ text: "完成" }]);
    const record = await arbor.open(task);
    await backend.finished();
    const mount = await arbor.services.ensureWorkspace(record.window);
    assert.ok(mount !== undefined);
    const server = join(mount.path, "weather");
    await mkdir(server, { recursive: true });
    await writeFile(join(server, "server.js"), MCP_SERVER, "utf8");
    await writeFile(
      join(server, "weather.json"),
      `${JSON.stringify({ command: process.execPath, args: ["server.js"] })}\n`,
      "utf8",
    );
    const installed = await reload(arbor, record.window, mount, { install: ["./weather"] });
    assert.equal(installed.ok, true, "the server starts and lists its functions");
    // The server's functions are declared as a module, so a script calls one.
    const modules = arbor.catalog.modules().map((module) => module.name);
    assert.ok(modules.includes("weather"));
    backend.script([
      { tool: "code_exec", args: { script: "return await weather.forecast({ city: '上海' })" } },
      { text: "完成" },
    ]);
    await arbor.deliver(
      record.window,
      {
        kind: "inserted_task",
        refs: ["t2"],
        time: 1700000000000,
        content: [{ kind: "data", fields: { content: "查一下天气" } }],
      },
      { targets: [...task.targets] },
    );
    await settle();
    const results = await journal.list({ kinds: ["tool_result"] });
    assert.ok((results.items.at(-1)?.body ?? "").includes("上海 晴"));
  });

  it("installs a plugin's skills into /env, where the model can change them", async () => {
    const base = await mkdtemp(join(tmpdir(), "arbor-plugin-item-"));
    const skill = join(base, "chatbot-skill");
    await mkdir(skill, { recursive: true });
    await writeFile(join(skill, "SKILL.md"), "# chatbot\n\n在一个来源里回复用户。\n\n1. 读这一行。\n", "utf8");
    const { arbor, backend, journal } = await host({
      plugins: [{ name: "chatbot", skills: [{ kind: "skill", name: "chatbot-skill", path: skill }] }],
    });
    backend.script([{ text: "完成" }]);
    await arbor.open(task);
    await backend.finished();
    const item = (await arbor.services.environment?.list())?.find((one) => one.name === "chatbot-skill");
    assert.equal(item?.description, "在一个来源里回复用户。");
    assert.equal(item?.path, "/env/skills/chatbot-skill");
    // Installing a plugin's item is an environment change like any other.
    const revisions = await journal.list({ kinds: ["environment_revision"] });
    assert.equal(revisions.items.length, 1);
    assert.ok((revisions.items[0]?.body ?? "").includes("chatbot"));
  });
});
