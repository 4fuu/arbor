/**
 * Refs and LayerFS names.
 *
 * Arbor's own refs (`ws3`, `ws3@r902`) never hold a LayerFS id, and a LayerFS
 * id never leaves this package (docs/architecture.md#interfaces). What crosses
 * between them here is a name: a workspace `ws3` is the LayerFS Branch `ws3`,
 * forked from the deployment's base Branch, and a snapshot of it is read
 * through a Branch forked at that snapshot's Commit.
 *
 * LayerFS names are 1-63 ASCII bytes, lowercase letters and digits at both
 * ends and `.`, `_` or `-` between (layerfs-history's `HistoryName`).
 */

import type { EventRef, SnapshotRef, WorkspaceRef } from "@arbor/interfaces";

/** The longest name LayerFS accepts. */
const NAME_MAX_BYTES = 63;

const WORKSPACE_PATTERN = /^ws(\d+)$/;

/** The workspace number a ref names, or `null` when it is not a workspace ref. */
export function workspaceNumberOf(ref: string): number | null {
  const match = WORKSPACE_PATTERN.exec(ref);
  return match === null ? null : Number(match[1]);
}

export function workspaceRefOf(number: number): WorkspaceRef {
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new RangeError(`a workspace number must be a positive integer, got ${number}`);
  }
  return `ws${number}` as WorkspaceRef;
}

/** The LayerFS Branch that holds one window's directory. */
export function branchNameOf(workspace: WorkspaceRef): string {
  return workspace;
}

/**
 * The Branch a read-only view of one snapshot is mounted through. LayerFS
 * mounts a Branch, never a Commit, so a snapshot is read through a Branch
 * forked at that Commit: metadata only, no file is copied. The same snapshot
 * reuses the same Branch, so viewing one twice forks nothing the second time.
 */
export function viewBranchNameOf(workspace: WorkspaceRef, at: EventRef | "latest"): string {
  const name = `${workspace}-${at}-view`;
  return name.length <= NAME_MAX_BYTES ? name : `view-${hashOf(name)}`;
}

function hashOf(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36).padStart(7, "0");
}

/** A ref that names a workspace: `ws3`, or `ws3@r902`, or `ws3@latest`. */
export type AnyWorkspaceRef = WorkspaceRef | SnapshotRef;

export interface ParsedRef {
  workspace: WorkspaceRef;
  /** The event the snapshot was recorded at, `latest`, or `null` for a bare workspace. */
  at: EventRef | "latest" | null;
}

/** Split a workspace or snapshot ref. Throws on anything else. */
export function parseRef(ref: string): ParsedRef {
  const separator = ref.indexOf("@");
  if (separator < 0) {
    const workspace = asWorkspaceRef(ref);
    return { workspace, at: null };
  }
  const workspace = asWorkspaceRef(ref.slice(0, separator));
  const at = ref.slice(separator + 1);
  if (at === "latest") return { workspace, at };
  if (!/^r\d+$/.test(at)) throw new RangeError(`${ref} is not a snapshot ref: ws<number>@r<number>`);
  return { workspace, at: at as EventRef };
}

function asWorkspaceRef(ref: string): WorkspaceRef {
  if (workspaceNumberOf(ref) === null) throw new RangeError(`${ref} is not a workspace ref: ws<number>`);
  return ref as WorkspaceRef;
}

/** The snapshot ref a snapshot handle carries back to the caller. */
export function snapshotRefOf(workspace: WorkspaceRef, at: EventRef | "latest"): SnapshotRef {
  return `${workspace}@${at}`;
}
