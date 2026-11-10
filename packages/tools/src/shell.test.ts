/**
 * The shell tool on the host it runs on: `/bin/sh -c` on POSIX, PowerShell on
 * Windows.
 *
 * The pure half checks the Windows resolution on any host; the live half runs
 * the tool the host actually gives the model - `bash` on POSIX, `pwsh` on
 * Windows - through the same quick command and background-job path the catalog
 * uses. The Windows CI job runs this file alone, because the rest of this
 * package's tests use POSIX commands by design.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

    const posix = shellFor("linux");
    assert.equal(posix.run, "bash");
    assert.equal(posix.executable, "/bin/sh");
    assert.deepEqual(posix.args("echo hello"), ["-c", "echo hello"]);
  });

  it("names the Windows tool in the table", () => {
    for (const key of ["tool.pwsh", "tool.pwsh_output", "tool.pwsh_stop"]) {
      assert.equal(typeof zhTextTable[key], "string", `${key} has a description`);
    }
    assert.ok(zhTextTable["tool.pwsh"]?.includes("PowerShell"));
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
});
