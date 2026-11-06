/**
 * The ovnfs `Workspace` (docs/workspaces.md).
 *
 * One shared folder every window reads and writes, which can hold several
 * projects and repositories. It is read-only by convention - nothing here
 * refuses a write to it - so a window that wants to change files opens its own
 * copy-on-write checkout of the project subfolder it needs, works there, and
 * merges back with `apply`, resolving conflicts itself. The checkout is named
 * after the window that opened it (`<window ref>-<short name>`), which is how
 * the host binds a checkout to a window: `end`'s open-work check and reclaim
 * both find a window's checkouts by that prefix.
 *
 * The file tools run against the shared folder (`mount.path`); a window reaches
 * its checkout by the absolute path `checkout` returns, or by `cd`-ing into it
 * in `bash`. ovnfs isolates files, not processes: it is not a sandbox.
 */

import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { arborError } from "@4fu/arbor-errors";
import type {
  Journal,
  OpenWorkItem,
  PromptSection,
  TextTable,
  ToolGroup,
  WindowRef,
  Workspace,
  WorkspaceCheckout,
  WorkspaceMount,
  WorkspaceQuota,
  WorkspaceRef,
} from "@4fu/arbor-interfaces";
import { textOf } from "@4fu/arbor-prompt";
import { OvnfsCli } from "./cli.ts";
import { OvnfsWorkspaceGroup } from "./groups.ts";
import { ovnfsSection } from "./section.ts";
import { ovnfsText } from "./text.ts";

export interface OvnfsWorkspaceOptions {
  /** The shared folder every window works in. Absolute, or resolved against cwd. */
  source: string;
  /** Where the ovnfs daemon keeps its state. */
  state: string;
  /** Where checkouts appear. */
  mount: string;
  /** The ovnfs binary to run; `ovnfs` on PATH by default. */
  bin?: string;
  /**
   * The journal, for the events a checkout opened or applied records and for
   * resolving a window's chain. Absent leaves those off: checkouts are then
   * found only by the opening window's own prefix.
   */
  journal?: Journal;
}

export class OvnfsWorkspace implements Workspace {
  private readonly source: string;
  private readonly journal: Journal | undefined;
  private readonly cli: OvnfsCli;

  constructor(options: OvnfsWorkspaceOptions) {
    this.source = resolve(options.source);
    this.journal = options.journal;
    this.cli = new OvnfsCli(options.bin ?? "ovnfs", options.state, options.mount);
  }

  /**
   * The window's ref as a workspace token. The shared folder is one place, not
   * one per window, so the ref only identifies the window for the checkout
   * operations - `checkouts`, `refOf` and `reclaim` - that bind by it.
   */
  async create(window: WindowRef): Promise<WorkspaceRef> {
    return `ws${windowNumber(window)}` as WorkspaceRef;
  }

  /**
   * The shared folder, read-write on the host. A relative path is inside it; an
   * absolute one is read where it names, which is how a window reaches its
   * checkout. Nothing refuses a write: the shared folder is read-only by
   * convention, and the prompt text is the only guard, exactly as the plain
   * directory workspace documents (docs/workspaces.md).
   */
  async mount(ref: WorkspaceRef): Promise<WorkspaceMount> {
    if (!/^ws\d+$/.test(ref)) {
      throw unknownRef(ref);
    }
    const source = this.source;
    return {
      ref,
      path: source,
      readFile: async (path: string) => readFile(hostPath(source, path), "utf8").catch(() => null),
      writeFile: async (path: string, text: string) => {
        const target = hostPath(source, path);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, text, "utf8");
      },
      release: async () => {},
    };
  }

  async quota(_ref: WorkspaceRef): Promise<WorkspaceQuota> {
    const files = await listFiles(this.source);
    let bytes = 0;
    for (const size of files.values()) bytes += size;
    return { bytes, used: bytes, files: files.size };
  }

  /**
   * Remove every checkout of the window's chain, found by the `<window ref>-`
   * prefix. The window here is the chain's root, which the host asks for, and a
   * checkout belongs to the chain when the window that opened it continues -
   * directly or not - from that root.
   */
  async reclaim(ref: WorkspaceRef): Promise<void> {
    const root = windowFromRef(ref);
    const listed = await this.cli.ls().catch(() => null);
    if (listed === null) return;
    for (const checkout of listed.checkouts) {
      const owner = checkoutOwner(checkout.name);
      if (owner === undefined) continue;
      if (owner === root || (await this.reaches(owner, root))) {
        await this.cli.rm(checkout.name).catch(() => {});
      }
    }
  }

  /**
   * The workspace a window's chain has, when it has any checkout to reclaim -
   * `undefined` when the chain opened none, so the host sets no reclaim timer.
   */
  async refOf(window: WindowRef): Promise<WorkspaceRef | undefined> {
    const listed = await this.cli.ls().catch(() => null);
    if (listed === null) return undefined;
    for (const checkout of listed.checkouts) {
      const owner = checkoutOwner(checkout.name);
      if (owner === undefined) continue;
      if (owner === window || (await this.reaches(owner, window))) {
        return `ws${windowNumber(window)}` as WorkspaceRef;
      }
    }
    return undefined;
  }

  /**
   * The open checkouts of a window's chain. The chain is the window and every
   * window it continues from, resolved through the journal, so a continuation
   * sees its predecessor's checkouts too.
   */
  async checkouts(window: WindowRef): Promise<readonly WorkspaceCheckout[]> {
    const chain = await this.chainWindows(window);
    const listed = await this.cli.ls().catch(() => null);
    if (listed === null) return [];
    const found: WorkspaceCheckout[] = [];
    for (const checkout of listed.checkouts) {
      const owner = checkoutOwner(checkout.name);
      if (owner === undefined || !chain.includes(owner)) continue;
      found.push({ name: checkout.name, path: checkout.path, dirty: checkout.dirty });
    }
    return found;
  }

  /**
   * The work this window still has open: its checkouts that hold changes not
   * yet applied back (docs/workspaces.md#open-work). A checkout that is applied
   * is finished work, so it is not open; the host asks `checkouts` for the ones
   * that are merely still there.
   */
  async openWork(window: WindowRef): Promise<readonly OpenWorkItem[]> {
    const checkouts = await this.checkouts(window);
    return checkouts
      .filter((checkout) => checkout.dirty)
      .map((checkout) => ({ name: checkout.name, detail: textOf(ovnfsText, "open.dirty") }));
  }

  groups(table: TextTable): readonly ToolGroup[] {
    return [new OvnfsWorkspaceGroup(this, { ...table, ...ovnfsText })];
  }

  promptSection(): PromptSection {
    return ovnfsSection(this.source);
  }

  bashEnv(window: WindowRef): Record<string, string> {
    return {
      ARBOR_WINDOW: window,
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.hooksPath",
      GIT_CONFIG_VALUE_0: hooksDir(),
    };
  }

  builtinSkills(): readonly { name: string; source: string }[] {
    return [{ name: "ovnfs", source: skillsDir() }];
  }

  // ---- the operations the module functions run ---------------------------

  /** Open a checkout on a subfolder and record it. Returns its path. */
  async openCheckout(window: WindowRef, name: string, dir?: string): Promise<string> {
    const target = dir === undefined || dir === "" ? this.source : hostPath(this.source, dir);
    const reply = await this.cli.open({ dir: target, name });
    await this.record("workspace_checkout", window, { name, path: reply.checkout.path, dir: target });
    return reply.checkout.path;
  }

  /** A checkout's changed source paths since its base. */
  diffCheckout(name: string) {
    return this.cli.diff(name);
  }

  /** Merge a checkout back, recording the apply and any conflict. */
  async applyCheckout(window: WindowRef, name: string, branch?: string) {
    const reply = await this.cli.apply({ checkout: name, ...(branch === undefined ? {} : { branch }) });
    await this.record("workspace_apply", window, {
      name,
      ...(branch === undefined ? {} : { branch }),
      applied: reply.applied.length,
      merged: reply.merged.length,
      conflicts: reply.conflicts.length,
    });
    if (reply.conflicts.length > 0) {
      await this.record("workspace_conflict", window, {
        name,
        conflicts: reply.conflicts.map((conflict) => conflict.path),
      });
    }
    return reply;
  }

  /** Remove a checkout. */
  removeCheckout(name: string): Promise<void> {
    return this.cli.rm(name);
  }

  // ---- chain resolution -------------------------------------------------

  /** The window and every window it continues from, newest first. */
  private async chainWindows(window: WindowRef): Promise<WindowRef[]> {
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

  /** Whether `target` is `window` or one of the windows it continues from. */
  private async reaches(window: WindowRef, target: WindowRef): Promise<boolean> {
    let current: WindowRef | undefined = window;
    for (let depth = 0; depth < 1000 && current !== undefined; depth += 1) {
      if (current === target) return true;
      if (this.journal === undefined) return false;
      const page = await this.journal.list({ window: current, kinds: ["window_start"], limit: 1 });
      current = continuedWindow(page.items[0]?.body);
    }
    return false;
  }

  private async record(kind: string, window: WindowRef, body: Record<string, unknown>): Promise<void> {
    if (this.journal === undefined) return;
    await this.journal.append({ kind, window, body: JSON.stringify(body) }).catch(() => {});
  }
}

/** Where a path names on the host: itself when absolute, under `source` when not. */
function hostPath(source: string, path: string): string {
  return isAbsolute(path) ? normalize(path) : resolve(source, path);
}

/** The window a checkout name begins with: `c41-app` is `c41`. */
function checkoutOwner(name: string): WindowRef | undefined {
  const match = /^(c\d+)-/.exec(name);
  return match?.[1] === undefined ? undefined : (match[1] as WindowRef);
}

/** The window a ref names: `ws41` is `c41`. */
function windowFromRef(ref: WorkspaceRef): WindowRef {
  return `c${windowNumber(ref)}` as WindowRef;
}

function windowNumber(value: string): number {
  return Number(/(?:^|\D)(\d+)$/.exec(value)?.[1] ?? 0);
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

function unknownRef(ref: string): Error {
  return arborError({
    code: "not_found",
    rule: "workspace.ref.unknown",
    message: `workspace: ${ref} 不是工作区引用`,
    nextAction: "使用 ws3 形式的引用。",
  });
}

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

/** This package's hooks directory, beside the built sources. */
function hooksDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "hooks");
}

/** This package's `ovnfs` skill directory, beside the built sources. */
function skillsDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "skills", "ovnfs");
}
