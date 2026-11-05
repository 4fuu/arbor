/**
 * The LayerFS JavaScript SDK, as this package uses it.
 *
 * LayerFS is not a dependency of this repository: its core is Rust, its
 * JavaScript packages (`@layerfs/agent`) are built beside a pinned checkout,
 * and the native addon is a build artifact of that checkout. So the SDK is
 * loaded from where the host put it, and this file declares the small part of
 * its surface arbor calls. The shapes below are the answers the SDK's binding
 * returns; they are written out here because the SDK ships no types, and they
 * are the only place this package touches a LayerFS shape.
 *
 * The pin is a LayerFS commit. `.agents/setup` clones it into `.layerfs`,
 * builds `engine/crates/layerfs-node/layerfs.node` and `layerfs-daemon`, and
 * this loader finds them there; `sdk` or `ARBOR_LAYERFS_SDK` names another
 * checkout.
 */

import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";

/** One Commit, as `branch.list_commits` and `workspace.commit` show it. */
export interface LayerfsCommit {
  id: string;
  branch: string | null;
  parent: string | null;
  secondParent: string | null;
  base: string;
  root: string;
  via: string;
  message: string | null;
  mergedFrom: string | null;
  time: number;
  /** Complete snapshot regular-file bytes, counting every namespace link. */
  logical: number;
  newCanonical: number;
  newStored: number;
  newMetadata: number;
  displaced: string | null;
}

export interface LayerfsBranch {
  name: string;
  id: string | null;
  base: string;
  head: string | null;
  forkedFrom: string | null;
}

export interface LayerfsPage<T> {
  items: T[];
  hasMore: boolean;
  nextPagePos: number | null;
}

/** `workspace.mount`'s answer. */
export interface LayerfsMounted {
  kind: string;
  path: string;
  workspace: string;
  namespace: number;
  branch: string;
  base: string | null;
  baseLayer: string;
  root: string;
  sandbox: string;
  container: string;
  image: string;
}

/** `workspace.exec`'s answer. */
export interface LayerfsExec {
  kind: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
  stdoutBytes?: number;
  stderrBytes?: number;
}

/** `workspace.commit`'s answer. */
export interface LayerfsCommitOutcome {
  kind: "Committed" | "UpToDate";
  head: string;
  commit?: LayerfsCommit;
  root?: string;
}

export interface LayerfsSandbox {
  sandbox: string;
  name: string;
  image: string;
  workspaces: number;
}

/** One listed change of `branch.diff_commits`. */
export interface LayerfsDiffItem {
  path: string;
  kind: "Added" | "Removed" | "Modified";
  type: string | null;
  before: { type: string; inode: number } | null;
  after: { type: string; inode: number } | null;
  content: boolean;
  identity: boolean;
  metadata: boolean;
  hunks: { op: string; text: string }[];
  hunksOmitted: boolean;
}

/** One entry of `fs.list`. */
export interface LayerfsEntry {
  name: string;
  path: string;
  type: string;
  inode: number;
}

/** `fs.stat`'s answer. */
export interface LayerfsStat {
  type: string;
  inode: number;
  size: number;
  mode: number;
}

/** The refusal a LayerFS call throws. `code` is its stable machine-readable part. */
export interface LayerfsError extends Error {
  code: string;
  detail: unknown;
}

/** The Workspace `exec`, `commit` and `unmount` name: its Sandbox and its path. */
export interface LayerfsWorkspaceHandle {
  sandbox: string;
  path: string;
}

/** The part of the `@layerfs/agent` client this package calls. */
export interface LayerfsClient {
  project: {
    list_branches(pageSize?: number, pagePos?: number): Promise<LayerfsPage<LayerfsBranch>>;
    list_sandboxes(pageSize?: number, pagePos?: number): Promise<{ kind: string; items: LayerfsSandbox[] }>;
  };
  branch: {
    fork(name: string, fromRef?: string): Promise<{ kind: string; branch: string; base: string; head: string | null }>;
    list_commits(branch: string, pageSize?: number, pagePos?: number): Promise<LayerfsPage<LayerfsCommit>>;
    diff_commits(
      from: string,
      to: string,
      pageSize?: number,
      pagePos?: number,
      options?: { cursor?: string; hunks?: boolean },
    ): Promise<{
      kind: string;
      from: { commit: string; root: string };
      to: { commit: string; root: string };
      items: LayerfsDiffItem[];
      hasMore: boolean;
      nextPagePos: number | null;
      nextCursor: string | null;
    }>;
  };
  fs: {
    list(ref: string, path?: string, pageSize?: number, pagePos?: number): Promise<LayerfsPage<LayerfsEntry>>;
  };
  sandbox: {
    create(options?: { image?: string }): Promise<{ sandbox: string; image: string }>;
  };
  workspace: {
    mount(sandbox: string, branch: string): Promise<LayerfsMounted>;
    exec(ws: LayerfsWorkspaceHandle, command: string, message?: string): Promise<LayerfsExec>;
    commit(ws: LayerfsWorkspaceHandle, message?: string, force?: boolean): Promise<LayerfsCommitOutcome>;
    unmount(ws: LayerfsWorkspaceHandle, discard?: boolean, force?: boolean): Promise<{ kind: string }>;
  };
  close(): Promise<void>;
}

export interface LayerfsFactory {
  init(project: string, folder: string, timeout?: number): Promise<LayerfsClient>;
  open(project: string): Promise<LayerfsClient>;
}

export interface LayerfsSdk {
  LayerFS: LayerfsFactory;
  LayerFSError: new (code: string, message: string, detail: unknown) => LayerfsError;
}

/** Where a host keeps the LayerFS JavaScript packages. */
export interface LayerfsSdkLocation {
  /** A directory holding `agent/` and `backend/`, or the `api/` directory itself. */
  sdk?: string;
}

const AGENT_ENTRY = ["agent", "src", "index.js"];

/** The directories a LayerFS checkout is looked for in, in order. */
function candidateRoots(location: LayerfsSdkLocation): string[] {
  const roots: string[] = [];
  if (location.sdk !== undefined) roots.push(location.sdk);
  const fromEnvironment = process.env.ARBOR_LAYERFS_SDK;
  if (fromEnvironment !== undefined && fromEnvironment !== "") roots.push(fromEnvironment);
  const here = fileURLToPath(new URL(".", import.meta.url));
  const repository = fileURLToPath(new URL("../../..", import.meta.url));
  roots.push(join(repository, ".layerfs", "api"));
  roots.push(join(repository, "node_modules"));
  roots.push(join(here, "..", "..", "..", ".layerfs", "api"));
  return roots;
}

/** Load the SDK, or `null` when no checkout is installed here. */
export async function loadLayerfsSdk(location: LayerfsSdkLocation = {}): Promise<LayerfsSdk | null> {
  for (const root of candidateRoots(location)) {
    const entry = join(root, ...AGENT_ENTRY);
    if (!existsSync(entry)) continue;
    let loaded: Record<string, unknown>;
    try {
      loaded = (await import(pathToFileURL(entry).href)) as Record<string, unknown>;
    } catch {
      // A checkout that does not load is the same as no checkout: the caller
      // gets one refusal naming what to install, not an import error.
      continue;
    }
    const LayerFS = loaded.LayerFS as LayerfsFactory | undefined;
    const LayerFSError = loaded.LayerFSError as LayerfsSdk["LayerFSError"] | undefined;
    if (LayerFS === undefined || LayerFSError === undefined) continue;
    return { LayerFS, LayerFSError };
  }
  return null;
}

/** The LayerFS checkout this package would use, or `null` when there is none. */
export function layerfsCheckout(location: LayerfsSdkLocation = {}): string | null {
  for (const root of candidateRoots(location)) {
    if (existsSync(join(root, ...AGENT_ENTRY))) return root;
  }
  return null;
}
