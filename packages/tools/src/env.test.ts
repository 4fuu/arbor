/**
 * The environment tools and modules: `reload`, `env`, `services`, and the
 * modules an MCP server arrives as (docs/tools.md, docs/environment.md).
 *
 * A capability is never a direct tool, so everything here goes through the same
 * service layer a direct call does, and `tool_search` answers a skill by its path
 * and a server by its functions.
 */

import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { SqliteJournal } from "@arbor/journal-sqlite";
import { DirectoryWorkspace } from "@arbor/workspace-dir";
import type {
  CallContext,
  Environment,
  EnvDraft,
  EnvItem,
  Journal,
  LogPage,
  ServiceStatus,
  Supervisor,
  ToolResult,
  WindowRef,
  WorkspaceMount,
} from "@arbor/interfaces";
import { zhTextTable } from "@arbor/prompt";
import { ToolCatalog } from "./catalog.ts";
import type { EnvCatalog, ReloadOutcome, ToolServices } from "./host.ts";

interface Harness {
  catalog: ToolCatalog;
  journal: Journal;
  workspace: DirectoryWorkspace;
  /** The window's mounted workspace, so a draft can be written into it. */
  mount(window: WindowRef): Promise<WorkspaceMount>;
  /** Every `reload` the service layer was asked for. */
  reloads: { drafts: readonly EnvDraft[]; remove: readonly string[] }[];
  /** What `reload` answers with. */
  answer: ReloadOutcome;
  /** The items the catalog reads. */
  items: EnvItem[];
  at: CallContext;
}

/** A supervisor that answers from a table, so no service is really started. */
const supervisor: Supervisor = {
  async start() {
    return { name: "crawler", revision: 1, state: "running" };
  },
  async status(name: string): Promise<ServiceStatus> {
    if (name !== "crawler") {
      throw Object.assign(new Error(`没有服务 ${name}`), { rule: "service.notfound" });
    }
    return {
      name,
      revision: 1,
      state: "running",
      restarts: 0,
      since: 1700000000000,
      ports: [8080],
      refs: ["r3"],
    };
  },
  async stop() {},
  async restart() {
    return { name: "crawler", revision: 1, state: "running" };
  },
  async logs(name: string): Promise<LogPage> {
    return { name, items: ["listening on 8080"], total: 1, limit: 20, nextCall: "services.logs(name)" };
  },
};

async function harness(): Promise<Harness> {
  const journal = new SqliteJournal({ path: ":memory:" });
  const root = await mkdtemp(join(tmpdir(), "arbor-env-tools-"));
  const workspace = new DirectoryWorkspace({ root });
  const reloads: Harness["reloads"] = [];
  const answer: ReloadOutcome = {
    revision: "e2",
    changes: [
      { change: "added", item: { ref: "sk:deploy@1", kind: "skill", name: "deploy", description: "上线流程", revision: 1, time: 1 } },
    ],
    delivered: 1,
  };
  const items: EnvItem[] = [
    { ref: "sk:arbor-skill@1", kind: "skill", name: "arbor-skill", description: "写一个技能", path: "/env/skills/arbor-skill", revision: 1, time: 1, builtin: true },
    { ref: "sk:deploy@1", kind: "skill", name: "deploy", description: "上线流程", path: "/env/skills/deploy", revision: 1, time: 1 },
    { ref: "mcp:weather@1", kind: "mcp", name: "weather", description: "天气查询", revision: 1, time: 1 },
    { ref: "svc:crawler@1", kind: "service", name: "crawler", description: "一个常驻服务：node", revision: 1, time: 1 },
  ];
  const catalog: EnvCatalog = {
    items,
    modules: [
      {
        name: "weather",
        description: "天气查询",
        functions: [{ name: "weather.forecast", signature: "weather.forecast(city)", description: "查一个城市的天气" }],
      },
    ],
    removed: [],
  };
  const mounts = new Map<string, WorkspaceMount>();
  const environment: Environment = {
    mount: "/env",
    directory: "/env",
    async revision() {
      return "e2" as const;
    },
    async list() {
      return items;
    },
    async history() {
      return [
        {
          ref: "e1" as const,
          previous: null,
          time: 1,
          window: null,
          changes: [{ change: "added" as const, item: items[1] as EnvItem }],
        },
      ];
    },
    async settings() {
      return undefined;
    },
    async validate() {
      return { ok: true, items: [] };
    },
    async install() {
      return {
        ref: "e2" as const,
        previous: "e1" as const,
        time: 2,
        window: null,
        changes: [{ change: "added" as const, item: items[1] as EnvItem }],
      };
    },
    async remove() {
      return {
        ref: "e2" as const,
        previous: "e1" as const,
        time: 2,
        window: null,
        changes: [{ change: "removed" as const, item: items[1] as EnvItem }],
      };
    },
    async delta() {
      return { revision: "e2" as const, previous: "e1" as const, items: [] };
    },
    async resume() {},
    async call() {
      return "已调用";
    },
  };
  const services: ToolServices = {
    table: zhTextTable,
    journal,
    workspace,
    supervisor,
    environment,
    ensureWorkspace: async (window) => {
      const found = mounts.get(window);
      if (found !== undefined) return found;
      const ref = await workspace.create(window);
      const mount = await workspace.mount(ref);
      mounts.set(window, mount);
      return mount;
    },
    endWindow: async () => ({ callId: "", ok: true, content: "已结束" }),
    hasOpenWork: async () => false,
    writeNote: async () => ({}) as never,
    search: async () => ({ query: "", scope: [], hits: [], notes: [], windows: [], total: 0, nextCall: "" }),
    send: async () => ({ event: "r1", behind: 0 }),
    board: async () => ({ items: [], total: 0, limit: 20, nextCall: "board.list()" }),
    setBoardLine: async () => {},
    expect: async () => ({ kind: "described", ref: "m1" }),
    unexpect: async () => {},
    windows: async () => [],
    windowTranscript: async () => [],
    windowMessage: async () => "r1" as never,
    broadcast: async () => 0,
    inbox: async () => [],
    tasks: async () => [],
    task: async () => [],
    schedules: async () => [],
    schedule: async () => "t1" as never,
    updateSchedule: async () => null,
    cancelSchedule: async () => {},
    envPaths: () => ({ prefix: "/env", directory: "/env" }),
    envCatalog: () => catalog,
    envItemAt: async (path) => items.find((item) => item.path === path),
    envRead: () => {},
    reload: async (_window, request) => {
      reloads.push({ drafts: request.drafts, remove: request.remove });
      return answer;
    },
    callMcp: async (server, fn) => `${server}.${fn} 已调用`,
  };
  const toolCatalog = new ToolCatalog({ services });
  return {
    catalog: toolCatalog,
    journal,
    workspace,
    mount: async (window) => mounts.get(window) ?? ((await services.ensureWorkspace(window)) as WorkspaceMount),
    reloads,
    answer,
    items,
    at: { window: "c1" as const },
  };
}

function call(catalog: ToolCatalog, name: string, args: Record<string, unknown>, at: CallContext): Promise<ToolResult> {
  return catalog.call({ name, args, callId: "call_1" }, at);
}

/** Write one file of a draft, through the mount's own capability. */
async function draft(mount: WorkspaceMount, path: string, text: string): Promise<void> {
  const write = mount.writeFile;
  assert.ok(write !== undefined, "the workspace mount owns a write");
  await write(path, text);
}

/** The service layer a catalog was built with, so a test can restate one part. */
function servicesOf(catalog: ToolCatalog): ToolServices {
  return (catalog as unknown as { services: ToolServices }).services;
}

describe("the environment tools", () => {
  it("declares `reload` only when an environment is configured", async () => {
    const { catalog } = await harness();
    const reload = catalog.tools().find((tool) => tool.name === "reload");
    assert.ok(reload !== undefined);
    assert.ok(reload.description.includes("环境"));
    assert.ok(reload.parameters.install !== undefined);
    assert.ok(reload.parameters.remove !== undefined);
    // `reload` is a decision, so a script may not call it.
    assert.ok(catalog.directTools().includes("reload"));
    assert.equal(catalog.decisionIn("reload({})"), "reload");
  });

  it("installs a draft from the window's workspace and answers with the revision", async () => {
    const { catalog, reloads, at, mount } = await harness();
    const workspace = await mount("c1");
    await draft(workspace, "deploy/SKILL.md", "# deploy\n\n上线流程\n\n1. 读这个文件。\n");
    const result = await call(catalog, "reload", { install: ["./deploy"] }, { ...at, workspace });
    assert.equal(result.ok, true);
    assert.ok(result.content.includes("环境已更新为 e2"));
    assert.ok(result.content.includes("+ skill deploy：上线流程"));
    assert.ok(result.content.includes("变更已广播给 1 个窗口"));
    assert.equal(reloads.length, 1);
    assert.equal(reloads[0]?.drafts[0]?.kind, "skill");
    assert.equal(reloads[0]?.drafts[0]?.name, "deploy");
    // The path is the window's own; the service layer resolves it against the
    // workspace before the environment sees it.
    assert.equal(reloads[0]?.drafts[0]?.path, "./deploy");
  });

  it("takes a `.json` draft as an MCP server and `settings.json` as the settings", async () => {
    const { catalog, reloads, at, mount } = await harness();
    const workspace = await mount("c1");
    await draft(workspace, "weather.json", '{"command":"node","args":["server.js"]}\n');
    await draft(workspace, "settings.json", '{"identity":"运维 agent"}\n');
    const result = await call(catalog, "reload", { install: ["./weather.json", "./settings.json"] }, { ...at, workspace });
    assert.equal(result.ok, true);
    assert.deepEqual(
      reloads[0]?.drafts.map((draft) => `${draft.kind}:${draft.name}`),
      ["mcp:weather", "settings:settings"],
    );
  });

  it("refuses an install with no draft, and one with no workspace", async () => {
    const { catalog, at, mount } = await harness();
    const empty = await call(catalog, "reload", {}, at);
    assert.equal(empty.ok, false);
    assert.equal(empty.error?.rule, "env.empty");
    assert.ok((empty.error?.nextAction ?? "").includes("install"));

    const workspace = await mount("c1");
    const nothing = await call(catalog, "reload", { install: ["./nowhere"] }, { ...at, workspace });
    assert.equal(nothing.ok, false);
    assert.equal(nothing.error?.rule, "env.draft");
    assert.ok((nothing.error?.message ?? "").includes("nowhere"));

    const noWorkspace = await call(catalog, "reload", { install: ["./deploy"] }, at);
    assert.equal(noWorkspace.ok, false);
    assert.equal(noWorkspace.error?.rule, "env.workspace");
  });

  it("answers a refusal the service layer returned, with its next action", async () => {
    const { catalog, at, mount } = await harness();
    const workspace = await mount("c1");
    await draft(workspace, "deploy/SKILL.md", "# deploy\n\n上线流程\n");
    // The environment refuses: another window installed a newer revision.
    const failing = new ToolCatalog({
      services: {
        ...servicesOf(catalog),
        reload: async () => {
          throw Object.assign(new Error("环境：sk:deploy@1 已被其他窗口更新到第 2 版，草稿基于旧的 1 版"), {
            rule: "env.draft.stale",
            nextAction: "读 /env/skills/arbor-skill/SKILL.md 的「修订冲突」一节，合并后重新调用 reload。",
          });
        },
      },
    });
    const result = await call(failing, "reload", { install: ["./deploy"] }, { ...at, workspace });
    assert.equal(result.ok, false);
    assert.equal(result.error?.rule, "env.draft.stale");
    assert.match(result.error?.message ?? "", /第 2 版/);
    assert.match(result.error?.nextAction ?? "", /「修订冲突」一节/);
  });

  it("lists the environment's items and their revisions", async () => {
    const { catalog, at } = await harness();
    const list = await call(catalog, "env.list", {}, at);
    assert.equal(list.ok, true);
    assert.ok(list.content.includes("sk:deploy@1 deploy：上线流程"));
    assert.ok(list.content.includes("svc:crawler@1"));
    const history = await call(catalog, "env.history", { item: "sk:deploy" }, at);
    assert.equal(history.ok, true);
  });

  it("reads a service's list, status and logs through the supervisor", async () => {
    const { catalog, at } = await harness();
    const list = await call(catalog, "services.list", {}, at);
    assert.ok(list.content.includes("crawler running 第 1 版"));
    const status = await call(catalog, "services.status", { name: "crawler" }, at);
    assert.ok(status.content.includes("端口 8080"));
    assert.ok(status.content.includes("重启 0 次"));
    const logs = await call(catalog, "services.logs", { name: "crawler" }, at);
    assert.ok(logs.content.includes("listening on 8080"));
    const missing = await call(catalog, "services.status", { name: "nothing" }, at);
    assert.equal(missing.ok, false);
    assert.equal(missing.error?.rule, "service.notfound");
  });

  it("answers a skill's name with its path and a server's name with its functions", async () => {
    const { catalog, at } = await harness();
    const skill = await call(catalog, "tool_search", { keywords: "deploy" }, at);
    assert.ok(skill.content.includes("/env/skills/deploy"));
    assert.ok(skill.content.includes("上线流程"));
    // The built-in skills answer the same way, which is how the loop closes.
    const builtin = await call(catalog, "tool_search", { keywords: "arbor-skill" }, at);
    assert.ok(builtin.content.includes("/env/skills/arbor-skill"));
    const server = await call(catalog, "tool_search", { keywords: "weather" }, at);
    assert.ok(server.content.includes("weather.forecast(city)"));
    assert.ok(server.content.includes("查一个城市的天气"));
  });

  it("calls an MCP server's function from a script, like any module", async () => {
    const { catalog, at, mount } = await harness();
    const workspace = await mount("c1");
    const result = await call(catalog, "code_exec", { script: "return await weather.forecast({ city: '上海' })" }, { ...at, workspace });
    assert.equal(result.ok, true);
    assert.ok(result.content.includes("weather.forecast 已调用"));
    // The module is declared, so a window's prompt names it and never a function.
    const modules = catalog.modules().map((module) => module.name);
    assert.ok(modules.includes("env"));
    assert.ok(modules.includes("services"));
    assert.ok(modules.includes("weather"));
  });

  it("refuses a function a delta removed, with the ref of the change that removed it", async () => {
    const { catalog, at, mount } = await harness();
    const workspace = await mount("c1");
    const removed = new ToolCatalog({
      services: {
        ...servicesOf(catalog),
        envCatalog: () => ({
          items: [],
          modules: [],
          removed: [{ name: "weather.forecast", ref: "e5" as const }],
        }),
      },
    });
    const result = await call(removed, "weather.forecast", { city: "上海" }, { ...at, workspace });
    assert.equal(result.ok, false);
    assert.equal(result.error?.rule, "env.removed");
    assert.ok((result.error?.message ?? "").includes("e5"));
  });

  it("reads the environment without a workspace, and refuses a write to it", async () => {
    const { catalog, at, workspace } = await harness();
    await mkdir(join(workspace.pathOf("ws1" as never), ".."), { recursive: true }).catch(() => {});
    const root = await mkdtemp(join(tmpdir(), "arbor-env-read-"));
    await mkdir(join(root, "skills", "deploy"), { recursive: true });
    await writeFile(join(root, "skills", "deploy", "SKILL.md"), "# deploy\n\n上线流程\n\n1. 读这个文件。\n", "utf8");
    const reading = new ToolCatalog({
      services: {
        ...servicesOf(catalog),
        envPaths: () => ({ prefix: "/env", directory: root }),
      },
    });
    const read = await call(reading, "read", { path: "/env/skills/deploy/SKILL.md" }, at);
    assert.equal(read.ok, true);
    assert.ok(read.content.includes("上线流程"));
    const write = await call(reading, "write", { path: "/env/skills/deploy/SKILL.md", text: "x" }, at);
    assert.equal(write.ok, false);
    assert.equal(write.error?.rule, "env.readonly_path");
  });
});
