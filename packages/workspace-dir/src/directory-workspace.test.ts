import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { DirectoryWorkspace } from "./directory-workspace.ts";

async function fixture(): Promise<{ root: string; workspace: DirectoryWorkspace }> {
  const root = await mkdtemp(join(tmpdir(), "arbor-ws-"));
  return { root, workspace: new DirectoryWorkspace({ root }) };
}

async function write(root: string, workspace: string, path: string, text: string): Promise<void> {
  const full = join(root, workspace, path);
  await mkdir(join(full, ".."), { recursive: true });
  await writeFile(full, text, "utf8");
}

describe("directory workspace", () => {
  it("gives every window its own directory", async () => {
    const { root, workspace } = await fixture();
    const first = await workspace.create("c1");
    const second = await workspace.create("c2");
    assert.equal(first, "ws1");
    assert.equal(second, "ws2");
    await write(root, first, "a.txt", "one");
    await write(root, second, "a.txt", "two");
    assert.equal(await readFile(join(root, first, "a.txt"), "utf8"), "one");
    assert.equal(await readFile(join(root, second, "a.txt"), "utf8"), "two");
  });

  it("keeps its refs across a restart", async () => {
    const { root } = await fixture();
    const ref = await new DirectoryWorkspace({ root }).create("c1");
    const again = new DirectoryWorkspace({ root });
    assert.equal(ref, "ws1");
    assert.equal(await again.create("c2"), "ws2");
  });

  it("reads and writes through the mount, and refuses a path outside the directory", async () => {
    const { workspace } = await fixture();
    const ref = await workspace.create("c1");
    const mount = await workspace.mount(ref);
    await mount.writeFile?.("src/app.ts", "export const a = 1");
    assert.equal(await mount.readFile?.("src/app.ts"), "export const a = 1");
    assert.equal(await mount.readFile?.("missing.ts"), null);
    await assert.rejects(async () => {
      await mount.writeFile?.("../escape.txt", "x");
    }, (error: { rule?: string }) => {
      assert.equal(error.rule, "file.outside_workspace");
      return true;
    });
    await mount.release();
  });

  it("continues in the predecessor's directory, in place, under the same ref", async () => {
    const { root, workspace } = await fixture();
    const first = await workspace.create("c1");
    await write(root, first, "src/app.ts", "export const a = 1");
    // A continuation asks for the window that opened its chain and gets the
    // same directory back: no copy, no link, no fork.
    const again = await workspace.create("c1");
    assert.equal(again, first);
    assert.equal(await readFile(join(root, first, "src/app.ts"), "utf8"), "export const a = 1");
    assert.deepEqual(await readdir(root), [first]);
  });

  it("reads another window's directory through the mount, by its absolute path", async () => {
    const { root, workspace } = await fixture();
    const first = await workspace.create("c1");
    await write(root, first, "notes.txt", "work in progress");
    const second = await workspace.create("c2");
    const mount = await workspace.mount(second);
    assert.equal(await mount.readFile?.(join(root, first, "notes.txt")), "work in progress");
    // A relative path still names this window's own directory.
    assert.equal(await mount.readFile?.("notes.txt"), null);
    await mount.release();
  });

  it("reports the quota of a workspace", async () => {
    const { root, workspace } = await fixture();
    const ref = await workspace.create("c1");
    await write(root, ref, "a.txt", "12345");
    await write(root, ref, "b.txt", "678");
    const quota = await workspace.quota(ref);
    assert.equal(quota.files, 2);
    assert.equal(quota.used, 8);
  });

  it("reclaims the workspace's directory", async () => {
    const { root, workspace } = await fixture();
    const ref = await workspace.create("c1");
    await write(root, ref, "a.txt", "one");
    await workspace.reclaim(ref);
    await assert.rejects(() => workspace.mount(ref), (error: { rule?: string }) => {
      assert.equal(error.rule, "workspace.not_found");
      return true;
    });
  });

  it("refuses a ref that does not exist, with the next action", async () => {
    const { workspace } = await fixture();
    await assert.rejects(
      () => workspace.mount("ws9"),
      (error: { rule?: string; nextAction?: string }) => {
        assert.equal(error.rule, "workspace.not_found");
        assert.ok(error.nextAction !== undefined && error.nextAction.length > 0);
        return true;
      },
    );
  });
});
