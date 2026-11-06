import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { DirectoryWorkspace } from "@arbor/workspace-dir";
import { openWorkspace } from "./workspace.ts";

/**
 * Which `Workspace` a host runs with (docs/workspaces.md): one directory per
 * window, under the root the host names. It is the only implementation the
 * framework ships, so there is no choice to prove here - only that the host
 * gets a working workspace where it asked for one.
 */

describe("the workspace a host runs with", () => {
  it("is a plain directory, under the root the host names", async () => {
    const root = await mkdtemp(join(tmpdir(), "arbor-workspace-"));
    try {
      const workspace = await openWorkspace({ root });
      assert.ok(workspace instanceof DirectoryWorkspace);

      const ref = await workspace.create("c1");
      const mount = await workspace.mount(ref);
      await mount.writeFile?.("notes.txt", "one");
      assert.equal(await mount.readFile?.("notes.txt"), "one");
      await mount.release();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
