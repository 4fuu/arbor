import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { DirectoryWorkspace } from "@arbor/workspace-dir";
import { LayerfsWorkspace, layerfsCapabilities } from "@arbor/workspace-layerfs";
import { openWorkspace } from "./workspace.ts";

/**
 * Which `Workspace` a host runs with (docs/workspaces.md). LayerFS is the
 * default and a plain directory is the fallback, so the only thing to prove
 * here is the choice and its reason: a host that cannot run LayerFS gets a
 * working workspace and says why, and one that can gets LayerFS.
 */

describe("the workspace a host runs with", () => {
  it("falls back to a plain directory where LayerFS cannot run, and says why", async () => {
    const root = await mkdtemp(join(tmpdir(), "arbor-workspace-"));
    try {
      // A deployment that cannot run LayerFS: no Store, no Engine socket and
      // no image a Sandbox runs. Which rule refuses first is the machine's -
      // the packages, the addon, the Store, the device or the Engine - so the
      // test asks for the check's own reason, not a particular one.
      const deployment = {
        storePath: join(root, "store", "store.sqlite"),
        docker: join(root, "no-engine.sock"),
        image: "arbor-sandbox:latest",
      };
      const choice = await openWorkspace({
        layerfs: { stateDir: join(root, "registry"), deployment },
        root: join(root, "workspaces"),
      });

      assert.ok(choice.workspace instanceof DirectoryWorkspace);
      // The reason names what to fix, so an operator reads it in the log, and
      // it is the one the check gave rather than one the host invented.
      assert.match(choice.reason ?? "", /\S/);
      assert.equal(choice.reason, (await layerfsCapabilities({ deployment })).reason);

      // The fallback is a working workspace: a window gets its own directory.
      const ref = await choice.workspace.create("c1");
      const mount = await choice.workspace.mount(ref);
      await mount.writeFile?.("notes.txt", "one");
      assert.equal(await mount.readFile?.("notes.txt"), "one");
      await mount.release();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses LayerFS where the machine can mount it", async (t) => {
    const capabilities = await layerfsCapabilities();
    // A host without /dev/fuse, an Engine or a Store cannot mount a Workspace,
    // so the real machine runs this one and an orb skips it.
    if (capabilities.reason !== null) return t.skip(capabilities.reason);
    const choice = await openWorkspace();
    try {
      assert.ok(choice.workspace instanceof LayerfsWorkspace);
      assert.equal(choice.reason, null);
    } finally {
      // The registry the check opened is released, so a later run is not held.
      if (choice.workspace instanceof LayerfsWorkspace) await choice.workspace.close();
    }
  });
});
