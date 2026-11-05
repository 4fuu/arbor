import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { DirectoryWorkspace } from "./directory-workspace.ts";

async function fixture(): Promise<{ root: string; workspace: DirectoryWorkspace }> {
  const root = await mkdtemp(join(tmpdir(), "arbor-ws-"));
  return { root, workspace: new DirectoryWorkspace({ root, now: () => 1700000000000 }) };
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
    const reopened = new DirectoryWorkspace({ root });
    const ref = await reopened.create("c1");
    const again = new DirectoryWorkspace({ root });
    assert.equal(await again.create("c2"), "ws2");
    assert.equal(ref, "ws1");
  });

  it("forks a continuation's directory, so work in progress carries over", async () => {
    const { root, workspace } = await fixture();
    const first = await workspace.create("c1");
    await write(root, first, "src/app.ts", "export const a = 1");
    const fork = await workspace.fork(first, "c2");
    assert.equal(await readFile(join(root, fork, "src/app.ts"), "utf8"), "export const a = 1");
    await write(root, fork, "src/app.ts", "export const a = 2");
    assert.equal(await readFile(join(root, first, "src/app.ts"), "utf8"), "export const a = 1");
  });

  it("snapshots the directory's state at one event and keeps it after later edits", async () => {
    const { root, workspace } = await fixture();
    const ref = await workspace.create("c1");
    await write(root, ref, "app.ts", "v1");
    const handle = await workspace.snapshot(ref, "r902");
    assert.equal(handle.ref, "ws1@r902");
    await write(root, ref, "app.ts", "v2");
    const mount = await workspace.mount("ws1@r902");
    assert.equal(await readFile(join(mount.path, "app.ts"), "utf8"), "v1");
    assert.equal(mount.readOnly, true);
    await mount.release();
  });

  it("lists snapshots newest first, bounded", async () => {
    const { workspace } = await fixture();
    const ref = await workspace.create("c1");
    await workspace.snapshot(ref, "r901");
    await workspace.snapshot(ref, "r902");
    await workspace.snapshot(ref, "r903");
    const page = await workspace.snapshots(ref);
    assert.deepEqual(
      page.items.map((item) => item.ref),
      ["ws1@r903", "ws1@r902", "ws1@r901"],
    );
    assert.equal(page.total, 3);
    assert.equal(page.items[0]?.event, "r903");
    const cut = await workspace.snapshots(ref, { limit: 2 });
    assert.equal(cut.items.length, 2);
    assert.match(cut.nextCall, /offset: 2/);
  });

  it("takes the newest snapshot when no event is named", async () => {
    const { workspace } = await fixture();
    const ref = await workspace.create("c1");
    await workspace.snapshot(ref, "r901");
    const handle = await workspace.snapshot(ref);
    assert.equal(handle.ref, "ws1@latest");
    const page = await workspace.snapshots(ref);
    assert.deepEqual(
      page.items.map((item) => item.ref),
      ["ws1@latest", "ws1@r901"],
    );
  });

  it("diffs two snapshots", async () => {
    const { root, workspace } = await fixture();
    const ref = await workspace.create("c1");
    await write(root, ref, "keep.ts", "same");
    await write(root, ref, "gone.ts", "bye");
    await workspace.snapshot(ref, "r901");
    await rm(join(root, ref, "gone.ts"));
    await write(root, ref, "keep.ts", "changed");
    await write(root, ref, "new.ts", "hello");
    await workspace.snapshot(ref, "r902");
    const diff = await workspace.diff("ws1@r901", "ws1@r902");
    const byPath = new Map(diff.files.map((file) => [file.path, file.status]));
    assert.equal(byPath.get("gone.ts"), "removed");
    assert.equal(byPath.get("keep.ts"), "changed");
    assert.equal(byPath.get("new.ts"), "added");
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

  it("reclaims the snapshots after the retention period", async () => {
    const { workspace } = await fixture();
    const ref = await workspace.create("c1");
    await workspace.snapshot(ref, "r901");
    await workspace.reclaim(ref);
    const page = await workspace.snapshots(ref);
    assert.equal(page.total, 0);
  });

  it("refuses a ref that does not exist, with the next action", async () => {
    const { workspace } = await fixture();
    await assert.rejects(
      () => workspace.mount("ws9@r902"),
      (error: { rule?: string; nextAction?: string }) => {
        assert.equal(error.rule, "workspace.not_found");
        assert.ok(error.nextAction !== undefined && error.nextAction.length > 0);
        return true;
      },
    );
  });

  it("makes a read-only mount unwritable while it is held", async () => {
    const { root, workspace } = await fixture();
    const ref = await workspace.create("c1");
    await write(root, ref, "a.txt", "one");
    await workspace.snapshot(ref, "r901");
    const mount = await workspace.mount("ws1@r901");
    await assert.rejects(() => writeFile(join(mount.path, "a.txt"), "two", "utf8"));
    await mount.release();
    await writeFile(join(root, ref, "a.txt"), "two", "utf8");
  });
});
