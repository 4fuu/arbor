/**
 * The plain-directory `Workspace` (docs/workspaces.md).
 *
 * A workspace is a plain directory, not bound to any repository: the framework
 * gives isolation and continuity, and the agent does the rest. This
 * implementation keeps every window's directory under one root:
 *
 * ```text
 * <root>/ws3/                    the window's own directory
 * ```
 *
 * A new window gets a directory of its own, created on first use. A
 * continuation works in its predecessor's directory in place, under the same
 * ref: no copy, no link, no fork. Only one window in a chain is live at a time,
 * so in place is safe, and the chain is in the journal, so a restart recovers
 * which directory a continuation uses.
 *
 * It isolates by directory only. Another window's directory is a path on this
 * host, which a command may name and `read`, `write` and `edit` may open and
 * change; nothing here refuses a path outside the window's own directory, and
 * nothing here stops `bash`. What keeps one window out of another's directory
 * is the prompt text `workspace.path` answers with, not a rule this
 * implementation enforces. That is not a security boundary, and the docs say
 * so: real isolation comes from an implementation that owns its execution
 * environment.
 */

import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";
import { arborError } from "@4fu/arbor-errors";
import type {
  PromptSection,
  TextTable,
  ToolGroup,
  WindowRef,
  Workspace,
  WorkspaceMount,
  WorkspaceQuota,
  WorkspaceRef,
} from "@4fu/arbor-interfaces";
import { WorkspacePathGroup } from "./path-module.ts";
import { directorySection } from "./section.ts";

export interface DirectoryWorkspaceOptions {
  /** The root every workspace lives under. */
  root: string;
}

export class DirectoryWorkspace implements Workspace {
  private readonly root: string;

  constructor(options: DirectoryWorkspaceOptions) {
    this.root = options.root;
  }

  /**
   * The directory a window works in, created on first use. Idempotent: the
   * window that already has one gets the same ref back, which is how a
   * continuation - which asks for the window that opened its chain - lands in
   * its predecessor's directory, in place, under the same ref.
   */
  async create(window: WindowRef): Promise<WorkspaceRef> {
    const ref = await this.allocate(window);
    await mkdir(this.workspacePath(ref), { recursive: true });
    return ref;
  }

  /**
   * The directory a window's workspace has, or `undefined` when the window
   * never touched files. Another window's directory is a path on this host,
   * which is what a window reads it by.
   */
  async pathOfWindow(window: WindowRef): Promise<string | undefined> {
    const ref = await this.refOf(window);
    return ref === undefined ? undefined : this.workspacePath(ref);
  }

  async mount(ref: WorkspaceRef): Promise<WorkspaceMount> {
    const resolved = await this.resolve(ref);
    return {
      ref,
      path: resolved,
      readFile: async (path: string) => {
        // A relative path is inside this workspace. An absolute one is read
        // where it is on this host, which is how another window's directory is
        // read (docs/workspaces.md).
        return readFile(hostPath(resolved, path), "utf8").catch(() => null);
      },
      writeFile: async (path: string, text: string) => {
        // Nothing is refused: a relative path is this workspace's own, an
        // absolute one is written where it names on this host
        // (docs/workspaces.md#another-windows-directory).
        const target = hostPath(resolved, path);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, text, "utf8");
      },
      release: async () => {},
    };
  }

  async quota(workspace: WorkspaceRef): Promise<WorkspaceQuota> {
    const resolved = await this.resolve(workspace);
    const files = await listFiles(resolved);
    let bytes = 0;
    for (const size of files.values()) bytes += size;
    return { bytes, used: bytes, files: files.size };
  }

  async reclaim(workspace: WorkspaceRef): Promise<void> {
    await rm(this.workspacePath(workspace), { recursive: true, force: true });
  }

  /**
   * The workspace a window's chain already has, or `undefined` when it has
   * none. The host asks for it to reclaim a chain's directory after the
   * retention period (docs/workspaces.md#lifecycle).
   */
  async refOf(window: WindowRef): Promise<WorkspaceRef | undefined> {
    const wanted = windowNumber(window);
    if (wanted <= 0) return undefined;
    const ref = `ws${wanted}` as WorkspaceRef;
    return (await isDirectory(this.workspacePath(ref))) ? ref : undefined;
  }

  /** The directory a window works in, for the file tools. */
  pathOf(ref: WorkspaceRef): string {
    return this.workspacePath(ref);
  }

  /**
   * What this implementation adds to the catalog: another window's directory,
   * by its window. The core declares no such capability of its own
   * (docs/workspaces.md).
   */
  groups(table: TextTable): readonly ToolGroup[] {
    return [new WorkspacePathGroup(this, table)];
  }

  /**
   * This implementation's own prompt text: work in your own directory in place,
   * and treat another window's directory as read-only by convention. Its own,
   * different from the ovnfs workspace's, so a host never shows the ovnfs method
   * when it fell back here (docs/workspaces.md).
   */
  promptSection(): PromptSection {
    return directorySection();
  }

  private workspacePath(ref: WorkspaceRef): string {
    return join(this.root, ref);
  }

  /**
   * The ref a window's directory has: the one it already has, or the next
   * number nothing has taken. A window's number only grows, so a directory is
   * never handed to a second window.
   */
  private async allocate(window: WindowRef): Promise<WorkspaceRef> {
    const wanted = windowNumber(window);
    const own = wanted > 0 ? (`ws${wanted}` as WorkspaceRef) : undefined;
    if (own !== undefined && (await isDirectory(this.workspacePath(own)))) return own;
    let entries: string[] = [];
    try {
      entries = await readdir(this.root);
    } catch {
      entries = [];
    }
    let highest = 0;
    for (const entry of entries) {
      const number = /^ws(\d+)$/.exec(entry)?.[1];
      if (number === undefined) continue;
      highest = Math.max(highest, Number(number));
    }
    return `ws${Math.max(highest + 1, wanted)}` as WorkspaceRef;
  }

  /** Resolve a ref a model may pass back into a path on this host. */
  private async resolve(ref: WorkspaceRef): Promise<string> {
    if (!/^ws\d+$/.test(ref)) {
      throw arborError({
        code: "not_found",
        rule: "workspace.ref.unknown",
        message: `workspace: ${ref} 不是工作区引用`,
        nextAction: "使用 ws3 形式的引用。",
      });
    }
    const path = this.workspacePath(ref);
    await assertDirectory(path, ref);
    return path;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

function windowNumber(window: WindowRef): number {
  return Number(/^c(\d+)$/.exec(window)?.[1] ?? 0);
}

/**
 * Where a path names on this host: itself when it is absolute, under `root`
 * when it is not. Nothing is refused, because the owner asked for no
 * restriction on where a window reads or writes
 * (docs/workspaces.md#another-windows-directory).
 */
function hostPath(root: string, path: string): string {
  return isAbsolute(path) ? normalize(path) : resolve(root, path);
}

async function assertDirectory(path: string, ref: string): Promise<void> {
  let info;
  try {
    info = await stat(path);
  } catch {
    throw arborError({
      code: "not_found",
      rule: "workspace.not_found",
      message: `workspace: ${ref} 不存在`,
      nextAction: "先用工作区创建它，或换一个存在的引用。",
    });
  }
  if (!info.isDirectory()) {
    throw arborError({
      code: "not_found",
      rule: "workspace.not_directory",
      message: `workspace: ${ref} 不是目录`,
      nextAction: "换一个工作区引用。",
    });
  }
}

/** Every file under a directory, with its size in bytes. */
async function listFiles(root: string): Promise<Map<string, number>> {
  const files = new Map<string, number>();
  const walk = async (directory: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }
      if (!entry.isFile()) continue;
      const info = await stat(path);
      files.set(path.slice(root.length + 1), info.size);
    }
  };
  await walk(root);
  return files;
}
