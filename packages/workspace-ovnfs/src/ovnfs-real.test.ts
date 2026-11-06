import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { openOvnfs } from "./index.ts";

/**
 * The real-ovnfs tests (docs/workspaces.md). They run the real `ovnfs` binary
 * against a real FUSE mount, so they skip unless the binary is on PATH and FUSE
 * is usable; the skip message names what is missing. CI installs ovnfs v0.1.1
 * and fuse3 and runs these on ubuntu. The unit tests cover the contract against
 * a fake binary; these prove the wiring against the real thing.
 */

function onPath(bin: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("which", [bin], (error) => resolve(error === null));
  });
}

/** Why these tests cannot run, or `false` when they can. */
async function skipReason(): Promise<string | false> {
  if (!(await onPath("ovnfs"))) return "ovnfs binary is not on PATH (install ovnfs v0.1.1)";
  if (process.platform !== "linux" || !existsSync("/dev/fuse") || !(await onPath("fusermount3"))) {
    return "FUSE is not usable (needs Linux, /dev/fuse and fusermount3 from the fuse3 package)";
  }
  return false;
}

/** A git repository at `dir`, with one committed file. */
function gitRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "--quiet"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "test"], { cwd: dir });
  writeFileSync(join(dir, "README.md"), "hello\n");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "--quiet", "-m", "base"], { cwd: dir });
}

/**
 * Stop the test's own daemon, which unmounts its checkouts directory, then
 * remove everything. Removing a still-mounted directory fails with EBUSY.
 */
async function cleanup(root: string): Promise<void> {
  try {
    execFileSync("ovnfs", ["--state", join(root, "state"), "--mount", join(root, "checkouts"), "stop"], { stdio: "ignore" });
  } catch {
    // No daemon was started, or it already stopped.
  }
  await rm(root, { recursive: true, force: true });
}

describe("ovnfs against the real binary", { skip: await skipReason() }, () => {
  it("opens a checkout of a repository and applies a change back into the folder", async () => {
    const root = await mkdtemp(join(tmpdir(), "arbor-ovnfs-real-"));
    try {
      const source = join(root, "repo");
      gitRepo(source);
      const workspace = await openOvnfs({
        source,
        state: join(root, "state"),
        mount: join(root, "checkouts"),
      });
      assert.ok(workspace !== null, "ovnfs daemon should start when the binary and FUSE are present");

      const path = await workspace.openCheckout("c1", "c1-app", source);
      assert.ok(existsSync(join(path, "README.md")), "the checkout shows the repository's files");
      await writeFile(join(path, "added.txt"), "from the checkout\n");
      // The folder is untouched until apply.
      assert.ok(!existsSync(join(source, "added.txt")));

      await workspace.applyCheckout("c1", "c1-app");
      assert.equal(await readFile(join(source, "added.txt"), "utf8"), "from the checkout\n");

      await workspace.removeCheckout("c1-app");
    } finally {
      await cleanup(root);
    }
  });

  it("brings commits made in the checkout back as a branch", async () => {
    const root = await mkdtemp(join(tmpdir(), "arbor-ovnfs-real-"));
    try {
      const source = join(root, "repo");
      gitRepo(source);
      const workspace = await openOvnfs({ source, state: join(root, "state"), mount: join(root, "checkouts") });
      assert.ok(workspace !== null);

      // The repository's own commit-msg hook, in its default hooks directory,
      // which the checkout's private gitdir does not copy.
      const ownHook = join(source, ".git", "hooks", "commit-msg");
      writeFileSync(ownHook, '#!/bin/sh\necho "Repo-Hook: ran" >> "$1"\n', { mode: 0o755 });

      const path = await workspace.openCheckout("c1", "c1-app", source);
      await writeFile(join(path, "feature.txt"), "a feature\n");
      const env = { ...process.env, ...workspace.bashEnv("c1") };
      execFileSync("git", ["add", "."], { cwd: path, env });
      execFileSync("git", ["commit", "--quiet", "-m", "add feature"], { cwd: path, env });
      // The repository's own hook ran, and then the trailer was added.
      const message = execFileSync("git", ["log", "-1", "--format=%B"], { cwd: path }).toString();
      assert.match(message, /Repo-Hook: ran/);
      assert.match(message, /Arbor-Window: c1/);

      const reply = await workspace.applyCheckout("c1", "c1-app", "arbor/c1");
      assert.equal(reply.branch, "arbor/c1");
      // The source folder gained the branch, at the commit the checkout made.
      const head = execFileSync("git", ["rev-parse", "arbor/c1"], { cwd: source }).toString().trim();
      assert.match(head, /^[0-9a-f]{7,}$/);

      await workspace.removeCheckout("c1-app");
    } finally {
      await cleanup(root);
    }
  });

  it("cannot bring a parent folder's checkouts back by branch - open each repository itself", async () => {
    const root = await mkdtemp(join(tmpdir(), "arbor-ovnfs-real-"));
    try {
      const parent = join(root, "parent");
      gitRepo(join(parent, "repoA"));
      gitRepo(join(parent, "repoB"));
      const workspace = await openOvnfs({ source: parent, state: join(root, "state"), mount: join(root, "checkouts") });
      assert.ok(workspace !== null);

      // The parent holds two repositories and is not itself a repository, so its
      // checkout has no root git directory and `--branch` is refused. This is why
      // the prompt tells the model to open each repository's own subfolder.
      const path = await workspace.openCheckout("c2", "c2-parent", parent);
      assert.ok(existsSync(join(path, "repoA", "README.md")));
      await assert.rejects(() => workspace.applyCheckout("c2", "c2-parent", "arbor/c2"));

      // A checkout of one repository itself does get a private git directory.
      const repoPath = await workspace.openCheckout("c2", "c2-repoa", join(parent, "repoA"));
      await writeFile(join(repoPath, "x.txt"), "x\n");
      execFileSync("git", ["add", "."], { cwd: repoPath });
      execFileSync("git", ["commit", "--quiet", "-m", "in repoA"], { cwd: repoPath });
      const reply = await workspace.applyCheckout("c2", "c2-repoa", "arbor/c2");
      assert.equal(reply.branch, "arbor/c2");

      await workspace.removeCheckout("c2-parent").catch(() => {});
      await workspace.removeCheckout("c2-repoa").catch(() => {});
    } finally {
      await cleanup(root);
    }
  });
});
