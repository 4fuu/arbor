import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { isArborError } from "@arbor/errors";
import type { EventRef, WorkspaceRef } from "@arbor/interfaces";
import { LayerfsWorkspace } from "./layerfs-workspace.ts";
import { layerfsCapabilities } from "./capabilities.ts";

/**
 * These tests drive the real `@layerfs/agent` JavaScript over the stand-in
 * native binding beside them: no Docker, no FUSE, no Store file, so they run
 * wherever the packages are installed. What they check is this package's side
 * of the contract - which Branch a ref names, which Commit an event's snapshot
 * holds, what a mount does and what it never publishes - and the shapes the
 * binding answers with, which are the ones a real Store returns.
 *
 * The tests that need a real Store, a Sandbox and `/dev/fuse` are in
 * `layerfs-workspace.real.test.ts`; they skip where those are missing.
 */

const require = createRequire(import.meta.url);
const FIXTURE = join(import.meta.dirname, "fixture", "layerfs-native.cjs");

interface Standin {
  state: {
    calls: { op: string; args: Record<string, unknown> }[];
    branches: Map<string, { head: string | null }>;
  };
  calls: { op: string; args: Record<string, unknown> }[];
  reset(): void;
  write(branch: string, path: string, text: string, message?: string): string;
  headOf(branch: string): string | null;
  branchNames(): string[];
  seedDiff(from: string, to: string, items: unknown[]): void;
  refuse(op: string, code: string, message: string): void;
  mounts(): { sandbox: string; path: string; branch: string }[];
  sandboxes(): { sandbox: string; workspaces: number }[];
  touch(path: string): void;
  commitId(): string;
  /** The background processes the stand-in daemon holds, as `process.list` sees them. */
  processes(): { id: string; sandbox: string; path: string; command: string; status: string }[];
  /** Write what a background command wrote into the log the daemon keeps for it. */
  jobLog(id: string, text: string): void;
  /** Mark a background process ended on its own, the way a finished command does. */
  jobExit(id: string): void;
  /** One Sandbox's own files, outside every Workspace it holds: what staging lands in. */
  containerFiles(sandbox: string): { path: string; text: string; readOnly: boolean }[];
}

const standin = require(FIXTURE) as Standin;

const capabilities = await layerfsCapabilities({});

/** Which calls the binding saw, by method name. */
function opsCalled(name: string): Record<string, unknown>[] {
  return standin.calls.filter((call) => call.op === name).map((call) => call.args);
}

/** The arguments of one call, cut to the ones the assertion is about. */
function pick(args: Record<string, unknown>, names: string[]): Record<string, unknown> {
  return Object.fromEntries(names.map((name) => [name, args[name]]));
}

const forks = () => opsCalled("branch.fork").map((args) => pick(args, ["name", "from"]));
const mounts = () => opsCalled("workspace.mount").map((args) => pick(args, ["sandbox", "branch"]));

let clock = 0;
let directory: string;

function workspace(options: { quotaBytes?: number } = {}): LayerfsWorkspace {
  return new LayerfsWorkspace({
    project: "arbor-test",
    stateDir: join(directory, "registry"),
    quotaBytes: options.quotaBytes,
    now: () => {
      clock += 1;
      return 1_700_000_000_000 + clock;
    },
    deployment: {
      home: join(directory, "home"),
      storePath: join(directory, "store", "store.sqlite"),
      addon: FIXTURE,
      image: `sha256:${"b".repeat(64)}`,
      docker: "/var/run/docker.sock",
      daemon: "/opt/layerfs/layerfs-daemon",
      volume: "arbor-store",
    },
  });
}

beforeEach(async () => {
  if (!capabilities.sdk) return;
  directory = await mkdtemp(join(tmpdir(), "arbor-workspace-layerfs-"));
  clock = 0;
  standin.reset();
});

afterEach(async () => {
  if (directory === undefined) return;
  await rm(directory, { recursive: true, force: true });
  directory = undefined as unknown as string;
});

describe("create", () => {
  it("forks the window's own directory from the base branch", async (t) => {
    if (!capabilities.sdk) return t.skip("the LayerFS JavaScript packages are not installed");
    const ws = workspace();
    const ref = await ws.create("c1");

    assert.equal(ref, "ws1");
    assert.deepEqual(forks(), [{ name: "ws1", from: "main" }]);
    assert.ok(standin.branchNames().includes("ws1"));
    await ws.close();
  });

  it("numbers the workspaces in the order they are created", async (t) => {
    if (!capabilities.sdk) return t.skip("the LayerFS JavaScript packages are not installed");
    const ws = workspace();
    assert.equal(await ws.create("c1"), "ws1");
    assert.equal(await ws.create("c2"), "ws2");
    await ws.close();
  });
});

describe("fork", () => {
  it("forks a continuation from the workspace it continues, and no file is copied", async (t) => {
    if (!capabilities.sdk) return t.skip("the LayerFS JavaScript packages are not installed");
    const ws = workspace();
    await ws.create("c1");
    const first = standin.write("ws1", "/notes.txt", "work in progress\n");
    const second = await ws.fork("ws1", "c2");

    assert.equal(second, "ws2");
    assert.deepEqual(forks().at(-1), { name: "ws2", from: "ws1" });
    // The fork is metadata: it starts at the same Commit, and its files are
    // the ones the parent had, with nothing copied between them.
    assert.equal(standin.headOf("ws2"), first);
    standin.write("ws2", "/other.txt", "only in the fork\n");
    assert.equal(standin.headOf("ws1"), first);
    await ws.close();
  });
});

describe("snapshot", () => {
  it("commits the mounted workspace and records the commit at the event", async (t) => {
    if (!capabilities.sdk) return t.skip("the LayerFS JavaScript packages are not installed");
    const ws = workspace();
    await ws.create("c1");
    const mount = await ws.mount("ws1");
    standin.touch(mount.path);

    const handle = await ws.snapshot("ws1", "r902");

    assert.equal(handle.ref, "ws1@r902");
    assert.equal(handle.id, standin.headOf("ws1"));
    const commits = opsCalled("workspace.commit");
    assert.equal(commits.length, 1);
    assert.equal(commits[0]?.path, mount.path);
    await mount.release();
    await ws.close();
  });

  it("answers the snapshot it already has when the same event is recorded twice", async (t) => {
    if (!capabilities.sdk) return t.skip("the LayerFS JavaScript packages are not installed");
    const ws = workspace();
    await ws.create("c1");
    const mount = await ws.mount("ws1");
    standin.touch(mount.path);

    const first = await ws.snapshot("ws1", "r902");
    const again = await ws.snapshot("ws1", "r902");

    assert.equal(again.id, first.id);
    assert.equal(opsCalled("workspace.commit").length, 1);
    await mount.release();
    await ws.close();
  });

  it("takes the branch head when nothing is mounted", async (t) => {
    if (!capabilities.sdk) return t.skip("the LayerFS JavaScript packages are not installed");
    const ws = workspace();
    await ws.create("c1");
    standin.write("ws1", "/a.txt", "hello\n");

    const handle = await ws.snapshot("ws1", "r902");

    assert.equal(handle.ref, "ws1@r902");
    assert.equal(handle.id, standin.headOf("ws1"));
    assert.equal(opsCalled("workspace.commit").length, 0);
    assert.equal(opsCalled("branch.list_commits").length, 1);
    await ws.close();
  });

  it("refuses a workspace with nothing committed yet", async (t) => {
    if (!capabilities.sdk) return t.skip("the LayerFS JavaScript packages are not installed");
    const ws = workspace();
    await ws.create("c1");
    await assert.rejects(() => ws.snapshot("ws1", "r902"), (error: unknown) => {
      assert.ok(isArborError(error));
      assert.equal(error.rule, "workspace.snapshot.empty");
      assert.equal(error.code, "unavailable");
      assert.match(error.nextAction ?? "", /write a file or run a command/);
      return true;
    });
    await ws.close();
  });

  it("refuses an unknown workspace and a ref that is not an event", async (t) => {
    if (!capabilities.sdk) return t.skip("the LayerFS JavaScript packages are not installed");
    const ws = workspace();
    await ws.create("c1");
    await assert.rejects(() => ws.snapshot("ws9", "r902"), (error: unknown) => {
      assert.equal((error as { rule: string }).rule, "workspace.unknown");
      return true;
    });
    await assert.rejects(() => ws.snapshot("ws1", "r9x" as EventRef), (error: unknown) => {
      assert.equal((error as { rule: string }).rule, "workspace.snapshot.event");
      return true;
    });
    await ws.close();
  });
});

describe("snapshots", () => {
  it("lists the recorded snapshots newest first", async (t) => {
    if (!capabilities.sdk) return t.skip("the LayerFS JavaScript packages are not installed");
    const ws = workspace();
    await ws.create("c1");
    standin.write("ws1", "/a.txt", "hello\n");
    await ws.snapshot("ws1", "r902");
    standin.write("ws1", "/b.txt", "world\n");
    await ws.snapshot("ws1", "r903");
    // A snapshot taken without an event resolves, and is not listed: it has no event.
    const latest = await ws.snapshot("ws1");

    const page = await ws.snapshots("ws1");
    assert.equal(page.total, 2);
    assert.deepEqual(
      page.items.map((item) => item.event),
      ["r903", "r902"],
    );
    assert.equal(page.items[0]?.ref, "ws1@r903");
    assert.equal(page.items[1]?.ref, "ws1@r902");
    assert.equal(latest.ref, "ws1@latest");
    await ws.close();
  });

  it("pages", async (t) => {
    if (!capabilities.sdk) return t.skip("the LayerFS JavaScript packages are not installed");
    const ws = workspace();
    await ws.create("c1");
    standin.write("ws1", "/a.txt", "hello\n");
    for (const event of ["r1", "r2", "r3"] as EventRef[]) await ws.snapshot("ws1", event);

    const page = await ws.snapshots("ws1", { limit: 2 });
    assert.deepEqual(
      page.items.map((item) => item.event),
      ["r3", "r2"],
    );
    assert.equal(page.nextCall, "workspace.snapshots(ws1, offset=2)");
    await ws.close();
  });
});

describe("mount", () => {
  it("mounts the workspace read-write in a sandbox it starts", async (t) => {
    if (!capabilities.sdk) return t.skip("the LayerFS JavaScript packages are not installed");
    const ws = workspace();
    await ws.create("c1");

    const mount = await ws.mount("ws1");

    assert.equal(mount.ref, "ws1");
    assert.equal(mount.readOnly, false);
    assert.equal(mount.path, standin.mounts()[0]?.path);
    assert.deepEqual(mounts().at(-1), { sandbox: "1", branch: "ws1" });
    assert.equal(opsCalled("sandbox.create").length, 1);
    await mount.release();
    await ws.close();
  });

  it("commits what the agent left before it releases the mount", async (t) => {
    if (!capabilities.sdk) return t.skip("the LayerFS JavaScript packages are not installed");
    const ws = workspace();
    await ws.create("c1");
    const mount = await ws.mount("ws1");
    standin.touch(mount.path);

    await mount.release();

    const commit = opsCalled("workspace.commit").at(-1);
    const unmount = opsCalled("workspace.unmount").at(-1);
    assert.equal(commit?.path, mount.path);
    assert.equal(unmount?.path, mount.path);
    assert.equal(unmount?.discard, false);
    assert.equal(unmount?.force, false);
    assert.equal(standin.mounts().length, 0);
    await ws.close();
  });

  it("mounts a snapshot read-only through a branch forked at its commit", async (t) => {
    if (!capabilities.sdk) return t.skip("the LayerFS JavaScript packages are not installed");
    const ws = workspace();
    await ws.create("c1");
    standin.write("ws1", "/a.txt", "hello\n");
    const recorded = await ws.snapshot("ws1", "r902");

    const mount = await ws.mount("ws1@r902");

    assert.equal(mount.ref, "ws1@r902");
    assert.equal(mount.readOnly, true);
    assert.deepEqual(forks().at(-1), { name: "ws1-r902-view", from: recorded.id });
    assert.deepEqual(mounts().at(-1), { sandbox: "1", branch: "ws1-r902-view" });
    await mount.release();
    await ws.close();
  });

  it("discards a read-only view instead of publishing anything it saw", async (t) => {
    if (!capabilities.sdk) return t.skip("the LayerFS JavaScript packages are not installed");
    const ws = workspace();
    await ws.create("c1");
    standin.write("ws1", "/a.txt", "hello\n");
    await ws.snapshot("ws1", "r902");
    const before = opsCalled("workspace.commit").length;

    const mount = await ws.mount("ws1@r902");
    standin.touch(mount.path);
    await mount.release();

    const commits = opsCalled("workspace.commit");
    assert.equal(commits.length, before);
    assert.equal(opsCalled("workspace.unmount").at(-1)?.discard, true);
    await ws.close();
  });

  it("runs a command in the mounted workspace", async (t) => {
    if (!capabilities.sdk) return t.skip("the LayerFS JavaScript packages are not installed");
    const ws = workspace();
    await ws.create("c1");
    const mount = await ws.mount("ws1");

    const result = await mount.exec?.("echo hi");

    assert.deepEqual(result, { exitCode: 0, stdout: "ran: echo hi\n", stderr: "", truncated: false });
    assert.equal(opsCalled("workspace.exec").at(-1)?.command, "echo hi");
    await mount.release();
    await ws.close();
  });

  it("refuses a command in a mount that was released", async (t) => {
    if (!capabilities.sdk) return t.skip("the LayerFS JavaScript packages are not installed");
    const ws = workspace();
    await ws.create("c1");
    const mount = await ws.mount("ws1");
    await mount.release();

    await assert.rejects(async () => (await mount.exec?.("echo hi")) !== undefined, (error: unknown) => {
      assert.equal((error as { rule: string }).rule, "workspace.mount.released");
      return true;
    });
    await ws.close();
  });

  it("reuses one sandbox until it is full", async (t) => {
    if (!capabilities.sdk) return t.skip("the LayerFS JavaScript packages are not installed");
    const ws = workspace();
    await ws.create("c1");
    const first = await ws.mount("ws1");
    const second = await ws.mount("ws1");

    assert.equal(opsCalled("sandbox.create").length, 1);
    assert.notEqual(first.path, second.path);
    assert.equal(standin.sandboxes()[0]?.workspaces, 2);
    await first.release();
    await second.release();
    await ws.close();
  });

  it("refuses a mount of a workspace that does not exist", async (t) => {
    if (!capabilities.sdk) return t.skip("the LayerFS JavaScript packages are not installed");
    const ws = workspace();
    await ws.create("c1");
    await assert.rejects(() => ws.mount("ws9"), (error: unknown) => {
      assert.equal((error as { rule: string }).rule, "workspace.unknown");
      return true;
    });
    await assert.rejects(() => ws.mount("ws1@r902"), (error: unknown) => {
      assert.equal((error as { rule: string }).rule, "workspace.snapshot.unknown");
      return true;
    });
    await assert.rejects(() => ws.mount("not-a-ref" as WorkspaceRef), (error: unknown) => {
      assert.equal((error as { rule: string }).rule, "workspace.ref.shape");
      return true;
    });
    await ws.close();
  });
});

describe("reading and writing a mounted file", () => {
  it("reads one over LayerFS's own fs.read, and answers null for a file that is not there", async (t) => {
    if (!capabilities.sdk) return t.skip("the LayerFS JavaScript packages are not installed");
    const ws = workspace();
    await ws.create("c1");
    standin.write("ws1", "/notes.txt", "work in progress\n");
    const mount = await ws.mount("ws1");

    assert.equal(await mount.readFile?.("notes.txt"), "work in progress\n");
    // An absolute path is taken as it is, so it escapes the mount's own
    // directory exactly as it escapes a host workspace's path.
    assert.equal(await mount.readFile?.("/notes.txt"), null);
    assert.equal(await mount.readFile?.("missing.txt"), null);
    assert.equal(await mount.readFile?.("../outside.txt"), null);
    assert.deepEqual(pick(opsCalled("fs.read")[0] ?? {}, ["branch", "path", "startLine"]), {
      branch: "ws1",
      path: "/notes.txt",
      startLine: 1,
    });

    await mount.release();
    await ws.close();
  });

  it("writes one over LayerFS's own fs.write, which publishes the write as a Commit", async (t) => {
    if (!capabilities.sdk) return t.skip("the LayerFS JavaScript packages are not installed");
    const ws = workspace();
    await ws.create("c1");
    const mount = await ws.mount("ws1");
    const before = standin.headOf("ws1");

    await mount.writeFile?.("notes.txt", "hello\n");

    assert.deepEqual(pick(opsCalled("fs.write")[0] ?? {}, ["branch", "path", "content", "message"]), {
      branch: "ws1",
      path: "/notes.txt",
      content: "hello\n",
      message: "write /notes.txt",
    });
    assert.notEqual(standin.headOf("ws1"), before);
    assert.equal(await mount.readFile?.("notes.txt"), "hello\n");
    await mount.release();
    await ws.close();
  });

  it("makes the directory a write names before it writes", async (t) => {
    if (!capabilities.sdk) return t.skip("the LayerFS JavaScript packages are not installed");
    const ws = workspace();
    await ws.create("c1");
    const mount = await ws.mount("ws1");

    await mount.writeFile?.("src/main.ts", "export const main = 1;\n");

    assert.deepEqual(pick(opsCalled("fs.mkdir")[0] ?? {}, ["branch", "path", "recursive", "message"]), {
      branch: "ws1",
      path: "/src",
      recursive: true,
      message: "write /src/main.ts",
    });
    assert.equal(await mount.readFile?.("src/main.ts"), "export const main = 1;\n");
    await mount.release();
    await ws.close();
  });

  it("refuses a write whose path escapes the workspace", async (t) => {
    if (!capabilities.sdk) return t.skip("the LayerFS JavaScript packages are not installed");
    const ws = workspace();
    await ws.create("c1");
    const mount = await ws.mount("ws1");

    await assert.rejects(() => mount.writeFile?.("../outside.txt", "x\n") as Promise<void>, (error: unknown) => {
      assert.equal((error as { rule: string }).rule, "file.outside_workspace");
      return true;
    });
    assert.equal(opsCalled("fs.write").length, 0);
    await mount.release();
    await ws.close();
  });

  it("refuses a write in a read-only view, and still reads one", async (t) => {
    if (!capabilities.sdk) return t.skip("the LayerFS JavaScript packages are not installed");
    const ws = workspace();
    await ws.create("c1");
    standin.write("ws1", "/a.txt", "hello\n");
    await ws.snapshot("ws1", "r902");

    const view = await ws.mount("ws1@r902");

    assert.equal(await view.readFile?.("a.txt"), "hello\n");
    await assert.rejects(() => view.writeFile?.("a.txt", "changed\n") as Promise<void>, (error: unknown) => {
      assert.equal((error as { rule: string }).rule, "mount.readonly");
      return true;
    });
    assert.equal(opsCalled("fs.write").length, 0);
    await view.release();
    await ws.close();
  });
});

describe("background jobs", () => {
  it("starts one through the daemon's process API and follows its output", async (t) => {
    if (!capabilities.sdk) return t.skip("the LayerFS JavaScript packages are not installed");
    const ws = workspace();
    await ws.create("c1");
    const mount = await ws.mount("ws1");

    const started = await mount.jobs?.start("echo hello; sleep 30");
    assert.match(started?.id ?? "", /^proc_1_/);
    assert.equal(started?.command, "echo hello; sleep 30");
    assert.equal(started?.running, true);
    assert.deepEqual(pick(opsCalled("backend.daemon.process.start")[0] ?? {}, ["command", "background"]), {
      command: "echo hello; sleep 30",
      background: true,
    });
    // The Sandbox and the path the job runs in are the mount's own.
    assert.deepEqual(
      pick(opsCalled("backend.daemon.process.start")[0] ?? {}, ["sandbox", "path"]),
      { sandbox: "1", path: mount.path },
    );

    // What the command wrote is read from the log the daemon keeps for it.
    standin.jobLog(started?.id ?? "", "hello\n");
    const followed = await mount.jobs?.output(started?.id ?? "");
    assert.equal(followed?.output, "hello\n");
    assert.equal(followed?.running, true);
    assert.deepEqual(pick(opsCalled("workspace.exec").at(-1) ?? {}, ["command"]), {
      command: `tail -c 262144 /tmp/layerfs-${started?.id}.log`,
    });

    await mount.release();
    await ws.close();
  });

  it("reports a job that ended on its own, and stops one that still runs", async (t) => {
    if (!capabilities.sdk) return t.skip("the LayerFS JavaScript packages are not installed");
    const ws = workspace();
    await ws.create("c1");
    const mount = await ws.mount("ws1");
    const finished = await mount.jobs?.start("echo done");
    const running = await mount.jobs?.start("sleep 30");

    standin.jobExit(finished?.id ?? "");
    const ended = await mount.jobs?.output(finished?.id ?? "");
    assert.equal(ended?.running, false);

    await mount.jobs?.stop(running?.id ?? "");
    const stopped = await mount.jobs?.output(running?.id ?? "");
    assert.equal(stopped?.running, false);
    assert.deepEqual(pick(opsCalled("backend.daemon.process.cancel")[0] ?? {}, ["process"]), {
      process: running?.id,
    });

    await mount.release();
    await ws.close();
  });

  it("refuses a job no mounted workspace started", async (t) => {
    if (!capabilities.sdk) return t.skip("the LayerFS JavaScript packages are not installed");
    const ws = workspace();
    await ws.create("c1");
    const mount = await ws.mount("ws1");

    await assert.rejects(() => mount.jobs?.output("proc_1_nosuchjob") as Promise<unknown>, (error: unknown) => {
      assert.equal((error as { rule: string }).rule, "workspace.job.unknown");
      return true;
    });

    await mount.release();
    await ws.close();
  });

  it("stops the jobs it started before it releases the mount, so the unmount is not refused", async (t) => {
    if (!capabilities.sdk) return t.skip("the LayerFS JavaScript packages are not installed");
    const ws = workspace();
    await ws.create("c1");
    const mount = await ws.mount("ws1");
    const job = await mount.jobs?.start("sleep 30");

    await mount.release();

    // LayerFS refuses to unmount a Workspace a background process still runs
    // in, so the release stops the job first: the cancel lands before the
    // unmount, and the unmount is answered.
    assert.deepEqual(pick(opsCalled("backend.daemon.process.cancel")[0] ?? {}, ["process"]), {
      process: job?.id,
    });
    const cancelAt = standin.calls.findIndex((call) => call.op === "backend.daemon.process.cancel");
    const unmountAt = standin.calls.findIndex((call) => call.op === "workspace.unmount");
    assert.ok(cancelAt >= 0 && unmountAt > cancelAt);
    assert.equal(standin.mounts().length, 0);
    await ws.close();
  });

  it("gives a read-only view no jobs: it must never publish anything", async (t) => {
    if (!capabilities.sdk) return t.skip("the LayerFS JavaScript packages are not installed");
    const ws = workspace();
    await ws.create("c1");
    standin.write("ws1", "/a.txt", "hello\n");
    await ws.snapshot("ws1", "r902");

    const view = await ws.mount("ws1@r902");

    assert.equal(view.jobs, undefined);
    await view.release();
    await ws.close();
  });
});

describe("staged files", () => {
  it("stages files beside the mount, and no snapshot holds them", async (t) => {
    if (!capabilities.sdk) return t.skip("the LayerFS JavaScript packages are not installed");
    const ws = workspace();
    await ws.create("c1");
    const mount = await ws.mount("ws1");

    const at = await mount.stage?.("/env", [
      { path: "skills/deploy/SKILL.md", text: "# deploy\n" },
      { path: "settings.json", text: '{"identity":"arbor"}\n' },
    ]);

    // The files are visible to a command in the mount, read the way a window
    // reads them once the prefix is rewritten onto where they were staged.
    assert.equal((await mount.exec?.(`cat ${at}/settings.json`))?.stdout, '{"identity":"arbor"}\n');
    // A command cannot change what was staged: the environment changes through
    // its own draft and reload, never through a command.
    const overwrite = `printf '%s' ${Buffer.from("changed\n").toString("base64")} | base64 -d > '${at}/settings.json'`;
    const refusedWrite = await mount.exec?.(overwrite);
    assert.equal(refusedWrite?.exitCode, 1);

    // The staged files are not the workspace's own: nothing was committed for
    // them, so the snapshot holds no /env files and the workspace's tree counts
    // none.
    standin.touch(mount.path);
    const handle = await ws.snapshot("ws1", "r902");
    assert.equal(handle.ref, "ws1@r902");
    assert.deepEqual(await ws.quota("ws1"), { bytes: 0, used: 0, files: 0 });
    const view = await ws.mount("ws1@r902");
    assert.equal(await view.readFile?.("env/settings.json"), null);
    assert.equal(await view.readFile?.("settings.json"), null);
    await view.release();

    // They live in the Sandbox's own filesystem, outside every Workspace.
    assert.deepEqual(
      standin
        .containerFiles("1")
        .map((file) => ({ path: file.path, readOnly: file.readOnly }))
        .sort((left, right) => (left.path < right.path ? -1 : 1)),
      [
        { path: `${at}/settings.json`, readOnly: true },
        { path: `${at}/skills/deploy/SKILL.md`, readOnly: true },
      ],
    );

    await mount.release();
    await ws.close();
  });

  it("stages again what a reload landed, in the same mount", async (t) => {
    if (!capabilities.sdk) return t.skip("the LayerFS JavaScript packages are not installed");
    const ws = workspace();
    await ws.create("c1");
    const mount = await ws.mount("ws1");

    const first = await mount.stage?.("/env", [{ path: "settings.json", text: '{"identity":"one"}\n' }]);
    assert.equal((await mount.exec?.(`cat ${first}/settings.json`))?.stdout, '{"identity":"one"}\n');

    // A `reload` lands as a new revision, and the next command stages it again
    // in the same mount: what the first staging made read-only is made
    // writable first, so the new files are the ones a command reads.
    const second = await mount.stage?.("/env", [{ path: "settings.json", text: '{"identity":"two"}\n' }]);
    assert.equal(second, first);
    assert.equal((await mount.exec?.(`cat ${second}/settings.json`))?.stdout, '{"identity":"two"}\n');
    // Still read-only, and still no file the second staging dropped.
    const refused = `printf '%s' ${Buffer.from("x\n").toString("base64")} | base64 -d > '${second}/settings.json'`;
    assert.equal((await mount.exec?.(refused))?.exitCode, 1);
    assert.deepEqual(
      standin.containerFiles("1").map((file) => ({ path: file.path, readOnly: file.readOnly })),
      [{ path: `${second}/settings.json`, readOnly: true }],
    );

    await mount.release();
    await ws.close();
  });

  it("gives a read-only view no staging: it must never publish anything", async (t) => {
    if (!capabilities.sdk) return t.skip("the LayerFS JavaScript packages are not installed");
    const ws = workspace();
    await ws.create("c1");
    standin.write("ws1", "/a.txt", "hello\n");
    await ws.snapshot("ws1", "r902");

    const view = await ws.mount("ws1@r902");

    assert.equal(view.stage, undefined);
    await view.release();
    await ws.close();
  });
});

describe("diff", () => {
  it("maps a commit diff onto arbor's files", async (t) => {
    if (!capabilities.sdk) return t.skip("the LayerFS JavaScript packages are not installed");
    const ws = workspace();
    await ws.create("c1");
    standin.write("ws1", "/seed.txt", "seed\n");
    const before = standin.headOf("ws1");
    await ws.snapshot("ws1", "r902");
    standin.write("ws1", "/added.txt", "one\ntwo\n");
    standin.write("ws1", "/changed.txt", "after\n");
    const after = standin.headOf("ws1");
    standin.seedDiff(before as string, after as string, [
      {
        path: "/added.txt",
        kind: "Added",
        type: "file",
        before: null,
        after: { type: "file", inode: 2 },
        content: true,
        identity: true,
        metadata: false,
        hunks: [
          { op: "+", text: "one" },
          { op: "+", text: "two" },
        ],
        hunksOmitted: false,
      },
      {
        path: "/changed.txt",
        kind: "Modified",
        type: "file",
        before: { type: "file", inode: 3 },
        after: { type: "file", inode: 4 },
        content: true,
        identity: true,
        metadata: false,
        hunks: [
          { op: "-", text: "before" },
          { op: "+", text: "after" },
        ],
        hunksOmitted: false,
      },
      {
        path: "/gone.txt",
        kind: "Removed",
        type: "file",
        before: { type: "file", inode: 5 },
        after: null,
        content: false,
        identity: false,
        metadata: false,
        hunks: null,
        hunksOmitted: false,
      },
    ]);

    const diff = await ws.diff("ws1@r902", "ws1");

    assert.deepEqual(diff.from, "ws1@r902");
    assert.deepEqual(diff.to, "ws1");
    assert.deepEqual(diff.files, [
      { path: "/added.txt", status: "added", added: 2, removed: 0 },
      { path: "/changed.txt", status: "changed", added: 1, removed: 1 },
      { path: "/gone.txt", status: "removed" },
    ]);
    const called = opsCalled("branch.diff_commits").at(-1);
    assert.equal(called?.from, before);
    assert.equal(called?.to, after);
    assert.equal(called?.hunks, undefined);
    await ws.close();
  });
});

describe("quota", () => {
  it("reports the configured limit, the tree's bytes and its files", async (t) => {
    if (!capabilities.sdk) return t.skip("the LayerFS JavaScript packages are not installed");
    const ws = workspace({ quotaBytes: 4096 });
    await ws.create("c1");
    standin.write("ws1", "/a.txt", "hello");
    standin.write("ws1", "/src/b.txt", "world!");

    const quota = await ws.quota("ws1");

    assert.deepEqual(quota, { bytes: 4096, used: 11, files: 2 });
    await ws.close();
  });

  it("reports no limit and no bytes for a workspace nothing was written to", async (t) => {
    if (!capabilities.sdk) return t.skip("the LayerFS JavaScript packages are not installed");
    const ws = workspace();
    await ws.create("c1");

    assert.deepEqual(await ws.quota("ws1"), { bytes: 0, used: 0, files: 0 });
    await ws.close();
  });
});

describe("reclaim", () => {
  it("drops the refs and refuses what they named", async (t) => {
    if (!capabilities.sdk) return t.skip("the LayerFS JavaScript packages are not installed");
    const ws = workspace();
    await ws.create("c1");
    standin.write("ws1", "/a.txt", "hello\n");
    await ws.snapshot("ws1", "r902");
    const mount = await ws.mount("ws1");

    await ws.reclaim("ws1");

    assert.equal(standin.mounts().length, 0);
    assert.deepEqual(await ws.snapshots("ws1"), { items: [], total: 0, limit: 20, nextCall: "workspace.snapshots(ws1, offset=20)" });
    await assert.rejects(() => ws.mount("ws1"), (error: unknown) => {
      assert.equal((error as { rule: string }).rule, "workspace.reclaimed");
      return true;
    });
    await assert.rejects(() => ws.snapshot("ws1", "r903"), (error: unknown) => {
      assert.equal((error as { rule: string }).rule, "workspace.reclaimed");
      return true;
    });
    // The number stays taken, so a ref that once resolved keeps its meaning.
    assert.equal(await ws.create("c9"), "ws2");
    await mount.release();
    await ws.close();
  });
});

describe("refusals", () => {
  it("wraps a LayerFS refusal in the core error shape and gives the number back", async (t) => {
    if (!capabilities.sdk) return t.skip("the LayerFS JavaScript packages are not installed");
    const ws = workspace();
    standin.refuse("branch.fork", "Conflict", "the head moved");

    await assert.rejects(() => ws.create("c1"), (error: unknown) => {
      assert.ok(isArborError(error));
      assert.equal(error.code, "conflict");
      assert.equal(error.rule, "workspace.create.fork");
      assert.match(error.message, /could not be forked from main/);
      assert.match(error.nextAction ?? "", /has the Branch main/);
      return true;
    });
    standin.calls.length = 0;
    standin.state.calls.length = 0;
    standin.refuse("branch.fork", "NoSuchBranch", "no such branch");
    standin.state.branches.delete("main");

    await assert.rejects(() => ws.create("c1"), (error: unknown) => {
      assert.equal((error as { code: string }).code, "not_found");
      return true;
    });
    await ws.close();
  });
});
