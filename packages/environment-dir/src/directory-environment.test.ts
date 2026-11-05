/**
 * The default `Environment`: one shared `/env` directory, a revision per item,
 * validation before anything is replaced, and deltas for live windows
 * (docs/environment.md).
 *
 * A draft is staged and checked before anything moves, so every test below can
 * assert both sides of a refusal: what the call answered, and that the item the
 * environment had is still exactly the one it had.
 */

import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { DirectoryEnvironment } from "./directory-environment.ts";

/** One host directory, and the workspace a window drafts in. */
async function roots(): Promise<{ root: string; work: string }> {
  const base = await mkdtemp(join(tmpdir(), "arbor-env-"));
  return { root: join(base, "env-root"), work: join(base, "ws1") };
}

/** A skill draft, the way a window writes one in its own workspace. */
async function skillDraft(work: string, name: string, description: string): Promise<string> {
  const path = join(work, name);
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "SKILL.md"), `# ${name}\n\n${description}\n\n1. 读这个文件。\n`, "utf8");
  return path;
}

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

async function environment(options: { supervisor?: unknown } = {}): Promise<{
  env: DirectoryEnvironment;
  root: string;
  work: string;
}> {
  const { root, work } = await roots();
  await mkdir(work, { recursive: true });
  const env = new DirectoryEnvironment({
    root,
    mount: "/env",
    ...(options.supervisor === undefined ? {} : { supervisor: options.supervisor as never }),
  });
  return { env, root, work };
}

describe("the environment", () => {
  it("seeds the built-in skills, read-only, and lists them with their paths", async () => {
    const { env } = await environment();
    const items = await env.list();
    const builtin = items.filter((item) => item.builtin === true);
    assert.equal(builtin.length, 4);
    for (const item of builtin) {
      assert.equal(item.kind, "skill");
      assert.equal(item.path, `/env/skills/${item.name}`);
      assert.ok(item.description !== "", `${item.name} carries one line`);
    }
    // The built-in skills are read-only: a removal names the rule and the item.
    await assert.rejects(() => env.remove(["skill:arbor-skill"]), (error: { rule?: string }) => {
      assert.equal(error.rule, "env.readonly");
      return true;
    });
  });

  it("installs a draft, records a revision, and names the change in the delta", async () => {
    const { env, work } = await environment();
    const before = await env.revision();
    const revision = await env.install([{ kind: "skill", name: "deploy", path: await skillDraft(work, "deploy", "上线流程") }]);
    assert.equal(revision.ref, "e1");
    assert.equal(revision.changes[0]?.change, "added");
    assert.equal(revision.changes[0]?.item.name, "deploy");
    assert.equal(await env.revision(), "e1");

    const items = await env.list();
    const deploy = items.find((item) => item.name === "deploy");
    assert.equal(deploy?.path, "/env/skills/deploy");
    assert.equal(deploy?.description, "上线流程");

    // A live window opened before the change is told what arrived.
    const delta = await env.delta(before);
    assert.equal(delta.revision, "e1");
    assert.deepEqual(
      delta.items.map((item) => `${item.change} ${item.item.name}`),
      ["added deploy"],
    );
    // Nothing changed since, so the next delta is empty.
    assert.deepEqual((await env.delta("e1")).items, []);
  });

  it("refuses a draft copied from an older revision, and changes nothing", async () => {
    const { env, work } = await environment();
    await env.install([{ kind: "skill", name: "deploy", path: await skillDraft(work, "deploy", "第一版") }]);
    // Another window installs a newer revision of the same item.
    await env.install([{ kind: "skill", name: "deploy", path: await skillDraft(work, "deploy", "第二版") }]);
    const draft = await skillDraft(work, "deploy", "基于第一版的修改");
    await assert.rejects(
      () => env.install([{ kind: "skill", name: "deploy", path: draft, copiedFrom: 1 }]),
      (error: { rule?: string; message?: string }) => {
        assert.equal(error.rule, "env.draft.stale");
        assert.match(error.message ?? "", /第 2 版/);
        return true;
      },
    );
    const item = (await env.list()).find((one) => one.name === "deploy");
    assert.equal(item?.description, "第二版");
    assert.equal(item?.revision, 2);
    // A refusal lands no revision, so a window that asked sees no delta.
    assert.deepEqual((await env.delta("e2")).items, []);
  });

  it("removes an item and says so in the delta", async () => {
    const { env, work } = await environment();
    await env.install([{ kind: "skill", name: "deploy", path: await skillDraft(work, "deploy", "上线流程") }]);
    const revision = await env.remove(["skill:deploy"]);
    assert.equal(revision.changes[0]?.change, "removed");
    const delta = await env.delta("e1");
    assert.deepEqual(
      delta.items.map((item) => `${item.change} ${item.item.name}`),
      ["removed deploy"],
    );
    assert.equal((await env.list()).some((item) => item.name === "deploy"), false);
    await assert.rejects(() => env.remove(["skill:deploy"]), (error: { rule?: string }) => {
      assert.equal(error.rule, "env.notfound");
      return true;
    });
  });

  it("keeps one revision per item, so a change to one never conflicts with another", async () => {
    const { env, work } = await environment();
    await env.install([{ kind: "skill", name: "deploy", path: await skillDraft(work, "deploy", "上线流程") }]);
    await env.install([{ kind: "skill", name: "review", path: await skillDraft(work, "review", "复核流程") }]);
    await env.install([{ kind: "skill", name: "deploy", path: await skillDraft(work, "deploy", "上线流程二版") }]);
    const history = await env.history("sk:deploy");
    assert.equal(history.length, 2);
    assert.equal(history[0]?.changes[0]?.item.revision, 1);
    assert.equal(history[1]?.changes[0]?.item.revision, 2);
    // The environment's own history holds every revision, in order.
    assert.equal((await env.history()).length, 3);
  });

  it("refuses a draft that is not a skill, naming the section that covers it", async () => {
    const { env, work } = await environment();
    const path = join(work, "broken");
    await mkdir(path, { recursive: true });
    await writeFile(join(path, "README.md"), "没有 SKILL.md\n", "utf8");
    await assert.rejects(() => env.install([{ kind: "skill", name: "broken", path }]), (error: { rule?: string; nextAction?: string }) => {
      assert.equal(error.rule, "env.draft.skill");
      assert.match(error.nextAction ?? "", /arbor-skill\/SKILL.md 的「结构」一节/);
      return true;
    });
    const outcome = await env.validate([{ kind: "skill", name: "broken", path }]);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.items[0]?.ok, false);
    assert.equal(outcome.items[0]?.name, "broken");
  });

  it("installs the settings as an item and reads them back", async () => {
    const { env, work } = await environment();
    assert.equal(await env.settings(), undefined);
    const before = await env.revision();
    const path = join(work, "settings.json");
    await writeFile(path, `${JSON.stringify({ identity: "运维 agent", generalRules: ["先灰度"] }, null, 2)}\n`, "utf8");
    const revision = await env.install([{ kind: "settings", name: "settings", path }]);
    assert.equal(revision.changes[0]?.change, "added");
    const settings = await env.settings();
    assert.equal(settings?.identity, "运维 agent");
    assert.deepEqual(settings?.generalRules, ["先灰度"]);
    // The settings item is listed like any other, and its delta names it.
    assert.equal((await env.list()).some((item) => item.kind === "settings"), true);
    assert.deepEqual(
      (await env.delta(before)).items.map((item) => `${item.change} ${item.item.kind}`),
      ["added settings"],
    );
  });

  it("refuses settings that are not a JSON object", async () => {
    const { env, work } = await environment();
    const path = join(work, "settings.json");
    await writeFile(path, "[1, 2, 3]\n", "utf8");
    await assert.rejects(() => env.install([{ kind: "settings", name: "settings", path }]), (error: { rule?: string }) => {
      assert.equal(error.rule, "env.draft.settings");
      return true;
    });
    assert.equal(await env.settings(), undefined);
  });

  it("validates an MCP server by starting it, and calls one of its functions", async () => {
    const { env, work } = await environment();
    const path = join(work, "weather");
    await mkdir(path, { recursive: true });
    await writeFile(join(path, "server.js"), MCP_SERVER, "utf8");
    await writeFile(
      join(path, "weather.json"),
      `${JSON.stringify({ command: process.execPath, args: ["server.js"], description: "天气查询" }, null, 2)}\n`,
      "utf8",
    );
    const revision = await env.install([{ kind: "mcp", name: "weather", path }]);
    assert.equal(revision.changes[0]?.change, "added");
    const item = (await env.list()).find((one) => one.name === "weather");
    assert.equal(item?.path, "/env/mcp/weather/weather.json");
    // The server was started and its functions listed, so a window's catalog
    // declares them without asking the model.
    assert.deepEqual(
      (item?.functions ?? []).map((fn) => fn.signature),
      ["weather.forecast(city)"],
    );
    assert.equal(await env.call("weather", "weather.forecast", { city: "上海" }), "上海 晴");
  });

  it("refuses an MCP server that never starts, and changes nothing", async () => {
    const { env, work } = await environment();
    const path = join(work, "broken");
    await mkdir(path, { recursive: true });
    await writeFile(join(path, "broken.json"), `${JSON.stringify({ command: "definitely-not-a-command" }, null, 2)}\n`, "utf8");
    await assert.rejects(() => env.install([{ kind: "mcp", name: "broken", path }]), (error: { rule?: string; nextAction?: string }) => {
      assert.equal(error.rule, "env.draft.mcp");
      assert.match(error.nextAction ?? "", /arbor-mcp\/SKILL.md 的「自测」一节/);
      return true;
    });
    assert.equal((await env.list()).some((item) => item.name === "broken"), false);
  });

  it("refuses a service when no supervisor is configured", async () => {
    const { env, work } = await environment();
    const path = join(work, "crawler");
    await mkdir(path, { recursive: true });
    await writeFile(join(path, "svc.json"), `${JSON.stringify({ command: "node" }, null, 2)}\n`, "utf8");
    await assert.rejects(() => env.install([{ kind: "service", name: "crawler", path }]), (error: { rule?: string }) => {
      assert.equal(error.rule, "env.supervisor.absent");
      return true;
    });
  });
});
