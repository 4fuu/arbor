import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
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
 */

const deployment: LayerfsDeployment = {
  home: process.env.LAYERFS_HOME,
  storePath: process.env.LAYERFS_STORE_PATH,
  image: process.env.LAYERFS_IMAGE,
  daemon: process.env.LAYERFS_DAEMON,
  docker: process.env.LAYERFS_DOCKER,
  volume: process.env.LAYERFS_VOLUME,
};

const capabilities = layerfsCapabilities({ deployment });
const store = capabilities.sdk && capabilities.addon && capabilities.store;
const mounting = store && capabilities.fuse && capabilities.docker;

const project = `arbor-it-${Math.random().toString(36).slice(2, 10)}`;

/** The folder a first Init imports into the base Branch: a small tree. */
async function source(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "arbor-layerfs-source-"));
  await writeFile(join(directory, "README.md"), "# a window's directory\n");
  await mkdir(join(directory, "src"));
  await writeFile(join(directory, "src", "main.ts"), "export const main = 1;\n");
  return directory;
}

async function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), "arbor-layerfs-it-"));
}

describe("a real Store", () => {
  it("creates one directory per window and forks a continuation from it", async (t) => {
    if (!store) return t.skip("no LayerFS Store on ext4, xfs or btrfs is configured");
    const directory = await scratch();
    const ws = new LayerfsWorkspace({
      project,
      stateDir: join(directory, "registry"),
      deployment: { ...deployment, source: await source() },
    });
    try {
      const first = await ws.create("c1");
      assert.equal(first, "ws1");

      // The continuation forks the window's directory: metadata only, so the
      // files the first window had are there without being copied.
      const second = await ws.fork(first, "c2");
      assert.equal(second, "ws2");
      assert.deepEqual(await ws.quota(first), { bytes: 0, used: 32, files: 2 });
      assert.deepEqual(await ws.quota(second), { bytes: 0, used: 32, files: 2 });

      // A workspace nothing was written to has no Commit, so no snapshot.
      await assert.rejects(() => ws.snapshot(first, "r1"), (error: unknown) => {
        assert.equal((error as { rule: string }).rule, "workspace.snapshot.empty");
        return true;
      });
      assert.deepEqual(await ws.snapshots(first), {
        items: [],
        total: 0,
        limit: 20,
        nextCall: "workspace.snapshots(ws1, offset=20)",
      });
    } finally {
      await ws.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("a real mount", () => {
  it("mounts, runs a command, snapshots it and reads the snapshot back", async (t) => {
    if (!mounting) return t.skip("no /dev/fuse, Docker Engine or Sandbox image is available");
    const directory = await scratch();
    const ws = new LayerfsWorkspace({
      project,
      stateDir: join(directory, "registry"),
      deployment: { ...deployment, source: await source() },
    });
    try {
      const ref = await ws.create("c1");
      const mount = await ws.mount(ref);

      const written = await mount.exec?.("printf 'hello\\n' > /notes.txt");
      assert.equal(written?.exitCode, 0);

      const snapshot = await ws.snapshot(ref, "r902");
      assert.equal(snapshot.ref, "ws1@r902");
      assert.notEqual(snapshot.id, "");

      const read = await mount.exec?.("cat /notes.txt");
      assert.equal(read?.stdout, "hello\n");

      await mount.release();

      // The snapshot the event recorded is readable read-only, and nothing
      // written in it is published.
      const view = await ws.mount(`${ref}@r902`);
      assert.equal(view.readOnly, true);
      const shown = await view.exec?.("cat /notes.txt");
      assert.equal(shown?.stdout, "hello\n");
      await view.exec?.("printf 'changed\\n' > /notes.txt");
      await view.release();

      const page = await ws.snapshots(ref);
      assert.equal(page.total, 1);
      assert.equal(page.items[0]?.event, "r902");

      // The workspace still holds what the agent left: the view published
      // nothing over it.
      const again = await ws.mount(ref);
      const kept = await again.exec?.("cat /notes.txt");
      assert.equal(kept?.stdout, "hello\n");
      await again.release();

      // Nothing changed since the snapshot was taken.
      assert.deepEqual((await ws.diff(`${ref}@r902`, ref)).files, []);
    } finally {
      await ws.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
