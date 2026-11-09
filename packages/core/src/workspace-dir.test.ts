import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { SqliteJournal } from "@4fu/arbor-journal-sqlite";
import { DirectoryWorkspace } from "@4fu/arbor-workspace-dir";
import type { Judge, JudgeAnswer, JudgeRequest } from "@4fu/arbor-interfaces";
import { Arbor } from "./host.ts";
import { ManualTimers, ScriptedBackend, turn } from "./testing.ts";

/**
 * The plain-directory workspace through the whole host
 * (docs/workspaces.md#persistent-directories), driven by the scripted backend.
 *
 * It proves the seams the unit tests do not: a window asks for a persistent
 * directory through `workspace.keep`, the chain's last window ends, the
 * retention period runs out and reclaims the chain's own directory, and a window
 * of a later chain still finds what was kept and reads it. The continuation's
 * first input names the persistent directory its chain created, and the system
 * prompt carries this implementation's own method - no shared folder and no
 * checkout, which is the ovnfs workspace's.
 */

/** The retention period these tests reclaim after. */
const RETENTION_MS = 60_000;

function quietJudge(): Judge {
  return {
    name: "quiet",
    async decide(request: JudgeRequest): Promise<JudgeAnswer> {
      if (request.decision === "model_tier") return { decision: "model_tier", tier: "" };
      return { decision: "active_set", keep: [], drop: [] };
    },
  };
}

async function host(): Promise<{
  arbor: Arbor;
  journal: SqliteJournal;
  backend: ScriptedBackend;
  timers: ManualTimers;
  root: string;
  workspace: DirectoryWorkspace;
}> {
  const journal = new SqliteJournal({ path: ":memory:" });
  const root = await mkdtemp(join(tmpdir(), "arbor-dir-e2e-"));
  const workspace = new DirectoryWorkspace({ root, journal });
  const backend = new ScriptedBackend();
  const timers = new ManualTimers();
  const arbor = new Arbor({
    journal,
    backend,
    timers,
    now: () => 1_700_000_000_000,
    workspace,
    judge: quietJudge(),
    settings: { workspaces: { retentionMs: RETENTION_MS } },
  });
  backend.attach(arbor.windowControl());
  return { arbor, journal, backend, timers, root, workspace };
}

const task = {
  kind: "batch" as const,
  reason: "整理构建缓存",
  targets: ["gh:pr:57"],
  time: 1_700_000_000_000,
  content: [{ kind: "data" as const, fields: { content: "把构建缓存整理好" } }],
};

const handoff = { topics: ["构建"], progress: ["建了常驻目录"], pending: ["写入缓存"], agreements: [], refs: [] };

/** Let the reclaim a fired timer started run to its end. */
async function untilGone(path: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (existsSync(path) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(existsSync(path), false, `${path} was reclaimed`);
}

/** Wait for the backend to have opened `count` windows. */
async function opened(backend: ScriptedBackend, count: number): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (backend.opened.length >= count) return;
    await turn();
  }
  throw new Error(`only ${backend.opened.length} windows opened`);
}

/**
 * Wait for the host to have armed the retention deadline. Retiring a chain
 * reads the workspace from disk, so the wait is bounded by time, not by a count
 * of event-loop turns a loaded machine can run through before the I/O returns.
 */
async function armed(timers: ManualTimers): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (timers.size > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("no retention deadline was armed");
}

/** Every tool result the windows recorded, in order. */
async function results(journal: SqliteJournal): Promise<readonly string[]> {
  const page = await journal.list({ kinds: ["tool_result"], limit: 200 });
  return page.items.map((event) => event.body ?? "");
}

describe("the plain-directory workspace through the host", () => {
  it("keeps a persistent directory past the window, past reclaim and into a later window", async () => {
    const { arbor, journal, backend, timers, root, workspace } = await host();
    try {
      const kept = join(root, "keep", "shared-notes");
      backend.script([
        // The model asks for a persistent directory, and writes into it by the
        // path it is answered with.
        { tool: "code_exec", args: { script: "return await workspace.keep({ name: 'shared-notes' })" } },
        { tool: "write", args: { path: join(kept, "notes.txt"), text: "kept" } },
      ]);

      const record = await arbor.open(task);
      await backend.finished();
      // The continuation's own run: it lists the persistent directories, reads
      // what the previous window left in one, and ends the chain.
      backend.script([
        { tool: "code_exec", args: { script: "return await workspace.keeps()" } },
        { tool: "read", args: { path: join(kept, "notes.txt") } },
        { tool: "end", args: {} },
      ]);
      // The first window ends with a handoff, so the host opens the
      // continuation - which finds the scripted steps waiting for it.
      await arbor.end(record.window, handoff);
      await backend.finished();
      await opened(backend, 2);

      // The window that asked for it is on the record, in the journal.
      const keepEvents = await journal.list({ kinds: ["workspace_keep"] });
      assert.equal(keepEvents.items.length, 1);
      assert.equal(keepEvents.items[0]?.window, "c1");

      // The continuation's first input names the persistent directory its chain
      // created and where it is, and its system prompt carries this
      // implementation's own method.
      const continuation = backend.opened[1];
      if (continuation === undefined) throw new Error("a continuation window opened");
      assert.equal(continuation.window, "c2");
      assert.ok((continuation.firstInput ?? "").includes("shared-notes"), "the continuation was told about it");
      assert.ok((continuation.firstInput ?? "").includes(kept), "the continuation was given its path");
      assert.ok((continuation.prompt.system ?? "").includes("常驻目录"), "the method reached the system prompt");
      assert.ok((continuation.prompt.system ?? "").includes(join(root, "keep")), "the keep root is named");
      // Nothing ovnfs-specific: no shared folder, no checkout.
      assert.ok(!(continuation.prompt.system ?? "").includes("共享文件夹"), "no ovnfs method");
      assert.ok(!(continuation.prompt.system ?? "").includes("检出"), "no ovnfs checkout");

      // The chain's last window ended, so the retention period is waiting, and
      // the chain's own directory and the persistent one are both still there.
      await armed(timers);
      assert.deepEqual(timers.delays(), [RETENTION_MS]);
      assert.ok(existsSync(join(root, "ws1")), "the chain's directory waits out the period");
      assert.ok(existsSync(kept));

      // The period runs out: the chain's own directory goes, and what was kept
      // stays where a later window finds it.
      timers.fireAll();
      await untilGone(join(root, "ws1"));
      assert.equal(await readFile(join(kept, "notes.txt"), "utf8"), "kept");
      assert.equal(await workspace.refOf("c1"), undefined);
      assert.deepEqual(
        (await workspace.keeps("c1")).map((one) => one.name),
        ["shared-notes"],
      );

      // A window of another chain finds it by name and uses it.
      backend.script([
        { tool: "code_exec", args: { script: "return await workspace.keeps()" } },
        { tool: "read", args: { path: join(kept, "notes.txt") } },
      ]);
      await arbor.open(task);
      await backend.finished();
      await opened(backend, 3);

      const later = backend.opened[2];
      if (later === undefined) throw new Error("a later window opened");
      assert.equal(later.window, "c3");
      const answers = await results(journal);
      assert.ok(answers.some((body) => body.includes("shared-notes")), "the later window listed it");
      assert.ok(answers.some((body) => body.includes("kept")), "the later window read it");
      // Its own directory is a fresh one: the chain's was reclaimed.
      assert.equal(await workspace.refOf("c3"), "ws3");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses a persistent directory name that would leave the keep root", async () => {
    const { arbor, journal, backend, root } = await host();
    try {
      backend.script([
        { tool: "code_exec", args: { script: "return await workspace.keep({ name: '../escape' })" } },
      ]);
      await arbor.open(task);
      await backend.finished();
      const answers = await results(journal);
      assert.ok(answers.some((body) => body.includes("不符合约定")), "the name was refused with the rule");
      // Nothing was made outside the keep root, and nothing was made at all.
      assert.deepEqual(await readdir(root), []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("finds the persistent directory again after a host restart", async () => {
    const { arbor, journal, backend, root } = await host();
    try {
      const kept = join(root, "keep", "shared-notes");
      backend.script([
        { tool: "code_exec", args: { script: "return await workspace.keep({ name: 'shared-notes' })" } },
        { tool: "write", args: { path: join(kept, "notes.txt"), text: "kept" } },
      ]);
      await arbor.open(task);
      await backend.finished();
      // A host restart is a new host over the same journal
      // (docs/windows.md#restart): the directory is on the host's own disk, so
      // the new host's window finds it where it was.
      await arbor.close();

      const restarted = new Arbor({
        journal,
        backend: new ScriptedBackend(),
        timers: new ManualTimers(),
        now: () => 1_700_000_000_000,
        judge: quietJudge(),
        workspace: new DirectoryWorkspace({ root, journal }),
        settings: { workspaces: { retentionMs: RETENTION_MS } },
      });
      const fresh = restarted.backend as ScriptedBackend;
      fresh.attach(restarted.windowControl());
      fresh.script([
        { tool: "code_exec", args: { script: "return await workspace.keeps()" } },
        { tool: "read", args: { path: join(kept, "notes.txt") } },
      ]);
      await restarted.open(task);
      await fresh.finished();

      const answers = await results(journal);
      assert.ok(answers.some((body) => body.includes("shared-notes")), "the restarted host listed it");
      assert.ok(answers.some((body) => body.includes("kept")), "the restarted host read it");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
