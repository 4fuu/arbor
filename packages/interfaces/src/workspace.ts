/**
 * The `Workspace` interface: a directory per window, with forks and snapshots
 * (docs/workspaces.md).
 *
 * A workspace is a plain directory, not bound to any repository: the framework
 * gives isolation, continuity and snapshots, and the agent does the rest. The
 * default is LayerFS, used only for cheap forks, snapshots and mounts.
 */

import type { Page } from "./events.ts";
import type { EventRef, SnapshotRef, WindowRef, WorkspaceRef } from "./refs.ts";

/**
 * A snapshot handle from an implementation. `id` is opaque and never crosses
 * another boundary; the service layer turns the handle into a `SnapshotRef`.
 */
export interface SnapshotHandle {
  /** The ref a model may pass back: `ws3@r902`. */
  ref: SnapshotRef;
  /** The implementation's own id. Never leaves the implementation. */
  id: string;
}

export interface Snapshot {
  ref: SnapshotRef;
  /** The event that recorded the change. */
  event: EventRef;
  time: number;
  size?: number;
}

export interface MountOptions {
  readOnly?: boolean;
}

/** A mounted workspace: a path in the host's filesystem, released when done. */
export interface WorkspaceMount {
  ref: WorkspaceRef | SnapshotRef;
  path: string;
  readOnly: boolean;
  release(): Promise<void>;
}

export interface WorkspaceDiff {
  from: SnapshotRef | WorkspaceRef;
  to: SnapshotRef | WorkspaceRef;
  files: readonly DiffFile[];
}

export interface DiffFile {
  path: string;
  status: "added" | "changed" | "removed";
  added?: number;
  removed?: number;
}

export interface WorkspaceQuota {
  bytes: number;
  used: number;
  files: number;
}

export interface Workspace {
  /** Create the window's own directory. A window that never touches files has none. */
  create(window: WindowRef): Promise<WorkspaceRef>;

  /** Fork for a continuation. A fork copies no files. */
  fork(from: WorkspaceRef, window: WindowRef): Promise<WorkspaceRef>;

  /** Snapshot the directory's state, recorded at one event. */
  snapshot(workspace: WorkspaceRef, at?: EventRef): Promise<SnapshotHandle>;

  /** The workspace's snapshots, newest first. */
  snapshots(workspace: WorkspaceRef, options?: { limit?: number; offset?: number }): Promise<Page<Snapshot>>;

  /** Mount a workspace or one of its snapshots, read-only by ref. */
  mount(ref: WorkspaceRef | SnapshotRef, options?: MountOptions): Promise<WorkspaceMount>;

  diff(from: WorkspaceRef | SnapshotRef, to: WorkspaceRef | SnapshotRef): Promise<WorkspaceDiff>;

  quota(workspace: WorkspaceRef): Promise<WorkspaceQuota>;

  /** Reclaim the snapshots after the retention period. */
  reclaim(workspace: WorkspaceRef): Promise<void>;
}
