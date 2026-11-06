/**
 * The plain-directory `Workspace` (docs/workspaces.md).
 *
 * A workspace is a plain directory, not bound to any repository: the framework
 * gives isolation and continuity, and the agent does the rest. This
 * implementation keeps every window's directory under one root, and beside
 * them the persistent directories a window asks to keep:
 *
 * ```text
 * <root>/ws3/                    the window's own directory
 * <root>/keep/notes/             a persistent directory, kept past the window
 * ```
 *
 * A new window gets a directory of its own, created on first use. A
 * continuation works in its predecessor's directory in place, under the same
 * ref: no copy, no link, no fork. Only one window in a chain is live at a time,
 * so in place is safe, and the chain is in the journal, so a restart recovers
 * which directory a continuation uses.
 *
 * A window's own directory ends with its chain: after `workspaces.retentionMs`
 * the host reclaims it. Content that has to outlive that is a **persistent
 * directory** - `workspace.keep(name)`, or a plain `mkdir` under the same root -
 * which lives outside the windows' own directories, so reclaim never touches it
 * and a restart finds it where it was. It is recorded in the journal with the
 * window that made it, so a continuation is told which ones its chain has and
 * `journal.search` finds the rest.
 *
 * It isolates by directory only. Another window's directory is a path on this
 * host, which a command may name and `read`, `write` and `edit` may open and
 * change; nothing here refuses a path outside the window's own directory, and
 * nothing here stops `bash`. What keeps one window out of another's directory
 * is the prompt text `workspace.path` answers with, not a rule this
 * implementation enforces. That is not a security boundary, and the docs say
 * so: real isolation comes from an implementation that owns its execution
 * environment.
 *
 * It reports no open work: a window works in place and its continuation keeps
 * working in the same directory, so there is no step between the two where work
 * could be left unapplied, and `Workspace.openWork` is left out rather than
 * answered empty (docs/workspaces.md#open-work).
 */

import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";
import { arborError } from "@4fu/arbor-errors";
import type {
  Journal,
  PromptSection,
  TextTable,
  ToolGroup,
  WindowRef,
  Workspace,
  WorkspaceKeep,
  WorkspaceMount,
  WorkspaceQuota,
  WorkspaceRef,
} from "@4fu/arbor-interfaces";
import { textOf } from "@4fu/arbor-prompt";
import { WorkspaceDirGroup } from "./module.ts";
import { directorySection, directoryText } from "./section.ts";

/** The directory under the root that holds the persistent directories. */
const KEEP_DIR = "keep";

/** How many `workspace_keep` events one read of the journal takes. */
const KEEP_PAGE = 200;

/** The longest a persistent directory's name may be. */
const KEEP_NAME_MAX = 64;

export interface DirectoryWorkspaceOptions {
  /** The root every workspace lives under. */
  root: string;
  /**
   * The journal, for the events a persistent directory records and for chain
   * resolution. Absent leaves those off: a persistent directory still works,
   * and a continuation is then told only about the ones on disk.
   */
  journal?: Journal;
}

export class DirectoryWorkspace implements Workspace {
  private readonly root: string;
  private readonly journal: Journal | undefined;

  constructor(options: DirectoryWorkspaceOptions) {
    this.root = options.root;
    this.journal = options.journal;
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
        // where it is on this host, which is how another window's directory and
        // a persistent directory are read (docs/workspaces.md).
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

  /**
   * Reclaim a window's own directory. A persistent directory is not one: it
   * lives under `keep`, beside the windows' directories, so reclaiming a
   * window's own directory leaves every persistent directory where it is
   * (docs/workspaces.md#lifecycle).
   */
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

  // ---- persistent directories -------------------------------------------

  /**
   * The persistent directory `name` names, created on first use, and its path
   * on this host. Idempotent: the name that is already there is handed back as
   * it is, so a later window that wants the same place gets the same directory
   * instead of a second one. The write is recorded in the journal with the
   * window that made it, which is how a continuation learns which ones its
   * chain has.
   */
  async keep(window: WindowRef, name: string): Promise<string> {
    const path = this.keepPath(name);
    await mkdir(path, { recursive: true });
    await this.record("workspace_keep", window, { name, path });
    return path;
  }

  /**
   * The persistent directories on disk, by name, or only the ones a window's
   * chain created when a window is named. The directory is the truth: one the
   * model removed with `rm` is gone from the answer, and the journal only says
   * who made which.
   */
  async keeps(window?: WindowRef): Promise<readonly WorkspaceKeep[]> {
    const onDisk = await this.keepsOnDisk();
    if (window === undefined) return onDisk;
    const created = await this.keptNames(window);
    return onDisk.filter((keep) => created.has(keep.name));
  }

  /** Every persistent directory under the keep root, by name. */
  private async keepsOnDisk(): Promise<readonly WorkspaceKeep[]> {
    const root = join(this.root, KEEP_DIR);
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      return [];
    }
    const keeps: WorkspaceKeep[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      keeps.push({ name: entry.name, path: join(root, entry.name) });
    }
    // A listing reaches the prompt and a result line, so it is ordered rather
    // than left to the filesystem.
    return keeps.sort((one, other) => one.name.localeCompare(other.name));
  }

  /** The names a window's chain recorded a persistent directory under. */
  private async keptNames(window: WindowRef): Promise<Set<string>> {
    const names = new Set<string>();
    if (this.journal === undefined) return names;
    for (const one of await this.chainWindows(window)) {
      for (const name of await this.keepEvents(one)) names.add(name);
    }
    return names;
  }

  /** Every `workspace_keep` event one window recorded, paged to the end. */
  private async keepEvents(window: WindowRef): Promise<readonly string[]> {
    const journal = this.journal;
    const names: string[] = [];
    if (journal === undefined) return names;
    for (let offset = 0; offset < 10_000; offset += KEEP_PAGE) {
      const page = await journal
        .list({ window, kinds: ["workspace_keep"], limit: KEEP_PAGE, offset })
        .catch(() => null);
      if (page === null || page.items.length === 0) return names;
      for (const event of page.items) {
        const name = keptName(event.body);
        if (name !== undefined) names.push(name);
      }
      if (offset + page.items.length >= page.total) return names;
    }
    return names;
  }

  /** The window and every window it continues from, newest first. */
  private async chainWindows(window: WindowRef): Promise<readonly WindowRef[]> {
    const chain: WindowRef[] = [window];
    const seen = new Set<WindowRef>([window]);
    let current = window;
    for (let depth = 0; depth < 1000; depth += 1) {
      if (this.journal === undefined) break;
      const page = await this.journal.list({ window: current, kinds: ["window_start"], limit: 1 });
      const previous = continuedWindow(page.items[0]?.body);
      if (previous === undefined || seen.has(previous)) break;
      seen.add(previous);
      chain.push(previous);
      current = previous;
    }
    return chain;
  }

  private async record(kind: string, window: WindowRef, body: Record<string, unknown>): Promise<void> {
    if (this.journal === undefined) return;
    await this.journal.append({ kind, window, body: JSON.stringify(body) }).catch(() => {});
  }

  // ---- what this implementation adds ------------------------------------

  /**
   * What this implementation adds to the catalog: another window's directory by
   * its window, and the persistent directories. The core declares no such
   * capability of its own (docs/workspaces.md).
   */
  groups(table: TextTable): readonly ToolGroup[] {
    return [new WorkspaceDirGroup(this, { ...table, ...directoryText })];
  }

  /**
   * This implementation's own prompt text: work in your own directory in place,
   * keep what has to outlive the window in a persistent directory, and treat
   * another window's directory as read-only by convention. Its own, different
   * from the ovnfs workspace's, so a host never shows the ovnfs method when it
   * fell back here (docs/workspaces.md).
   */
  promptSection(): PromptSection {
    return directorySection(this.root);
  }

  private workspacePath(ref: WorkspaceRef): string {
    return join(this.root, ref);
  }

  /** Where a persistent directory's name puts it, refusing a name that escapes. */
  private keepPath(name: string): string {
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(name) || name.length > KEEP_NAME_MAX) {
      throw arborError({
        code: "invalid",
        rule: "workspace.keep.name",
        message: textOf(directoryText, "refused.workspace.keep.name", { name }),
        nextAction: textOf(directoryText, "next.workspace.keep.name"),
      });
    }
    return join(this.root, KEEP_DIR, name);
  }

  /**
   * The ref a window's directory has: the one it already has, or the next
   * number nothing has taken. A window's number only grows, so a directory is
   * never handed to a second window. The keep root is not a window's directory
   * and is not one of the candidates.
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

/** The window a `window_start` body names as the one it continues. */
function continuedWindow(body: string | null | undefined): WindowRef | undefined {
  if (body === undefined || body === null) return undefined;
  try {
    const parsed = JSON.parse(body) as { continuation?: unknown };
    const previous = parsed.continuation;
    return typeof previous === "string" && /^c\d+$/.test(previous) ? (previous as WindowRef) : undefined;
  } catch {
    return undefined;
  }
}

/** The name a `workspace_keep` body records, when it records one. */
function keptName(body: string | null | undefined): string | undefined {
  if (body === undefined || body === null) return undefined;
  try {
    const parsed = JSON.parse(body) as { name?: unknown };
    return typeof parsed.name === "string" ? parsed.name : undefined;
  } catch {
    return undefined;
  }
}
