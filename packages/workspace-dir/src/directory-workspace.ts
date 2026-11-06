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
 * A fork and a snapshot are copies in an implementation that has no metadata to
 * lean on, so this one takes neither: a window's directory is its own, and a
 * continuation works in the directory of the window it continues, in place.
 * Read-only views are the one thing a plain directory cannot enforce on its
 * own, so this implementation offers none.
 */

import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, resolve, sep } from "node:path";
import { arborError } from "@arbor/errors";
import type { WindowRef, Workspace, WorkspaceMount, WorkspaceQuota, WorkspaceRef } from "@arbor/interfaces";

export interface DirectoryWorkspaceOptions {
  /** The root every workspace lives under. */
  root: string;
}

export class DirectoryWorkspace implements Workspace {
  private readonly root: string;

  constructor(options: DirectoryWorkspaceOptions) {
    this.root = options.root;
  }

  async create(window: WindowRef): Promise<WorkspaceRef> {
    const ref = await this.allocate(window);
    await mkdir(this.workspacePath(ref), { recursive: true });
    return ref;
  }

  async mount(ref: WorkspaceRef): Promise<WorkspaceMount> {
    const resolved = await this.resolve(ref);
    return {
      ref,
      path: resolved,
      readFile: async (path: string) => {
        const target = this.inside(resolved, path);
        if (target === undefined) return null;
        return readFile(target, "utf8").catch(() => null);
      },
      writeFile: async (path: string, text: string) => {
        const target = this.inside(resolved, path);
        if (target === undefined) {
          throw arborError({
            code: "refused",
            rule: "file.outside_workspace",
            message: `workspace: ${path} 在目录之外`,
            nextAction: "改用目录内的相对路径。",
          });
        }
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

  /** The directory a window works in, for the file tools. */
  pathOf(ref: WorkspaceRef): string {
    return this.workspacePath(ref);
  }

  /** A path inside a directory, or `undefined` when it escapes it. */
  private inside(root: string, path: string): string | undefined {
    if (path === "") return undefined;
    const wanted = isAbsolute(path) ? normalize(path) : resolve(root, path);
    return wanted === root || wanted.startsWith(root + sep) ? wanted : undefined;
  }

  private workspacePath(ref: WorkspaceRef): string {
    return join(this.root, ref);
  }

  /** The next workspace number, from the directories that already exist. */
  private async allocate(window: WindowRef): Promise<WorkspaceRef> {
    const wanted = windowNumber(window);
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

function windowNumber(window: WindowRef): number {
  return Number(/^c(\d+)$/.exec(window)?.[1] ?? 0);
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
