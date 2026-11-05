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

/** One background command running in a workspace. */
export interface BackgroundJob {
  /** The implementation's own id, which a caller passes back to follow or stop it. */
  id: string;
  /** The command it runs. */
  command: string;
  /** True while it runs; false once it has ended or was stopped. */
  running: boolean;
  /** What it has written so far, as text. */
  output: string;
}

/**
 * Background commands in a mounted workspace, for an implementation that owns
 * its execution environment (docs/tools.md#rules: a command that outlives
 * `bash`'s wait window is followed with `bash_output` and stopped with
 * `bash_stop`).
 *
 * Present when the implementation can start a command that outlives the call
 * and read what it wrote. A host-directory implementation leaves it out: the
 * caller starts the command itself in `path` and follows it there.
 */
export interface WorkspaceJobs {
  /** Start one command in the workspace. It keeps running after this returns. */
  start(command: string): Promise<BackgroundJob>;
  /** The job's output so far, and whether it still runs. */
  output(job: string): Promise<BackgroundJob>;
  /** Stop a running job. Stopping one that already ended changes nothing. */
  stop(job: string): Promise<void>;
}

/** One file made visible inside a mounted workspace's execution environment. */
export interface StagedFile {
  /** The path under the prefix, such as `skills/deploy/SKILL.md`. */
  path: string;
  /** The file's text. */
  text: string;
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
  /**
   * Read one file in the workspace as UTF-8 text, or `null` when it does not
   * exist. Present when the implementation can hand a file to the host; an
   * implementation whose `path` is not a host path implements it over its own
   * transport. A caller falls back to reading `path` on the host when it is
   * absent.
   */
  readFile?(path: string): Promise<string | null>;
  /**
   * Write one file in the workspace as UTF-8 text, creating its directory.
   * The same fallback rule as `readFile` applies.
   */
  writeFile?(path: string, text: string): Promise<void>;
  /**
   * Make files visible inside the execution environment, and answer the path
   * they are visible at - which may be `prefix` itself, or somewhere else the
   * implementation owns.
   *
   * For the shared environment, which a window reads at `/env` and which lives
   * on the host (docs/environment.md#layout): an implementation whose `path` is
   * not a host path stages the files into its own execution environment, and
   * the caller rewrites the prefix onto what this answers. A host-directory
   * implementation leaves it out, because its `path` already reaches the
   * directory.
   *
   * What is staged is not the workspace's own: it sits outside its tree, so no
   * snapshot holds it, no fork copies it and no diff or read-only view shows
   * it. An implementation stages it read-only, because a change goes through
   * the environment's own draft and `reload`.
   */
  stage?(prefix: string, files: readonly StagedFile[]): Promise<string>;
  /**
   * Background commands in this workspace. Present when the implementation
   * owns the execution environment and can start a command that outlives the
   * call; a host-directory implementation leaves it out and the caller runs
   * the command itself in `path`.
   */
  jobs?: WorkspaceJobs;
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
