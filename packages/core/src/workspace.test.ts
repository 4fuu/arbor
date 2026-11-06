import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { DirectoryWorkspace } from "@4fu/arbor-workspace-dir";
import { openWorkspace } from "./workspace.ts";

/**
 * Which `Workspace` a host runs with (docs/workspaces.md): ovnfs when a shared
 * folder is named and its daemon starts, else the plain directory, under the
 * root the host names. With no shared folder named there is no ovnfs to try, so
 * the host always lands on the plain directory here - which needs nothing a host
 * does not already have.
 */

describe("the workspace a host runs with", () => {
  it("is a plain directory, under the root the host names", async () => {
    const root = await mkdtemp(join(tmpdir(), "arbor-workspace-"));
    try {
      const { workspace, backend } = await openWorkspace({ root });
      assert.equal(backend, "dir");
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
