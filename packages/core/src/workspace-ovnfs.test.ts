import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import { OvnfsWorkspace } from "@4fu/arbor-workspace-ovnfs";
import { SqliteJournal } from "@4fu/arbor-journal-sqlite";
import type { Judge, JudgeAnswer, JudgeRequest } from "@4fu/arbor-interfaces";
import { Arbor } from "./host.ts";
import { ManualTimers, ScriptedBackend } from "./testing.ts";

/**
 * The ovnfs workspace through the whole host (docs/workspaces.md), driven by the
 * scripted backend and a fake `ovnfs` on PATH that answers the JSON shapes. It
 * proves the seams the unit tests do not: a checkout opened through `code_exec`
 * reaches the workspace, an unapplied checkout blocks `end` and names itself,
 * and a continuation's first input lists the chain's checkouts.
 */

/** The fake `ovnfs` the workspace runs, written where the CLI can exec it. */
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

async function fakeOvnfs(): Promise<{ bin: string; root: string }> {
  const root = await tempDir("arbor-ovnfs-e2e-");
  const pkg = import.meta.resolve("@4fu/arbor-workspace-ovnfs");
  const fixture = fileURLToPath(new URL("../fixtures/fake-ovnfs.mjs", pkg));
  const bin = join(root, "ovnfs");
  await writeFile(bin, await readFile(fixture, "utf8"), "utf8");
  await chmod(bin, 0o755);
  return { bin, root };
}

function quietJudge(): Judge {
  return {
    name: "quiet",
    async decide(request: JudgeRequest): Promise<JudgeAnswer> {
      if (request.decision === "model_tier") return { decision: "model_tier", tier: "" };
      return { decision: "active_set", keep: [], drop: [] };
    },
  };
}

async function host(): Promise<{ arbor: Arbor; journal: SqliteJournal; backend: ScriptedBackend; workspace: OvnfsWorkspace }> {
  const journal = new SqliteJournal({ path: ":memory:" });
  const { bin, root } = await fakeOvnfs();
  const source = join(root, "shared");
  await mkdir(source, { recursive: true });
  const workspace = new OvnfsWorkspace({ source, state: join(root, "state"), mount: join(root, "checkouts"), bin, journal });
  const backend = new ScriptedBackend();
  const arbor = new Arbor({ journal, backend, timers: new ManualTimers(), now: () => 1_700_000_000_000, workspace, judge: quietJudge() });
  backend.attach(arbor.windowControl());
  return { arbor, journal, backend, workspace };
}

const task = {
  kind: "batch" as const,
  reason: "改一个项目",
  targets: ["gh:pr:57"],
  time: 1_700_000_000_000,
  content: [{ kind: "data" as const, fields: { content: "把构建修好" } }],
};

const handoff = { topics: ["构建"], progress: ["开了检出"], pending: ["合回"], agreements: ["先本地验证"], refs: [] };

/** Wait for the backend to have opened `count` windows, past the first run's end. */
async function opened(backend: ScriptedBackend, count: number): Promise<void> {
  // A continuation's first input lists the chain's checkouts, which asks the
  // ovnfs binary - a real subprocess - so this waits in real time, not yields.
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (backend.opened.length >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`only ${backend.opened.length} windows opened`);
}

/**
 * Wait for something the host records while the window's own run is still
 * draining: a reminder is appended after the usage report that crosses a tier,
 * which the host's watcher handles behind the run that produced it.
 */
async function recorded(seen: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await seen()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("the host never recorded it");
}

describe("the ovnfs workspace through the host", () => {
  it("opens a checkout through code_exec, blocks end until it is handed off, and lists it to the continuation", async () => {
    const { arbor, journal, backend } = await host();
    backend.script([
      // The model opens its own checkout through the module function.
      { tool: "code_exec", args: { script: "return await workspace.checkout({ name: 'c1-app', dir: 'proj' })" } },
      // It tries to end without a handoff: the unapplied checkout blocks it and names itself.
      { tool: "end", args: {} },
      // It ends with a handoff, so the host opens a continuation.
      { tool: "end", args: { handoff } },
    ]);

    await arbor.open(task);
    await backend.finished();
    await opened(backend, 2);

    // The checkout was recorded in the journal, linked to the window.
    const checkoutEvents = await journal.list({ kinds: ["workspace_checkout"] });
    assert.equal(checkoutEvents.items.length, 1);
    assert.equal(checkoutEvents.items[0]?.window, "c1");

    // The end refusal named the unapplied checkout and asked for a handoff.
    const results = await journal.list({ kinds: ["tool_result"] });
    const refusal = results.items.map((event) => event.body ?? "").find((body) => body.includes("未合回"));
    assert.ok(refusal !== undefined, "the end refusal named the unapplied checkout");
    assert.match(refusal, /c1-app/);

    // A continuation opened, its system prompt carried the ovnfs method, and its
    // first input listed the chain's open checkout by name.
    assert.equal(backend.opened.length, 2);
    const continuation = backend.opened[1];
    if (continuation === undefined) throw new Error("a continuation window opened");
    assert.equal(continuation.window, "c2");
    assert.ok((continuation.prompt.system ?? "").includes("共享文件夹"), "the ovnfs method reached the system prompt");
    assert.ok((continuation.firstInput ?? "").includes("c1-app"), "the continuation's first input listed the checkout");
  });

  it("names an unapplied checkout in the reminder and on the board", async () => {
    const { arbor, journal, backend } = await host();
    backend.script([
      { tool: "code_exec", args: { script: "return await workspace.checkout({ name: 'c1-app', dir: 'proj' })" } },
      // One step crosses the first reminder tier, which names what is open.
      { usage: { used: 30000, limit: 200000, reserve: 4000 } },
      { text: "完成" },
    ]);

    await arbor.open(task);
    await backend.finished();
    await recorded(async () => (await journal.list({ kinds: ["reminder"] })).items.length > 0);

    const reminders = await journal.list({ kinds: ["reminder"] });
    const reminder = reminders.items.map((event) => event.body ?? "").find((body) => body.includes("未完成的工作"));
    assert.ok(reminder !== undefined, "the reminder named the open work");
    assert.match(reminder, /c1-app（未合回）/);
    assert.match(reminder, /还没有进展笔记的话/, "the tier's own instruction is still there");

    // The board shows the same open work on the window's own line.
    assert.deepEqual(arbor.boardLines()[0]?.openWork, ["c1-app（未合回）"]);
  });

  it("lets a window end once its checkout is applied", async () => {
    const { arbor, journal, backend } = await host();
    backend.script([
      { tool: "code_exec", args: { script: "return await workspace.checkout({ name: 'c1-app', dir: 'proj' })" } },
      { tool: "code_exec", args: { script: "return await workspace.apply({ name: 'c1-app' })" } },
      // The checkout is applied (clean), so end needs no handoff and opens no continuation.
      { tool: "end", args: {} },
    ]);

    await arbor.open(task);
    await backend.finished();

    const applied = await journal.list({ kinds: ["workspace_apply"] });
    assert.equal(applied.items.length, 1);
    assert.equal(backend.opened.length, 1, "a clean window opens no continuation");
  });
});
