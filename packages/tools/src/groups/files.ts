/**
 * The window's workspace: `bash`, `bash_output`, `bash_stop`, `read`, `write`
 * and `edit` (docs/tools.md#direct-tools, docs/workspaces.md).
 *
 * The shell tool is named for the shell the host gives it: `bash` on POSIX,
 * `pwsh` on Windows, with `pwsh_output` and `pwsh_stop` beside it. Everything
 * else about it is one behaviour, so the wait window, the background job and
 * the result cut do not fork by platform.
 *
 * A plain command is a direct call, a chain is a script. One behaviour per
 * tool: a command that outlives the shell tool's wait window is followed with
 * its output tool and stopped with its stop tool.
 *
 * Everything reaches the workspace through the `Workspace` interface, never the
 * host filesystem directly: a capability the implementation owns - `exec`,
 * `readFile`, `writeFile` - is used when it is present, and the host path in
 * `mount.path` when it is not. An implementation that owns its execution
 * environment has a `path` that is not a host path and an `exec` that is the
 * only way to run a command there; a plain-directory workspace owns no
 * execution environment, so the caller runs the command itself. Either way a
 * command that outlives the shell tool's wait window is followed with its
 * output tool and stopped with its stop tool, through the host's own process
 * path.
 */

import { spawn } from "node:child_process";
import { lstatSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";
import type {
  CallContext,
  DirectToolSpec,
  ExecResult,
  TextTable,
  ToolCall,
  ToolGroup,
  ToolResult,
  WindowRef,
  WorkspaceMount,
} from "@4fu/arbor-interfaces";
import { textOf } from "@4fu/arbor-prompt";
import { childEnvironment } from "../child-env.ts";
import { envCommand } from "../env-stage.ts";
import { toolSpec } from "../host.ts";

/** How long `bash` waits before it hands the command to `bash_output`. */
const BASH_WAIT_MS = 20000;

/** How much one background job keeps in memory. */
const JOB_BUFFER = 200000;

/**
 * PowerShell's argv preamble for one command.
 *
 * Windows PowerShell 5.1 writes its redirected output in the console code page,
 * which is not UTF-8; pwsh 7 already defaults to UTF-8. Setting both encodings
 * on the first line makes what Node reads back the same on either executable,
 * and the separators keep PowerShell's error line numbers accurate. This is the
 * same preamble `@deepseek-ai/dsh-pwsh-local` writes for DSH's own `pwsh` tool.
 */
const POWERSHELL_PREAMBLE =
  "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); "
  + "$OutputEncoding = [System.Text.UTF8Encoding]::new($false); ";

/**
 * The shell a window's command runs in: `/bin/sh -c` on POSIX, PowerShell on
 * Windows.
 *
 * The tool has to be named for the shell the model actually gets. A Windows
 * window sees `pwsh` / `pwsh_output` / `pwsh_stop`, the same names DSH's own
 * preset gives its Windows shell tool, and a POSIX window keeps `bash` /
 * `bash_output` / `bash_stop`. Everything else about the tool - the wait window,
 * the background job, the output cut, the environment and the secret scrub - is
 * one behaviour and stays in this file.
 */
export interface Shell {
  /** The direct tool that runs one command. */
  readonly run: string;
  /** The direct tool that reads a background job's new output. */
  readonly output: string;
  /** The direct tool that stops a background job. */
  readonly stop: string;
  /** The executable to spawn. */
  readonly executable: string;
  /** The argv after the executable, for one command. */
  args(command: string): readonly string[];
}

/**
 * The PowerShell executable a Windows command runs through.
 *
 * The order is the one DSH's own `pwsh` tool resolves: the PowerShell 7 install
 * first, then a `pwsh.exe` on PATH (a Microsoft Store install), then Windows
 * PowerShell 5.1. `pwsh` is the last answer so a PATH entry Node can resolve but
 * `lstat` cannot still gets a chance. `lstat` sees a Store execution alias where
 * `stat` hits the target's ACL, which is why it is the probe DSH uses too.
 */
function powershellExecutable(env: NodeJS.ProcessEnv): string {
  const programFiles = env["ProgramFiles"] ?? "C:\\Program Files";
  const systemRoot = env["SystemRoot"] ?? "C:\\Windows";
  const candidates = [join(programFiles, "PowerShell", "7", "pwsh.exe")];
  for (const entry of (env["PATH"] ?? "").split(";")) {
    const trimmed = entry.trim().replace(/^"|"$/g, "");
    if (trimmed !== "") candidates.push(join(trimmed, "pwsh.exe"));
  }
  candidates.push(join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"));
  for (const candidate of candidates) {
    try {
      const stat = lstatSync(candidate);
      if (stat.isFile() || stat.isSymbolicLink()) return candidate;
    } catch {
      // Not this candidate; try the next one.
    }
  }
  return "pwsh";
}

/**
 * The shell for one host platform.
 *
 * `platform` and `env` are parameters so the Windows resolution is a pure
 * function of its inputs and can be tested on a POSIX host.
 */
export function shellFor(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): Shell {
  if (platform !== "win32") {
    return {
      run: "bash",
      output: "bash_output",
      stop: "bash_stop",
      executable: "/bin/sh",
      args: (command) => ["-c", command],
    };
  }
  return {
    run: "pwsh",
    output: "pwsh_output",
    stop: "pwsh_stop",
    executable: powershellExecutable(env),
    args: (command) => [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `${POWERSHELL_PREAMBLE}${command}`,
    ],
  };
}

/**
 * The environment one command runs with: the host's environment, the window's
 * own directory, and the extra environment the workspace
 * implementation asks for. This is the one place a command's environment is
 * built, so everything a deployment adds to it is added here
 * (docs/environment.md#what-a-subprocess-gets).
 */
export function bashEnvironment(cwd: string, extraEnv?: Record<string, string>): Record<string, string> {
  return childEnvironment({ workspace: cwd, env: extraEnv });
}

interface Job {
  id: string;
  output: string;
  done: boolean;
  code: number | null;
  /** Settles when the command has ended. */
  ended: Promise<void>;
  stop(): void;
}

export class FileToolGroup implements ToolGroup {
  readonly id = "files";

  private readonly services: import("../host.ts").ToolServices;
  private readonly shell: Shell;
  private readonly jobs = new Map<string, Job>();
  private nextJob = 1;

  constructor(services: import("../host.ts").ToolServices, shell: Shell = shellFor()) {
    this.services = services;
    this.shell = shell;
  }

  tools(): readonly DirectToolSpec[] {
    const table = this.services.table;
    return [
      toolSpec(table, this.shell.run, {
        command: { type: "string", required: true },
        timeout: { type: "number" },
      }),
      toolSpec(table, this.shell.output, { job: { type: "string", required: true } }),
      toolSpec(table, this.shell.stop, { job: { type: "string", required: true } }),
      toolSpec(table, "read", {
        path: { type: "string", required: true },
        offset: { type: "number" },
        limit: { type: "number" },
      }),
      toolSpec(table, "write", {
        path: { type: "string", required: true },
        text: { type: "string", required: true },
      }),
      toolSpec(table, "edit", {
        path: { type: "string", required: true },
        old: { type: "string", required: true },
        new: { type: "string", required: true },
      }),
    ];
  }

  modules(): readonly [] {
    return [];
  }

  async call(request: ToolCall, context: CallContext): Promise<ToolResult> {
    switch (request.name) {
      case this.shell.run:
        return this.bash(request, context.window, context);
      case this.shell.output:
        return this.bashOutput(request);
      case this.shell.stop:
        return this.bashStop(request);
      case "read":
        return this.read(request, context.window);
      case "write":
        return this.write(request, context.window);
      case "edit":
        return this.edit(request, context.window);
      default:
        return this.notOwned(request);
    }
  }

  /** The window's own directory, created on first use. */
  private async mount(window: WindowRef): Promise<WorkspaceMount | undefined> {
    return this.services.ensureWorkspace(window);
  }

  /**
   * The environment, at the path a window reads it at. It is mounted read-only,
   * so a window without a workspace still reads `/env/skills/<name>/SKILL.md`
   * (docs/environment.md#layout), and a write to it is refused.
   */
  private envPath(path: string): string | undefined {
    const env = this.services.envPaths();
    if (env === undefined) return undefined;
    if (path !== env.prefix && !path.startsWith(`${env.prefix}/`)) return undefined;
    const inside = path === env.prefix ? "" : path.slice(env.prefix.length + 1);
    return inside === "" ? env.directory : join(env.directory, inside);
  }

  /** Record which revision of an item a window read, for `reload`'s check. */
  private async noteEnvRead(window: WindowRef, path: string): Promise<void> {
    const prefix = this.services.envPaths()?.prefix;
    if (prefix === undefined || (path !== prefix && !path.startsWith(`${prefix}/`))) return;
    const item = await this.services.envItemAt(path);
    if (item !== undefined) this.services.envRead(window, item);
  }

  private async bash(request: ToolCall, window: WindowRef, context: CallContext): Promise<ToolResult> {
    const table = this.services.table;
    const workspace = await this.mount(window);
    if (workspace === undefined) return this.absent(request);
    const command = await envCommand(
      workspace,
      stringArg(request.args, "command"),
      this.services.envPaths(),
      context.envRevision,
    );
    if (workspace.exec !== undefined) {
      // The implementation owns the execution environment, so the command runs
      // there and `path` is not a host path.
      return this.ran(request, await runToEnd(workspace.exec, command));
    }
    const job = this.start(command, workspace.path, this.services.workspace?.bashEnv?.(window));
    const wait = numberArg(request.args, "timeout", BASH_WAIT_MS);
    await Promise.race([job.ended, sleep(wait)]);
    // A command that ran to its end inside the wait window is answered with
    // what it wrote; one that outlived it becomes a background job, and the
    // result line says the window is not woken when it ends.
    const content = job.done
      ? job.output
      : `${job.output}\n${textOf(table, "result.bash.started", { job: job.id, ms: wait, output: this.shell.output, stop: this.shell.stop })}`;
    return { callId: request.callId, ok: job.done ? job.code === 0 : true, content };
  }

  /** One command that ran to its end: what it wrote, and whether it succeeded. */
  private ran(request: ToolCall, outcome: ExecResult): ToolResult {
    const body = [outcome.stdout, outcome.stderr].filter((part) => part !== "").join("\n");
    return { callId: request.callId, ok: outcome.exitCode === 0, content: body };
  }

  private async bashOutput(request: ToolCall): Promise<ToolResult> {
    const table = this.services.table;
    const id = stringArg(request.args, "job");
    const job = this.jobs.get(id);
    if (job === undefined) return this.jobMissing(request, id);
    const content = job.done
      ? `${job.output}\n${textOf(table, "result.bash.stopped", { job: id })}`
      : `${job.output}\n${textOf(table, "result.bash.running", { job: id, output: this.shell.output })}`;
    return { callId: request.callId, ok: job.done ? job.code === 0 : true, content };
  }

  private async bashStop(request: ToolCall): Promise<ToolResult> {
    const table = this.services.table;
    const id = stringArg(request.args, "job");
    const job = this.jobs.get(id);
    if (job === undefined) return this.jobMissing(request, id);
    job.stop();
    return {
      callId: request.callId,
      ok: true,
      content: `${job.output}\n${textOf(table, "result.bash.stopped", { job: id })}`,
    };
  }

  private async read(request: ToolCall, window: WindowRef): Promise<ToolResult> {
    const table = this.services.table;
    const path = stringArg(request.args, "path");
    // The environment is read where a window sees it, without a workspace.
    const env = this.envPath(path);
    const workspace = env === undefined ? await this.mount(window) : undefined;
    if (env === undefined && workspace === undefined) return this.absent(request);
    const text =
      env === undefined
        ? await this.readText(workspace as WorkspaceMount, path)
        : await readFile(env, "utf8").catch(() => null);
    if (text === null) return this.missing(request, "read.missing", path);
    if (env !== undefined) await this.noteEnvRead(window, path);
    const lines = text.split("\n");
    const offset = Math.max(0, numberArg(request.args, "offset", 0));
    const limit = Math.min(500, Math.max(1, numberArg(request.args, "limit", 400)));
    // The page is bounded once, at the one exit every call leaves by, so this
    // tool cuts nothing of its own.
    return {
      callId: request.callId,
      ok: true,
      content: `${textOf(table, "result.read.file", { path, lines: lines.length })}\n${lines.slice(offset, offset + limit).join("\n")}`,
    };
  }

  private async write(request: ToolCall, window: WindowRef): Promise<ToolResult> {
    const table = this.services.table;
    const path = stringArg(request.args, "path");
    if (this.envPath(path) !== undefined) return this.readonly(request, path);
    const workspace = await this.mount(window);
    if (workspace === undefined) return this.absent(request);
    const text = stringArg(request.args, "text");
    await this.writeText(workspace, path, text);
    return {
      callId: request.callId,
      ok: true,
      content: textOf(table, "result.write.file", { path, bytes: Buffer.byteLength(text) }),
    };
  }

  private async edit(request: ToolCall, window: WindowRef): Promise<ToolResult> {
    const table = this.services.table;
    const path = stringArg(request.args, "path");
    if (this.envPath(path) !== undefined) return this.readonly(request, path);
    const workspace = await this.mount(window);
    if (workspace === undefined) return this.absent(request);
    const old = stringArg(request.args, "old");
    const next = stringArg(request.args, "new");
    const text = await this.readText(workspace, path);
    if (text === null) return this.missing(request, "edit.missing", path);
    const count = text.split(old).length - 1;
    if (count === 0) return this.noMatch(request, path, old);
    await this.writeText(workspace, path, text.split(old).join(next));
    return {
      callId: request.callId,
      ok: true,
      content: textOf(table, "result.edit.file", { path, replacements: count }),
    };
  }

  /**
   * One file's text: the mount's own capability when it has one, the host path
   * when it does not. `null` means the file is not there.
   */
  private async readText(workspace: WorkspaceMount, path: string): Promise<string | null> {
    if (workspace.readFile !== undefined) return workspace.readFile(path);
    return readFile(hostPath(workspace.path, path), "utf8").catch(() => null);
  }

  /** Write one file, creating its directory. */
  private async writeText(workspace: WorkspaceMount, path: string, text: string): Promise<void> {
    if (workspace.writeFile !== undefined) {
      await workspace.writeFile(path, text);
      return;
    }
    const target = hostPath(workspace.path, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, text, "utf8");
  }

  private start(command: string, cwd: string, extraEnv?: Record<string, string>): Job {
    const id = `b${this.nextJob}`;
    this.nextJob += 1;
    // The one place a command's environment is built: the host's environment,
    // the window's own directory, and the extra environment the workspace
    // implementation asks for - the ovnfs workspace's `ARBOR_WINDOW` and git
    // hook path. The extra variables reach no MCP server and no service
    // (docs/environment.md#what-a-subprocess-gets).
    const child = spawn(this.shell.executable, this.shell.args(command), { cwd, env: bashEnvironment(cwd, extraEnv) });
    let end = (): void => {};
    const job: Job = {
      id,
      output: "",
      done: false,
      code: null,
      ended: new Promise((resolve) => {
        end = resolve;
      }),
      stop: () => {
        child.kill("SIGTERM");
      },
    };
    // Output lands on the job as it is written, so a running job's output can
    // be read before it ends.
    const append = (chunk: Buffer): void => {
      job.output = (job.output + chunk.toString("utf8")).slice(-JOB_BUFFER);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("close", (code) => {
      job.done = true;
      job.code = code;
      end();
    });
    child.on("error", (error: Error) => {
      job.done = true;
      job.code = 1;
      job.output += error.message;
      end();
    });
    this.jobs.set(id, job);
    return job;
  }

  private absent(request: ToolCall): ToolResult {
    return this.refusal(request, "workspace.absent", "result.no_workspace", {});
  }

  private jobMissing(request: ToolCall, id: string): ToolResult {
    return this.refusal(request, `${this.shell.run}.job.not_found`, "bash.notfound", {
      job: id,
      run: this.shell.run,
      output: this.shell.output,
    });
  }

  private missing(request: ToolCall, key: string, path: string): ToolResult {
    return this.refusal(request, key === "read.missing" ? "file.not_found" : "file.not_found", key, { path });
  }

  private noMatch(request: ToolCall, path: string, old: string): ToolResult {
    return this.refusal(request, "edit.no_match", "edit.nomatch", { path, old });
  }

  /** The environment is mounted read-only, so nothing there is written. */
  private readonly(request: ToolCall, path: string): ToolResult {
    return this.refusal(request, "env.readonly_path", "env.readonly_path", { path });
  }

  private refusal(
    request: ToolCall,
    rule: string,
    key: string,
    args: Record<string, string | number>,
  ): ToolResult {
    const table: TextTable = this.services.table;
    return {
      callId: request.callId,
      ok: false,
      content: "",
      error: {
        rule,
        message: textOf(table, `refused.${key}`, args, key),
        nextAction: textOf(table, `next.${key}`, args) || undefined,
      },
    };
  }

  private notOwned(request: ToolCall): ToolResult {
    return this.refusal(request, "tool.not_owned", "unknown_tool", { name: request.name });
  }
}

/**
 * Where a path names on this host: itself when it is absolute, under the
 * workspace when it is not. Nothing is refused, because the owner asked for no
 * restriction on where a window reads or writes
 * (docs/workspaces.md#another-windows-directory).
 */
function hostPath(root: string, path: string): string {
  return isAbsolute(path) ? normalize(path) : resolve(root, path);
}

/**
 * One command to its end in a mount that owns its execution environment, or
 * the failure it was answered with - so a command the implementation could not
 * run at all is reported the way one that ran and failed is.
 */
function runToEnd(exec: (command: string) => Promise<ExecResult>, command: string): Promise<ExecResult> {
  return exec(command).catch((error: unknown) => ({
    exitCode: 1,
    stdout: "",
    stderr: error instanceof Error ? error.message : String(error),
    truncated: false,
  }));
}

function stringArg(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  return typeof value === "string" ? value : "";
}

function numberArg(args: Record<string, unknown>, name: string, fallback: number): number {
  const value = args[name];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
