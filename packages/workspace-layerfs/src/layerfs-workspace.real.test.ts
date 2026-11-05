import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { LayerfsWorkspace } from "./layerfs-workspace.ts";
import { layerfsCapabilities } from "./capabilities.ts";
import type { LayerfsDeployment } from "./options.ts";

/**
 * The integration tests: a real LayerFS Store, and where the machine has
 * `/dev/fuse`, a Docker Engine and the image a Sandbox runs, a real mount.
 *
 * They run only where a deployment configured them and skip otherwise, so a
 * host without FUSE still tests everything else. What they need:
 *
 * - `ARBOR_LAYERFS_SDK`, or the checkout `.agents/setup` makes in `.layerfs`,
 *   with the native addon and the daemon built,
 * - `LAYERFS_STORE_PATH` on ext4, xfs or btrfs, with `LAYERFS_HOME` set,
 * - and for a mount: `LAYERFS_IMAGE`, `LAYERFS_DAEMON`, `LAYERFS_DOCKER` and
 *   `LAYERFS_VOLUME`.
 *
 * One project per run, in one Store. LayerFS initializes one project per
 * Store, and a project's Branches outlive the run that made them, so a run
 * needs a Store no project was initialized in yet - remove the Store file
 * first, the way LayerFS's own end-to-end runs use a fresh volume. A Store
 * that already holds a project skips the run and says so. Under rootless
 * Docker the client process must also run as user 0 inside its own user
 * namespace (`unshare -Ur`): LayerFS's Store install refuses any other user,
 * and a rootless container's root is the unprivileged user on the host.
 */

const deployment: LayerfsDeployment = {
  home: process.env.LAYERFS_HOME,
  storePath: process.env.LAYERFS_STORE_PATH,
  image: process.env.LAYERFS_IMAGE,
  daemon: process.env.LAYERFS_DAEMON,
  docker: process.env.LAYERFS_DOCKER,
  volume: process.env.LAYERFS_VOLUME,
};

const capabilities = await layerfsCapabilities({ deployment });
const storePath = deployment.storePath ?? process.env.LAYERFS_STORE_PATH ?? "";
/** A Store no project was initialized in yet: the one a first run needs. */
const fresh = storePath !== "" && !existsSync(storePath);

/** Why this run cannot use the real Store, or null when it can. */
function unavailable(): string | null {
  if (!capabilities.sdk) return "the LayerFS JavaScript packages are not installed";
  if (!capabilities.addon) return "the native addon is not built";
  if (!capabilities.store) return "no LayerFS Store on ext4, xfs or btrfs is configured";
  if (!fresh) {
    return `the Store at ${storePath} already holds an initialized project: remove it for a full run (LayerFS initializes one project per Store)`;
  }
  return null;
}

/** Why a mount cannot run here, or null when it can. */
function unmountable(): string | null {
  const reason = unavailable();
  if (reason !== null) return reason;
  if (!capabilities.fuse) return "no /dev/fuse on this machine";
  if (capabilities.dockerReason !== null) return capabilities.dockerReason;
  return null;
}

/** The folder a first Init imports into the base Branch: a small tree. */
async function source(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "arbor-layerfs-source-"));
  await writeFile(join(directory, "README.md"), "# a window's directory\n");
  await mkdir(join(directory, "src"), { recursive: true });
  await writeFile(join(directory, "src", "main.ts"), "export const main = 1;\n");
  return directory;
}

async function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), "arbor-layerfs-it-"));
}

/**
 * The one project this run works in, and the workspace every test mounts:
 * made once, because a second project cannot be initialized into a Store
 * that already holds one.
 */
let shared: { ws: LayerfsWorkspace; directory: string } | null = null;

before(async () => {
  if (unavailable() !== null) return;
  const directory = await scratch();
  const ws = new LayerfsWorkspace({
    project: `arbor-it-${Math.random().toString(36).slice(2, 10)}`,
    stateDir: join(directory, "registry"),
    deployment: { ...deployment, source: await source() },
  });
  await ws.create("c1");
  shared = { ws, directory };
});

after(async () => {
  if (shared === null) return;
  await shared.ws.close();
  await rm(shared.directory, { recursive: true, force: true });
  shared = null;
});

/** The run's workspace, or the reason this test cannot use it. */
function run(mount = false): LayerfsWorkspace | string {
  const reason = mount ? unmountable() : unavailable();
  if (reason !== null) return reason;
  if (shared === null) return "the run's workspace was not made";
  return shared.ws;
}

describe("a real Store", () => {
  it("creates one directory per window and forks a continuation from it", async (t) => {
    const made = run();
    if (typeof made === "string") return t.skip(made);
    const ws = made;

    // The continuation forks the window's directory: metadata only, so the
    // files the first window had are there without being copied.
    const second = await ws.fork("ws1", "c2");
    assert.equal(second, "ws2");
    // The Init's import is the base Branch's root, not a Commit, so the
    // newest Commit a fresh workspace has is none and its logical size is
    // zero; the file count walks the tree the import made.
    assert.deepEqual(await ws.quota("ws1"), { bytes: 0, used: 0, files: 2 });
    assert.deepEqual(await ws.quota("ws2"), { bytes: 0, used: 0, files: 2 });

    // A workspace nothing was written to has no Commit, so no snapshot.
    await assert.rejects(() => ws.snapshot("ws1", "r1"), (error: unknown) => {
      assert.equal((error as { rule: string }).rule, "workspace.snapshot.empty");
      return true;
    });
    assert.deepEqual(await ws.snapshots("ws1"), {
      items: [],
      total: 0,
      limit: 20,
      nextCall: "workspace.snapshots(ws1, offset=20)",
    });
  });
});

describe("a real mount", () => {
  it("mounts, runs a command, snapshots it and reads the snapshot back", async (t) => {
    const made = run(true);
    if (typeof made === "string") return t.skip(made);
    const ws = made;
    const ref = "ws1";
    const mount = await ws.mount(ref);

    const written = await mount.exec?.("printf 'hello\\n' > notes.txt");
    assert.equal(written?.exitCode, 0);

    const snapshot = await ws.snapshot(ref, "r902");
    assert.equal(snapshot.ref, "ws1@r902");
    assert.notEqual(snapshot.id, "");

    const read = await mount.exec?.("cat notes.txt");
    assert.equal(read?.stdout, "hello\n");

    await mount.release();

    // The snapshot the event recorded is readable read-only, and nothing
    // written in it is published.
    const view = await ws.mount(`${ref}@r902`);
    assert.equal(view.readOnly, true);
    const shown = await view.exec?.("cat notes.txt");
    assert.equal(shown?.stdout, "hello\n");
    await view.exec?.("printf 'changed\\n' > notes.txt");
    await view.release();

    const page = await ws.snapshots(ref);
    assert.equal(page.total, 1);
    assert.equal(page.items[0]?.event, "r902");

    // The workspace still holds what the agent left: the view published
    // nothing over it.
    const again = await ws.mount(ref);
    const kept = await again.exec?.("cat notes.txt");
    assert.equal(kept?.stdout, "hello\n");
    await again.release();

    // Nothing changed since the snapshot was taken.
    assert.deepEqual((await ws.diff(`${ref}@r902`, ref)).files, []);
  });
});

describe("a background job", () => {
  it("runs a command past the call that started it, follows its output and stops it", async (t) => {
    const made = run(true);
    if (typeof made === "string") return t.skip(made);
    const ws = made;
    const mount = await ws.mount("ws1");

    const started = await mount.jobs?.start("printf 'first\\n'; sleep 30");
    assert.match(started?.id ?? "", /^proc_\d+_/);
    assert.equal(started?.running, true);
    assert.equal(started?.output, "");

    // The command outlives the call that started it, and what it wrote is
    // readable while it still runs.
    const followed = await mount.jobs?.output(started?.id ?? "");
    assert.equal(followed?.running, true);
    assert.match(followed?.output ?? "", /first/);

    // A command that ends on its own stops being reported as running.
    const quick = await mount.jobs?.start("printf 'quick\\n'");
    let ended = false;
    for (let attempt = 0; attempt < 50 && !ended; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      ended = (await mount.jobs?.output(quick?.id ?? ""))?.running === false;
    }
    assert.equal(ended, true);

    await mount.jobs?.stop(started?.id ?? "");
    const stopped = await mount.jobs?.output(started?.id ?? "");
    assert.equal(stopped?.running, false);

    // Releasing the mount stops what it started, so the unmount is answered:
    // LayerFS refuses to unmount a Workspace a background process still runs in.
    await mount.release();
  });
});

describe("a mounted file", () => {
  it("reads and writes one over LayerFS's own fs calls, not through a command", async (t) => {
    const made = run(true);
    if (typeof made === "string") return t.skip(made);
    const ws = made;
    // The continuation workspace, which no command has written in.
    const ref = "ws2";
    const mount = await ws.mount(ref);

    // The imported tree is there, and a file that is not, is null.
    assert.equal(await mount.readFile?.("README.md"), "# a window's directory\n");
    assert.equal(await mount.readFile?.("notes.txt"), null);

    // The write publishes a Commit on the workspace's Branch, so the next
    // snapshot holds it without a command in the Sandbox.
    await mount.writeFile?.("notes.txt", "hello\n");
    assert.equal(await mount.readFile?.("notes.txt"), "hello\n");
    const snapshot = await ws.snapshot(ref, "r902");
    assert.equal(snapshot.ref, "ws2@r902");

    // A nested write makes its directory.
    await mount.writeFile?.("src/main.ts", "export const main = 2;\n");
    assert.equal(await mount.readFile?.("src/main.ts"), "export const main = 2;\n");
    await mount.release();

    // The snapshot the event recorded holds the first write.
    const view = await ws.mount(`${ref}@r902`);
    assert.equal(view.readOnly, true);
    assert.equal(await view.readFile?.("notes.txt"), "hello\n");
    await assert.rejects(() => view.writeFile?.("notes.txt", "changed\n") as Promise<void>, (error: unknown) => {
      assert.equal((error as { rule: string }).rule, "mount.readonly");
      return true;
    });
    await view.release();

    // The view published nothing over the workspace.
    const again = await ws.mount(ref);
    assert.equal(await again.readFile?.("notes.txt"), "hello\n");
    assert.equal(await again.readFile?.("src/main.ts"), "export const main = 2;\n");
    await again.release();
  });
});
