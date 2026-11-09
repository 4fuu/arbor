import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { zhTextTable } from "@4fu/arbor-prompt";
import type { Event, EventPage, Journal, WindowRef } from "@4fu/arbor-interfaces";
import { DirectoryWorkspace } from "./directory-workspace.ts";

/** A journal that answers the chain walk and records what was appended. */
class FakeJournal {
  private readonly events: { window: WindowRef; kind: string; body: string | null }[] = [];
  readonly appended: { kind: string; window: WindowRef; body: string | null }[] = [];

  /** One window that continued another, which is what the chain walk reads. */
  start(window: WindowRef, continuation?: WindowRef): void {
    this.events.push({
      window,
      kind: "window_start",
      body: continuation === undefined ? "{}" : JSON.stringify({ continuation }),
    });
  }

  async list(options: {
    window?: WindowRef;
    kinds?: readonly string[];
    limit?: number;
    offset?: number;
  }): Promise<EventPage> {
    const matched = this.events.filter(
      (one) =>
        (options.window === undefined || one.window === options.window) &&
        (options.kinds === undefined || options.kinds.includes(one.kind)),
    );
    const offset = options.offset ?? 0;
    const limit = options.limit ?? 20;
    const items = matched
      .slice(offset, offset + limit)
      .map((one, index) => this.event(one.window, one.kind, one.body, offset + index));
    return { items, total: matched.length, limit, nextCall: "" };
  }

  async append(input: { kind: string; window?: WindowRef | null; body?: string | null }): Promise<Event> {
    const window = (input.window ?? "c0") as WindowRef;
    const body = input.body ?? null;
    this.appended.push({ kind: input.kind, window, body });
    this.events.push({ window, kind: input.kind, body });
    return this.event(window, input.kind, body, this.events.length);
  }

  private event(window: WindowRef, kind: string, body: string | null, index: number): Event {
    return {
      ref: `r${index}`,
      seq: index,
      window,
      time: 0,
      kind,
      targets: [],
      refs: [],
      links: [],
      external: null,
      blobs: [],
      body,
      redacted: null,
    };
  }
}

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

async function fixture(): Promise<{ root: string; workspace: DirectoryWorkspace; journal: FakeJournal }> {
  const root = await tempDir("arbor-ws-");
  const journal = new FakeJournal();
  return { root, journal, workspace: new DirectoryWorkspace({ root, journal: journal as unknown as Journal }) };
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

  it("reads and writes through the mount, at any path the host has", async () => {
    const { workspace } = await fixture();
    const ref = await workspace.create("c1");
    const mount = await workspace.mount(ref);
    await mount.writeFile?.("src/app.ts", "export const a = 1");
    assert.equal(await mount.readFile?.("src/app.ts"), "export const a = 1");
    assert.equal(await mount.readFile?.("missing.ts"), null);
    // Nothing refuses a path outside the window's own directory: the owner asked
    // for no restriction, and the prompt text alone says a directory belongs to
    // another window.
    const outsideRoot = await mkdtemp(join(tmpdir(), "arbor-ws-outside-"));
    try {
      const target = join(outsideRoot, "escape.txt");
      await mount.writeFile?.(target, "x");
      assert.equal(await mount.readFile?.(target), "x");
    } finally {
      await rm(outsideRoot, { recursive: true, force: true });
    }
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
    // The ref the window's chain has is what the host reclaims by.
    assert.equal(await workspace.refOf("c1"), ref);
    await workspace.reclaim(ref);
    assert.equal(await workspace.refOf("c1"), undefined);
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

  it("keeps a persistent directory under the root's keep folder, and hands the same one back", async () => {
    const { root, workspace, journal } = await fixture();
    const path = await workspace.keep("c1", "shared-notes");
    assert.equal(path, join(root, "keep", "shared-notes"));
    await writeFile(join(path, "notes.txt"), "kept", "utf8");
    // The name that is already there is the same directory, not a second one:
    // a later window that wants the same place gets it.
    assert.equal(await workspace.keep("c2", "shared-notes"), path);
    assert.equal(await readFile(join(path, "notes.txt"), "utf8"), "kept");
    // The write is recorded with the window that asked for it.
    assert.deepEqual(
      journal.appended.map((event) => event.kind),
      ["workspace_keep", "workspace_keep"],
    );
    assert.equal(journal.appended[0]?.window, "c1");
  });

  it("makes the same directory a plain mkdir under the keep root makes", async () => {
    const { root, workspace } = await fixture();
    await mkdir(join(root, "keep", "by-hand"), { recursive: true });
    await writeFile(join(root, "keep", "by-hand", "a.txt"), "x", "utf8");
    assert.deepEqual(await workspace.keeps(), [{ name: "by-hand", path: join(root, "keep", "by-hand") }]);
    assert.equal(await workspace.keep("c1", "by-hand"), join(root, "keep", "by-hand"));
  });

  it("spares the persistent directories when it reclaims a window's own directory", async () => {
    const { root, workspace } = await fixture();
    const ref = await workspace.create("c1");
    const kept = await workspace.keep("c1", "build-cache");
    await write(root, ref, "a.txt", "one");
    await writeFile(join(kept, "cache.bin"), "kept", "utf8");
    await workspace.reclaim(ref);
    assert.equal(await workspace.refOf("c1"), undefined);
    // The window's own directory is gone; what it asked to keep is still there,
    // where a restart and a later window find it.
    assert.equal(await readFile(join(root, "ws1", "a.txt"), "utf8").catch(() => null), null);
    assert.equal(await readFile(join(kept, "cache.bin"), "utf8"), "kept");
  });

  it("lists the persistent directories a window's chain created, across the chain", async () => {
    const { workspace, journal } = await fixture();
    await workspace.keep("c1", "one");
    await workspace.keep("c9", "other");
    // c3 continues c1, so the chain's persistent directories are c1's.
    journal.start("c3", "c1");
    assert.deepEqual(
      (await workspace.keeps("c3")).map((keep) => keep.name),
      ["one"],
    );
    assert.deepEqual(
      (await workspace.keeps()).map((keep) => keep.name),
      ["one", "other"],
    );
  });

  it("refuses a persistent directory name that would leave the keep root", async () => {
    const { root, workspace } = await fixture();
    for (const name of ["../escape", ".", "", "Keep", "a".repeat(65)]) {
      await assert.rejects(
        () => workspace.keep("c1", name),
        (error: { rule?: string; nextAction?: string }) => {
          assert.equal(error.rule, "workspace.keep.name");
          assert.ok(error.nextAction !== undefined && error.nextAction.length > 0);
          return true;
        },
      );
    }
    assert.deepEqual(await readdir(root), []);
  });

  it("contributes its own prompt section, with the keep root filled in", async () => {
    const { root, workspace } = await fixture();
    const section = workspace.promptSection();
    assert.equal(section.tag, "workspace");
    const content = await section.content();
    assert.equal(content[0]?.kind, "directory_method");
    assert.equal(content[0]?.fields.root, root);
    assert.match(section.text?.["workspace.method.persistent"] ?? "", /\{root\}\/keep/);
    // The fallback's own method: no shared folder, no checkout, no ovnfs.
    assert.equal(section.text?.["workspace.method.shared"], undefined);
    assert.equal(section.text?.["workspace.method.open"], undefined);
    assert.equal(section.text?.["function.workspace.checkout"], undefined);
  });

  it("answers workspace.keep and workspace.keeps through the module it contributes", async () => {
    const { workspace } = await fixture();
    const group = workspace.groups(zhTextTable)[0];
    assert.ok(group !== undefined);
    const kept = await group.call(
      { name: "workspace.keep", args: { name: "notes" }, callId: "t1" },
      { window: "c1" },
    );
    assert.equal(kept.ok, true);
    assert.match(kept.content, /常驻目录 notes：/);

    const listed = await group.call({ name: "workspace.keeps", args: {}, callId: "t2" }, { window: "c1" });
    assert.equal(listed.ok, true);
    assert.match(listed.content, /notes /);

    const refused = await group.call(
      { name: "workspace.keep", args: { name: "../escape" }, callId: "t3" },
      { window: "c1" },
    );
    assert.equal(refused.ok, false);
    assert.equal(refused.error?.rule, "workspace.keep.name");
    assert.match(refused.error?.nextAction ?? "", /换一个名称/);
  });
});
