/**
 * The window's workspace: `bash`, `bash_output`, `bash_stop`, `read`, `write`
 * and `edit` (docs/tools.md#direct-tools, docs/workspaces.md).
 *
 * A plain command is a direct call, a chain is a script. One behaviour per
 * tool: a command that outlives `bash`'s wait window is followed with
 * `bash_output` and stopped with `bash_stop`.
 *
 * Everything reaches the workspace through the `Workspace` interface, never the
 * host filesystem directly: a capability the implementation owns - `exec`,
 * `readFile`, `writeFile` - is used when it is present, and the host path in
 * `mount.path` when it is not. An implementation that owns its execution
 * environment has a `path` that is not a host path and an `exec` that is the
 * only way to run a command there; a plain-directory workspace owns no
 * execution environment, so the caller runs the command itself. Either way a
 * command that outlives `bash`'s wait window is followed with `bash_output` and
 * stopped with `bash_stop`, through the host's own process path.
 */

import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, resolve, sep } from "node:path";
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
} from "@arbor/interfaces";
import { textOf } from "@arbor/prompt";
import { boundResult } from "../bound.ts";
import { envCommand } from "../env-stage.ts";
import { toolSpec } from "../host.ts";

/** How long `bash` waits before it hands the command to `bash_output`. */
const BASH_WAIT_MS = 20000;

/** How much one background job keeps in memory. */
const JOB_BUFFER = 200000;

interface Job {
  id: string;
  output: string;
  done: boolean;
  code: number | null;
  stop(): void;
}

export class FileToolGroup implements ToolGroup {
  readonly id = "files";

  private readonly services: import("../host.ts").ToolServices;
  private readonly jobs = new Map<string, Job>();
  private nextJob = 1;

  constructor(services: import("../host.ts").ToolServices) {
    this.services = services;
  }

  tools(): readonly DirectToolSpec[] {
    const table = this.services.table;
    return [
      toolSpec(table, "bash", {
        command: { type: "string", required: true },
        timeout: { type: "number" },
      }),
      toolSpec(table, "bash_output", { job: { type: "string", required: true } }),
      toolSpec(table, "bash_stop", { job: { type: "string", required: true } }),
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
      case "bash":
        return this.bash(request, context.window, context);
      case "bash_output":
        return this.bashOutput(request);
      case "bash_stop":
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
    const job = this.start(command, workspace.path);
    await sleep(numberArg(request.args, "timeout", BASH_WAIT_MS));
    return {
      callId: request.callId,
      ok: job.done ? job.code === 0 : true,
      content: `${job.output}\n${textOf(table, "result.bash.started", { job: job.id })}`,
    };
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
      : `${job.output}\n${textOf(table, "result.bash.running", { job: id })}`;
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
    const body = await boundResult(lines.slice(offset, offset + limit).join("\n"), {
      workspace: workspace?.path ?? path,
      callId: request.callId,
      table,
    });
    return {
      callId: request.callId,
      ok: true,
      content: `${textOf(table, "result.read.file", { path, lines: lines.length })}\n${body}`,
    };
  }

  private async write(request: ToolCall, window: WindowRef): Promise<ToolResult> {
    const table = this.services.table;
    const path = stringArg(request.args, "path");
    if (this.envPath(path) !== undefined) return this.readonly(request, path);
    const workspace = await this.mount(window);
    if (workspace === undefined) return this.absent(request);
    const text = stringArg(request.args, "text");
    const written = await this.writeText(workspace, path, text);
    if (written === false) return this.outside(request, path);
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
    const written = await this.writeText(workspace, path, text.split(old).join(next));
    if (written === false) return this.outside(request, path);
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
    const target = insidePath(workspace.path, path);
    if (target === undefined) return null;
    return readFile(target, "utf8").catch(() => null);
  }

  /** Write one file, or answer `false` when the path escapes the workspace. */
  private async writeText(workspace: WorkspaceMount, path: string, text: string): Promise<boolean> {
    if (workspace.writeFile !== undefined) {
      try {
        await workspace.writeFile(path, text);
        return true;
      } catch (error: unknown) {
        const rule = (error as { rule?: string }).rule;
        if (rule === "file.outside_workspace") return false;
        throw error;
      }
    }
    const target = insidePath(workspace.path, path);
    if (target === undefined) return false;
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, text, "utf8");
    return true;
  }

  private start(command: string, cwd: string): Job {
    const id = `b${this.nextJob}`;
    this.nextJob += 1;
    const child = spawn("/bin/sh", ["-c", command], { cwd });
    let output = "";
    const append = (chunk: Buffer): void => {
      output = (output + chunk.toString("utf8")).slice(-JOB_BUFFER);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const job: Job = {
      id,
      output: "",
      done: false,
      code: null,
      stop: () => {
        child.kill("SIGTERM");
      },
    };
    child.on("close", (code) => {
      job.done = true;
      job.code = code;
      job.output = output;
    });
    child.on("error", (error: Error) => {
      job.done = true;
      job.code = 1;
      job.output = output + error.message;
    });
    this.jobs.set(id, job);
    return job;
  }

  private absent(request: ToolCall): ToolResult {
    return this.refusal(request, "workspace.absent", "result.no_workspace", {});
  }

  private jobMissing(request: ToolCall, id: string): ToolResult {
    return this.refusal(request, "bash.job.not_found", "bash.notfound", { job: id });
  }

  private missing(request: ToolCall, key: string, path: string): ToolResult {
    return this.refusal(request, key === "read.missing" ? "file.not_found" : "file.not_found", key, { path });
  }

  private noMatch(request: ToolCall, path: string, old: string): ToolResult {
    return this.refusal(request, "edit.no_match", "edit.nomatch", { path, old });
  }

  private outside(request: ToolCall, path: string): ToolResult {
    return this.refusal(request, "file.outside_workspace", "read.outside", { path });
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

/** A path inside the workspace, or `undefined` when it escapes it. */
function insidePath(root: string, path: string): string | undefined {
  if (path === "") return undefined;
  const wanted = isAbsolute(path) ? normalize(path) : resolve(root, path);
  return wanted === root || wanted.startsWith(root + sep) ? wanted : undefined;
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
