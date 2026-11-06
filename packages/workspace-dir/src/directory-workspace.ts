/**
 * The plain-directory `Workspace` (docs/workspaces.md).
 *
 * A workspace is a plain directory, not bound to any repository: the framework
 * gives isolation, continuity and snapshots, and the agent does the rest. This
 * implementation keeps every window's directory under one root:
 *
 * ```text
 * <root>/ws3/                    the window's own directory
 * <root>/snapshots/ws3/r902/     the directory's state at one event
 * <root>/snapshots/ws3/latest/   the newest snapshot taken without an event
 * ```
 *
 * A fork and a snapshot are therefore a recursive copy, and a snapshot is
 * taken whole: it is the directory's state at that event, so a later in-place
 * edit by `bash` cannot reach back into it.
 *
 * Read-only views are the one thing a plain directory cannot enforce on its
 * own. A read-only mount returns the snapshot's path with `readOnly` set and
 * drops the write bits, which is the approximation available without a mount.
 */

import { chmod, cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, resolve, sep } from "node:path";
import { arborError } from "@arbor/errors";
import type {
  DiffFile,
  EventRef,
  Page,
  Snapshot,
  SnapshotHandle,
  SnapshotRef,
  WindowRef,
  Workspace,
  WorkspaceDiff,
  WorkspaceMount,
  WorkspaceQuota,
  WorkspaceRef,
} from "@arbor/interfaces";
import { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT } from "@arbor/interfaces";

/** A snapshot taken without naming the event records the newest state. */
const LATEST = "latest";

/** The index that says which event each snapshot was taken at. */
const INDEX = "index.json";

export interface DirectoryWorkspaceOptions {
  /** The root every workspace lives under. */
  root: string;
  /** The clock. Tests pass a fixed one. */
  now?: () => number;
}

interface Resolved {
  workspace: WorkspaceRef;
  path: string;
  /** Set when the ref names a snapshot. */
  snapshot?: string;
  readOnly: boolean;
}

export class DirectoryWorkspace implements Workspace {
  private readonly root: string;
  private readonly clock: () => number;

  constructor(options: DirectoryWorkspaceOptions) {
    this.root = options.root;
    this.clock = options.now ?? (() => Date.now());
  }

  async create(window: WindowRef): Promise<WorkspaceRef> {
    const ref = await this.allocate(window);
    await mkdir(this.workspacePath(ref), { recursive: true });
    return ref;
  }

  async fork(from: WorkspaceRef, window: WindowRef): Promise<WorkspaceRef> {
    const source = await this.resolve(from);
    const ref = await this.allocate(window);
    await cp(source.path, this.workspacePath(ref), { recursive: true });
    return ref;
  }

  async snapshot(workspace: WorkspaceRef, at?: EventRef): Promise<SnapshotHandle> {
    const resolved = await this.resolve(workspace);
    const key = at === undefined ? LATEST : eventKey(at);
    const target = join(this.root, "snapshots", resolved.workspace, key);
    await rm(target, { recursive: true, force: true });
    await mkdir(join(this.root, "snapshots", resolved.workspace), { recursive: true });
    await cp(resolved.path, target, { recursive: true });
    await this.record(resolved.workspace, key, at, this.clock());
    return { ref: `${resolved.workspace}@${key}` as SnapshotRef, id: target };
  }

  async snapshots(
    workspace: WorkspaceRef,
    options?: { limit?: number; offset?: number },
  ): Promise<Page<Snapshot>> {
    const resolved = await this.resolve(workspace);
    const index = await this.readIndex(resolved.workspace);
    const found: Snapshot[] = [];
    for (const [key, entry] of index) {
      if (!(await isDirectory(join(this.root, "snapshots", resolved.workspace, key)))) continue;
      found.push({
        ref: `${resolved.workspace}@${key}` as SnapshotRef,
        event: entry.event as EventRef,
        time: entry.time,
      });
    }
    found.sort(compareSnapshots);
    return page(found, options, "workspace.snapshots");
  }

  async mount(ref: WorkspaceRef | SnapshotRef, options?: { readOnly?: boolean }): Promise<WorkspaceMount> {
    const resolved = await this.resolve(ref);
    const readOnly = options?.readOnly === true || resolved.readOnly;
    if (readOnly) await freeze(resolved.path);
    return {
      ref,
      path: resolved.path,
      readOnly,
      readFile: async (path: string) => {
        const target = this.inside(resolved.path, path);
        if (target === undefined) return null;
        return readFile(target, "utf8").catch(() => null);
      },
      writeFile: async (path: string, text: string) => {
        const target = this.inside(resolved.path, path);
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
      release: async () => {
        if (readOnly) await thaw(resolved.path);
      },
    };
  }

  async diff(from: WorkspaceRef | SnapshotRef, to: WorkspaceRef | SnapshotRef): Promise<WorkspaceDiff> {
    const left = await this.resolve(from);
    const right = await this.resolve(to);
    const leftFiles = await listFiles(left.path);
    const rightFiles = await listFiles(right.path);
    const files: DiffFile[] = [];
    for (const path of [...leftFiles.keys()].sort()) {
      const rightSize = rightFiles.get(path);
      if (rightSize === undefined) {
        files.push({ path, status: "removed" });
        continue;
      }
      const leftSize = leftFiles.get(path) ?? 0;
      if (leftSize !== rightSize) files.push({ path, status: "changed" });
    }
    for (const path of [...rightFiles.keys()].sort()) {
      if (!leftFiles.has(path)) files.push({ path, status: "added" });
    }
    return { from, to, files };
  }

  async quota(workspace: WorkspaceRef): Promise<WorkspaceQuota> {
    const resolved = await this.resolve(workspace);
    const files = await listFiles(resolved.path);
    let bytes = 0;
    for (const size of files.values()) bytes += size;
    return { bytes, used: bytes, files: files.size };
  }

  async reclaim(workspace: WorkspaceRef): Promise<void> {
    const resolved = await this.resolve(workspace);
    await rm(join(this.root, "snapshots", resolved.workspace), { recursive: true, force: true });
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

  /**
   * Which event each snapshot was taken at. A plain directory keeps this beside
   * the copies, so a restart still resolves `ws3@r902`.
   */
  private async readIndex(workspace: WorkspaceRef): Promise<Map<string, { event: string; time: number }>> {
    const path = join(this.root, "snapshots", workspace, INDEX);
    try {
      const parsed = JSON.parse(await readFile(path, "utf8")) as Record<string, { event: string; time: number }>;
      return new Map(Object.entries(parsed));
    } catch {
      return new Map();
    }
  }

  private async record(workspace: WorkspaceRef, key: string, at: EventRef | undefined, time: number): Promise<void> {
    const index = await this.readIndex(workspace);
    index.set(key, { event: at ?? `${workspace}@${LATEST}`, time });
    const path = join(this.root, "snapshots", workspace, INDEX);
    await mkdir(join(this.root, "snapshots", workspace), { recursive: true });
    await writeFile(path, `${JSON.stringify(Object.fromEntries(index))}\n`, "utf8");
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

  /** Resolve any ref a model may pass back into a path on this host. */
  private async resolve(ref: WorkspaceRef | SnapshotRef): Promise<Resolved> {
    const match = /^(ws\d+)(?:@(.+))?$/.exec(ref);
    if (match === null) {
      throw arborError({
        code: "not_found",
        rule: "workspace.ref.unknown",
        message: `workspace: ${ref} 不是工作区引用`,
        nextAction: "使用 ws3 或 ws3@r902 形式的引用。",
      });
    }
    const workspace = match[1] as WorkspaceRef;
    const snapshot = match[2];
    if (snapshot === undefined) {
      const path = this.workspacePath(workspace);
      await assertDirectory(path, ref);
      return { workspace, path, readOnly: false };
    }
    const key = snapshot === LATEST ? LATEST : eventKey(snapshot as EventRef);
    const path = join(this.root, "snapshots", workspace, key);
    await assertDirectory(path, ref);
    return { workspace, path, snapshot: key, readOnly: true };
  }
}

/** Newest first: by time, then by the event's place in the one global order. */
function compareSnapshots(left: Snapshot, right: Snapshot): number {
  if (left.time !== right.time) return right.time - left.time;
  return snapshotOrder(right.ref) - snapshotOrder(left.ref);
}

/** `ws3@latest` is the newest snapshot of its workspace. */
function snapshotOrder(ref: SnapshotRef): number {
  const key = ref.slice(ref.indexOf("@") + 1);
  if (key === LATEST) return Number.MAX_SAFE_INTEGER;
  return Number(key.slice(1));
}

function page<T>(items: T[], options: { limit?: number; offset?: number } | undefined, call: string): Page<T> {
  const limit = clamp(options?.limit);
  const offset = Math.max(0, options?.offset ?? 0);
  return {
    items: items.slice(offset, offset + limit),
    total: items.length,
    limit,
    nextCall: `${call}({ limit: ${limit}, offset: ${offset + limit} })`,
  };
}

function clamp(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_PAGE_LIMIT;
  return Math.min(Math.max(1, Math.floor(limit)), MAX_PAGE_LIMIT);
}

function eventKey(ref: EventRef): string {
  const number = /^r(\d+)$/.exec(ref)?.[1];
  if (number === undefined) {
    throw arborError({
      code: "invalid_input",
      rule: "workspace.snapshot.event",
      message: `workspace: ${ref} 不是事件引用`,
      nextAction: "使用 r902 形式的事件引用。",
    });
  }
  return `r${number}`;
}

function windowNumber(window: WindowRef): number {
  return Number(/^c(\d+)$/.exec(window)?.[1] ?? 0);
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
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

/** Drop the write bits, so a read-only view is read-only as far as a directory can be. */
async function freeze(path: string): Promise<void> {
  await chmodAll(path, 0o500, 0o400);
}

async function thaw(path: string): Promise<void> {
  await chmodAll(path, 0o700, 0o600);
}

async function chmodAll(path: string, directoryMode: number, fileMode: number): Promise<void> {
  let entries;
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) {
      await chmodAll(child, directoryMode, fileMode);
      continue;
    }
    if (!entry.isFile()) continue;
    await chmod(child, fileMode);
  }
  await chmod(path, directoryMode);
}
