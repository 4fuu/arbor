/**
 * The shell tool on the host it runs on: `/bin/sh -c` on POSIX, PowerShell on
 * Windows.
 *
 * The pure half checks the Windows resolution on any host; the live half runs
 * the tool the host actually gives the model - `bash` on POSIX, `pwsh` on
 * Windows - through the same quick command and background-job path the catalog
 * uses. Each host's process-tree stop is checked where it exists: the POSIX
 * one here, the Windows one in the Windows CI job.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import type { CallContext, ToolResult } from "@4fu/arbor-interfaces";
import { zhTextTable } from "@4fu/arbor-prompt";
import { FileToolGroup, shellFor } from "./groups/files.ts";
import type { ToolServices } from "./host.ts";

/** The temporary directories this file owns, removed when it is done. */
const roots: string[] = [];

after(() => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))));

async function tempDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "arbor-shell-"));
  roots.push(root);
  return root;
}

/**
 * A directory that holds one PowerShell executable, laid out the way
 * `shellFor` looks for it, so the Windows resolution can be exercised on any
 * host.
 */
async function powershellRoot(kind: "pwsh" | "powershell"): Promise<string> {
  const root = await tempDir();
  const file = kind === "pwsh"
    ? join(root, "PowerShell", "7", "pwsh.exe")
    : join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, "");
  return root;
}

/** The services the shell tool reads: a table, a workspace and no environment. */
function servicesFor(root: string): ToolServices {
  return {
    table: zhTextTable,
    ensureWorkspace: async () => ({ path: root }),
    envPaths: () => undefined,
  } as unknown as ToolServices;
}

/** Call one tool the way the catalog does. */
function call(group: FileToolGroup, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  return group.call(
    { name, args, callId: "call_1" },
    { window: "c1", envRevision: undefined } as CallContext,
  );
}

/** Wait for what a stop reaches asynchronously, up to a few seconds. */
async function until<T>(probe: () => Promise<T | undefined> | T | undefined, ms = 5000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting for the stop to land");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** Whether a process is gone: signal 0 reaches it for as long as it exists. */
function gone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

/** The pid the command wrote to `gc.pid`, once it has written it. */
async function recordedPid(root: string): Promise<number> {
  const text = await until(async () => {
    const written = await readFile(join(root, "gc.pid"), "utf8").catch(() => "");
    return written.trim() === "" ? undefined : written.trim();
  });
  const pid = Number(text);
  assert.ok(Number.isInteger(pid) && pid > 0, `the command records its grandchild's pid: ${text}`);
  return pid;
}

describe("the shell a host gives a window", () => {
  it("is PowerShell on Windows and sh on POSIX", () => {
    const windows = shellFor("win32", { PATH: "" });
    assert.equal(windows.run, "pwsh");
    assert.equal(windows.output, "pwsh_output");
    assert.equal(windows.stop, "pwsh_stop");
    const executable = windows.executable.toLowerCase();
    assert.ok(
      executable.endsWith("pwsh") || executable.endsWith("pwsh.exe") || executable.endsWith("powershell.exe"),
      windows.executable,
    );
    const argv = windows.args("Write-Output hello");
    assert.deepEqual(argv.slice(0, 4), ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"]);
    assert.ok(argv[4]?.startsWith("[Console]::OutputEncoding"));
    assert.ok(argv[4]?.endsWith("Write-Output hello"));
    // Windows ends the tree by pid; POSIX gives the command its own group.
    assert.equal(windows.detached, false);

    const posix = shellFor("linux");
    assert.equal(posix.run, "bash");
    assert.equal(posix.executable, "/bin/sh");
    assert.deepEqual(posix.args("echo hello"), ["-c", "echo hello"]);
    assert.equal(posix.detached, true);
    assert.equal(posix.edition, undefined, "the host's sh has one form");
  });

  it("names the PowerShell edition its executable speaks", async () => {
    const seven = await powershellRoot("pwsh");
    const five = await powershellRoot("powershell");

    const resolved7 = shellFor("win32", { ProgramFiles: seven, PATH: "", SystemRoot: "/nonexistent" });
    assert.ok(resolved7.executable.toLowerCase().endsWith("pwsh.exe"), resolved7.executable);
    assert.equal(resolved7.edition, "PowerShell 7");

    const resolved51 = shellFor("win32", { ProgramFiles: "/nonexistent", PATH: "", SystemRoot: five });
    assert.ok(resolved51.executable.toLowerCase().endsWith("powershell.exe"), resolved51.executable);
    assert.equal(resolved51.edition, "Windows PowerShell 5.1");
  });

  it("states the edition on the pwsh tool's line", async () => {
    // `shellFor` falls back from PowerShell 7 to Windows PowerShell 5.1, and
    // the two are not one language: the line the model reads has to name the
    // one this host resolved.
    for (const [kind, edition] of [
      ["pwsh", "PowerShell 7"],
      ["powershell", "Windows PowerShell 5.1"],
    ] as const) {
      const root = await powershellRoot(kind);
      const resolved = shellFor("win32", {
        ProgramFiles: kind === "pwsh" ? root : "/nonexistent",
        PATH: "",
        SystemRoot: kind === "powershell" ? root : "/nonexistent",
      });
      const tool = new FileToolGroup(servicesFor(root), resolved).tools().find((spec) => spec.name === "pwsh");
      assert.ok(tool?.description.includes(edition), `${kind}: ${tool?.description}`);
      assert.ok(!tool?.description.includes("{edition}"), "the placeholder is filled");
    }
  });
});

describe("the shell tool on this host", () => {
  it("runs a short command in the workspace", async () => {
    const root = await tempDir();
    const shell = shellFor();
    const group = new FileToolGroup(servicesFor(root), shell);
    // A file the command creates proves the working directory without
    // comparing path strings: Windows reports a short (8.3) temp path from
    // Get-Location while mkdtemp returns the long one.
    const marker = "cwd-marker.txt";
    const command = process.platform === "win32"
      ? `Set-Content -Path '${marker}' -Value hello; Get-Content '${marker}'`
      : `printf hello > '${marker}'; cat '${marker}'`;
    const result = await call(group, shell.run, { command });
    assert.equal(result.ok, true, result.content);
    assert.ok(result.content.includes("hello"));
    const created = await stat(join(root, marker)).catch(() => undefined);
    assert.ok(created?.isFile() === true, "the command runs in the window's directory");
  });

  it("follows a long command with the output tool and stops it", async () => {
    const root = await tempDir();
    const shell = shellFor();
    const group = new FileToolGroup(servicesFor(root), shell);
    const command = process.platform === "win32"
      ? "Write-Output begun; Start-Sleep -Seconds 5; Write-Output done"
      : "echo begun; sleep 5; echo done";
    const started = await call(group, shell.run, { command, timeout: 300 });
    assert.equal(started.ok, true, started.content);
    const job = /b\d+/.exec(started.content)?.[0] ?? "";
    assert.notEqual(job, "", `the result names a job: ${started.content}`);
    const running = await call(group, shell.output, { job });
    assert.equal(running.ok, true, running.content);
    assert.ok(running.content.includes("begun"));
    const stopped = await call(group, shell.stop, { job });
    assert.ok(stopped.ok);
    const missing = await call(group, shell.output, { job: "b999" });
    assert.equal(missing.ok, false);
    assert.equal(missing.error?.rule, `${shell.run}.job.not_found`);
  });

  it("never signals a job that already ended", async () => {
    const root = await tempDir();
    const shell = shellFor();
    // The one signal a stop sends is recorded instead of sent: a job that has
    // ended must not reach its pid, which may belong to another process by now.
    const signalled: number[] = [];
    const recording = {
      ...shell,
      terminate: (pid: number): void => {
        signalled.push(pid);
      },
    };
    const group = new FileToolGroup(servicesFor(root), recording);
    // A group's first job is b1, and a command that ends inside the wait
    // window leaves it done.
    const done = await call(group, recording.run, {
      command: process.platform === "win32" ? "Write-Output done" : "echo done",
    });
    assert.equal(done.ok, true, done.content);
    const stopped = await call(group, recording.stop, { job: "b1" });
    assert.ok(stopped.ok);
    assert.deepEqual(signalled, [], "a finished job is not signalled");
  });

  it("ends the command and the grandchild it started", { skip: process.platform === "win32" }, async () => {
    const root = await tempDir();
    const shell = shellFor();
    const group = new FileToolGroup(servicesFor(root), shell);
    // The grandchild inherits the job's stdio pipes and sleeps far past the
    // stop. Ending only the shell leaves it holding the pipes, so `close`
    // never fires and the job reads as running for ever.
    const started = await call(group, shell.run, {
      command: "sleep 60 & echo $! > gc.pid; echo begun; sleep 60",
      timeout: 500,
    });
    const job = /b\d+/.exec(started.content)?.[0] ?? "";
    assert.notEqual(job, "", `the result names a job: ${started.content}`);
    try {
      const grandchild = await recordedPid(root);
      const stopped = await call(group, shell.stop, { job });
      assert.ok(stopped.ok);
      // The job closes, which it can only do once nothing in the tree holds
      // the pipes, so the output tool reports it stopped rather than running.
      const closed = await until(async () => {
        const result = await call(group, shell.output, { job });
        return result.content.includes("已停止") ? result : undefined;
      });
      assert.ok(closed.content.includes("已停止"), `the job closed: ${closed.content}`);
      // And the grandchild itself is gone, not left running unattached.
      await until(() => (gone(grandchild) ? true : undefined));
    } finally {
      if (job !== "") await call(group, shell.stop, { job });
    }
  });

  it("ends the grandchild it started on Windows", { skip: process.platform !== "win32" }, async () => {
    const root = await tempDir();
    const shell = shellFor();
    const group = new FileToolGroup(servicesFor(root), shell);
    // Start-Process a child that sleeps far past the stop. With -NoNewWindow
    // it inherits the job's stdio pipes, so the job only closes once the whole
    // tree is ended, not just pwsh.
    const command = [
      "$self = (Get-Process -Id $PID).Path",
      "$child = Start-Process -FilePath $self -ArgumentList '-NoProfile','-NonInteractive','-Command','Start-Sleep -Seconds 60' -NoNewWindow -PassThru",
      "Set-Content -Path 'gc.pid' -Value $child.Id",
      "Write-Output begun",
      "Start-Sleep -Seconds 60",
    ].join("; ");
    const started = await call(group, shell.run, { command, timeout: 2000 });
    const job = /b\d+/.exec(started.content)?.[0] ?? "";
    assert.notEqual(job, "", `the result names a job: ${started.content}`);
    try {
      const grandchild = await recordedPid(root);
      const stopped = await call(group, shell.stop, { job });
      assert.ok(stopped.ok);
      const closed = await until(async () => {
        const result = await call(group, shell.output, { job });
        return result.content.includes("已停止") ? result : undefined;
      });
      assert.ok(closed.content.includes("已停止"), `the job closed: ${closed.content}`);
      await until(() => (gone(grandchild) ? true : undefined), 15000);
    } finally {
      if (job !== "") await call(group, shell.stop, { job });
    }
  });
});
