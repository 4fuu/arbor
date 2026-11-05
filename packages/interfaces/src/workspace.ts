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

/** The result of one command run in a mounted workspace. */
export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** The streams were cut to fit a bound. An implementation that never cuts them reports `false`. */
  truncated: boolean;
}

/**
 * A mounted workspace: a path in the host's filesystem, released when done.
 *
 * `path` is where the workspace's files are. It is a host path for an
 * implementation that mounts a directory on the host, and the mounted
 * directory of an implementation that owns its own execution environment -
 * LayerFS mounts a Workspace inside its Sandbox, so a command runs there
 * through `exec`, not on the host.
 */
export interface WorkspaceMount {
  ref: WorkspaceRef | SnapshotRef;
  path: string;
  readOnly: boolean;
  /**
   * Run one command in the workspace's directory. Present when the
   * implementation owns the execution environment; a host-directory
   * implementation leaves it out and the caller runs the command itself in
   * `path`.
   */
  exec?(command: string): Promise<ExecResult>;
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
