import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import { zhTextTable } from "@4fu/arbor-prompt";
import type { Event, EventPage, Journal, WindowRef } from "@4fu/arbor-interfaces";
import { OvnfsWorkspace } from "./ovnfs.ts";

/** A journal that only answers the chain walk and records what was appended. */
class FakeJournal {
  private readonly started: { window: WindowRef; continuation?: WindowRef }[] = [];
  readonly appended: { kind: string; window: string; body: string | null }[] = [];

  start(window: WindowRef, continuation?: WindowRef): void {
    this.started.push(continuation === undefined ? { window } : { window, continuation });
  }

  async list(options: { window?: WindowRef; kinds?: readonly string[]; limit?: number }): Promise<EventPage> {
    let items = this.started;
    if (options.window !== undefined) items = items.filter((one) => one.window === options.window);
    const limit = options.limit ?? 20;
    const page = items.slice(0, limit).map((one, index) => this.event(one.window, "window_start", one.continuation, index));
    return { items: page, total: items.length, limit, nextCall: "" };
  }

  async append(input: { kind: string; window?: WindowRef | null; body?: string | null }): Promise<Event> {
    const window = (input.window ?? "c0") as WindowRef;
    this.appended.push({ kind: input.kind, window, body: input.body ?? null });
    return this.event(window, input.kind, undefined, this.appended.length);
  }

  private event(window: WindowRef, kind: string, continuation: WindowRef | undefined, index: number): Event {
    return {
      ref: `r${index + 1}`,
      seq: index + 1,
      window,
      time: 0,
      kind,
      targets: [],
      refs: [],
      links: [],
      external: null,
      blobs: [],
      body: continuation === undefined ? "{}" : JSON.stringify({ continuation }),
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

async function fixture(): Promise<{ workspace: OvnfsWorkspace; journal: FakeJournal; root: string; source: string }> {
  const root = await tempDir("arbor-ovnfs-");
  const source = join(root, "shared");
  const state = join(root, "state");
  const mount = join(root, "checkouts");
  await mkdir(source, { recursive: true });
  const bin = join(root, "bin", "ovnfs");
  await mkdir(dirname(bin), { recursive: true });
  const script = await readFile(join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "fake-ovnfs.mjs"), "utf8");
  await writeFile(bin, script, "utf8");
  await chmod(bin, 0o755);
  const journal = new FakeJournal();
  const workspace = new OvnfsWorkspace({ source, state, mount, bin, journal: journal as unknown as Journal });
  return { workspace, journal, root, source };
}

/** Run one module function through the group the workspace contributes. */
async function call(workspace: OvnfsWorkspace, name: string, args: Record<string, unknown>, window: WindowRef) {
  const group = workspace.groups(zhTextTable)[0];
  assert.ok(group !== undefined);
  return group.call({ name, args, callId: "t1" }, { window });
}

describe("ovnfs workspace", () => {
  it("mounts the shared folder, read-write on the host, reaching a checkout by absolute path", async () => {
    const { workspace, source } = await fixture();
    const ref = await workspace.create("c1");
    assert.equal(ref, "ws1");
    const mount = await workspace.mount(ref);
    assert.equal(mount.path, source);
    await mount.writeFile?.("notes.txt", "hello");
    assert.equal(await mount.readFile?.("notes.txt"), "hello");
    // An absolute path is read where it names - how a window reaches its checkout.
    const outside = join(source, "sub", "a.txt");
    await mount.writeFile?.(outside, "x");
    assert.equal(await mount.readFile?.(outside), "x");
    assert.equal(await mount.readFile?.("missing.txt"), null);
    await mount.release();
  });

  it("refuses a ref that is not a workspace token", async () => {
    const { workspace } = await fixture();
    await assert.rejects(() => workspace.mount("nope" as never), (error: { rule?: string }) => {
      assert.equal(error.rule, "workspace.ref.unknown");
      return true;
    });
  });

  it("opens a checkout through the module function and records it", async () => {
    const { workspace, journal } = await fixture();
    const result = await call(workspace, "workspace.checkout", { name: "c1-app", dir: "proj" }, "c1");
    assert.equal(result.ok, true);
    assert.match(result.content, /已打开检出 c1-app/);
    assert.equal(journal.appended.filter((one) => one.kind === "workspace_checkout").length, 1);
    assert.equal(journal.appended[0]?.window, "c1");
  });

  it("refuses a checkout whose name does not begin with the window ref", async () => {
    const { workspace } = await fixture();
    const result = await call(workspace, "workspace.checkout", { name: "app" }, "c1");
    assert.equal(result.ok, false);
    assert.equal(result.error?.rule, "refused.workspace.name");
    assert.ok(result.error?.nextAction !== undefined && result.error.nextAction.length > 0);

    // The real binary refuses uppercase; the host refuses it first, by its own rule.
    const upper = await call(workspace, "workspace.checkout", { name: "c1-MyApp" }, "c1");
    assert.equal(upper.error?.rule, "refused.workspace.name");
  });

  it("lists, diffs, applies and removes a checkout", async () => {
    const { workspace, journal } = await fixture();
    await call(workspace, "workspace.checkout", { name: "c1-app" }, "c1");

    const listed = await call(workspace, "workspace.list", {}, "c1");
    assert.equal(listed.ok, true);
    assert.match(listed.content, /c1-app/);
    assert.match(listed.content, /未合回/);

    const diffed = await call(workspace, "workspace.diff", { name: "c1-app" }, "c1");
    assert.equal(diffed.ok, true);
    assert.match(diffed.content, /M src\/app\.ts/);

    const applied = await call(workspace, "workspace.apply", { name: "c1-app" }, "c1");
    assert.equal(applied.ok, true);
    assert.match(applied.content, /已合回 c1-app/);
    assert.equal(journal.appended.filter((one) => one.kind === "workspace_apply").length, 1);

    const removed = await call(workspace, "workspace.rm", { name: "c1-app" }, "c1");
    assert.equal(removed.ok, true);
    const afterRm = await call(workspace, "workspace.list", {}, "c1");
    assert.match(afterRm.content, /没有检出/);
  });

  it("reports a conflict and asks the model to resolve and apply again", async () => {
    const { workspace, journal } = await fixture();
    await call(workspace, "workspace.checkout", { name: "c1-conflict" }, "c1");
    const applied = await call(workspace, "workspace.apply", { name: "c1-conflict" }, "c1");
    assert.equal(applied.ok, true);
    assert.match(applied.content, /有冲突/);
    assert.match(applied.content, /再合一次/);
    assert.equal(journal.appended.filter((one) => one.kind === "workspace_conflict").length, 1);
  });

  it("brings commits back as a branch when apply names one", async () => {
    const { workspace } = await fixture();
    await call(workspace, "workspace.checkout", { name: "c1-app" }, "c1");
    const applied = await call(workspace, "workspace.apply", { name: "c1-app", branch: "arbor/c1" }, "c1");
    assert.equal(applied.ok, true);
    assert.match(applied.content, /分支 arbor\/c1/);
  });

  it("answers another window's checkouts by its window ref", async () => {
    const { workspace } = await fixture();
    await call(workspace, "workspace.checkout", { name: "c1-app" }, "c1");
    const found = await call(workspace, "workspace.path", { window: "c1" }, "c2");
    assert.equal(found.ok, true);
    assert.match(found.content, /c1-app/);
    const none = await call(workspace, "workspace.path", { window: "c9" }, "c2");
    assert.match(none.content, /c9 没有检出/);
  });

  it("binds a checkout to its window by the name prefix, across a chain", async () => {
    const { workspace, journal } = await fixture();
    journal.start("c1");
    journal.start("c2", "c1");
    await call(workspace, "workspace.checkout", { name: "c1-app" }, "c1");
    await call(workspace, "workspace.checkout", { name: "c2-web" }, "c2");

    // A continuation sees its predecessor's checkouts too, through the chain.
    const c1 = await workspace.checkouts("c1");
    assert.deepEqual(c1.map((one) => one.name), ["c1-app"]);
    const c2 = await workspace.checkouts("c2");
    assert.deepEqual(c2.map((one) => one.name).sort(), ["c1-app", "c2-web"]);
    // A checkout is dirty until it is applied, which is open work at end.
    assert.ok(c2.every((one) => one.dirty));
  });

  it("reclaims a chain's checkouts, found by the prefix", async () => {
    const { workspace, journal } = await fixture();
    journal.start("c1");
    journal.start("c2", "c1");
    await call(workspace, "workspace.checkout", { name: "c1-app" }, "c1");
    await call(workspace, "workspace.checkout", { name: "c2-web" }, "c2");
    await call(workspace, "workspace.checkout", { name: "c9-other" }, "c9");

    // The host asks by the chain root; reclaim removes the whole chain, and
    // leaves an unrelated window's checkout alone.
    assert.equal(await workspace.refOf("c1"), "ws1");
    assert.equal(await workspace.refOf("c9"), "ws9");
    await workspace.reclaim("ws1");
    assert.equal(await workspace.refOf("c1"), undefined);
    assert.equal(await workspace.refOf("c9"), "ws9");
    await workspace.reclaim("ws9");
    assert.equal(await workspace.refOf("c9"), undefined);
  });

  it("has no ref to reclaim when the chain opened no checkout", async () => {
    const { workspace } = await fixture();
    assert.equal(await workspace.refOf("c5"), undefined);
  });

  it("contributes a workspace prompt section carrying the method", async () => {
    const { workspace, source } = await fixture();
    const section = workspace.promptSection();
    assert.equal(section.tag, "workspace");
    assert.equal(section.text?.["workspace.method.shared"], "共享文件夹 {source}：所有窗口都从这里读取，命令工具默认也在这里运行；它可以放多个项目和多个 git 仓库。");
    const content = await section.content();
    assert.equal(content[0]?.kind, "workspace_method");
    assert.equal(content[0]?.fields.source, source);
  });

  it("gives the shell tool the window ref and the git hook path, pointing at this package's hooks", async () => {
    const { workspace } = await fixture();
    const env = workspace.bashEnv("c42");
    assert.equal(env.ARBOR_WINDOW, "c42");
    assert.equal(env.GIT_CONFIG_COUNT, "1");
    assert.equal(env.GIT_CONFIG_KEY_0, "core.hooksPath");
    assert.match(env.GIT_CONFIG_VALUE_0 ?? "", /[/\\]hooks$/);
  });

  it("seeds the ovnfs skill beside its own built-in skills", async () => {
    const { workspace } = await fixture();
    const skills = workspace.builtinSkills();
    assert.equal(skills.length, 1);
    assert.equal(skills[0]?.name, "ovnfs");
    assert.match(skills[0]?.source ?? "", /[/\\]skills[/\\]ovnfs$/);
  });

  it("reports the quota of the shared folder", async () => {
    const { workspace, source } = await fixture();
    await writeFile(join(source, "a.txt"), "12345", "utf8");
    const quota = await workspace.quota("ws1");
    assert.equal(quota.files, 1);
    assert.equal(quota.used, 5);
  });
});
