/**
 * The `Workspace` interface: a directory per window (docs/workspaces.md).
 *
 * A workspace is a plain directory, not bound to any repository: the framework
 * gives isolation and continuity, and the agent does the rest. The default is
 * a plain directory under one root, which needs nothing a host does not
 * already have and runs the same way on Windows, Linux and macOS.
 */

import type { TextTable } from "./blocks.ts";
import type { WindowRef, WorkspaceRef } from "./refs.ts";
import type { PromptSection } from "./plugin.ts";
import type { ToolGroup } from "./tools.ts";

/** The result of one command run in a mounted workspace. */
export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** The streams were cut to fit a bound. An implementation that never cuts them reports `false`. */
  truncated: boolean;
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
 * directory of an implementation that owns its own execution environment, so a
 * command runs there through `exec`, not on the host.
 */
export interface WorkspaceMount {
  ref: WorkspaceRef;
  path: string;
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
   * What is staged is not the workspace's own: it sits outside its tree. An
   * implementation stages it read-only, because a change goes through the
   * environment's own draft and `reload`.
   */
  stage?(prefix: string, files: readonly StagedFile[]): Promise<string>;
  release(): Promise<void>;
}

export interface WorkspaceQuota {
  bytes: number;
  used: number;
  files: number;
}

/**
 * One checkout a window's chain has open, for an implementation that gives a
 * window a copy-on-write checkout rather than working in place (the ovnfs
 * workspace, docs/workspaces.md). `dirty` is true when the checkout holds
 * changes not yet applied back, which counts as open work at `end`.
 */
export interface WorkspaceCheckout {
  /** The checkout's name, which begins with the window ref that opened it. */
  name: string;
  /** The checkout's path on the host, where a command works in it. */
  path: string;
  /** The checkout holds changes not yet applied back to the shared folder. */
  dirty: boolean;
}

export interface Workspace {
  /**
   * Create the window's own directory, on first use. A window that never
   * touches files has none.
   */
  create(window: WindowRef): Promise<WorkspaceRef>;

  /** Mount a workspace, read-write, at its own path. */
  mount(ref: WorkspaceRef): Promise<WorkspaceMount>;

  /** The workspace's size and file count, for a quota a deployment sets. */
  quota(workspace: WorkspaceRef): Promise<WorkspaceQuota>;

  /** Reclaim the workspace after the retention period. */
  reclaim(workspace: WorkspaceRef): Promise<void>;

  /**
   * The workspace a window's chain already has, or `undefined` when it has
   * none - the window never touched files, or the directory was reclaimed. The
   * host asks for it to reclaim a chain's directory once its last window has
   * ended and the retention period has passed, which a restart has to survive
   * (docs/workspaces.md#lifecycle).
   */
  refOf(window: WindowRef): Promise<WorkspaceRef | undefined>;

  /**
   * What this implementation adds to the catalog: tool groups built from the
   * table the host renders with.
   *
   * A capability the core does not name arrives here. An implementation that
   * can show another window's workspace declares its own module function or
   * tool and its own prompt text this way, so the core knows nothing about it;
   * a host whose implementation contributes nothing shows the model nothing
   * about it (docs/workspaces.md, docs/architecture.md#plugins).
   */
  groups?: (table: TextTable) => readonly ToolGroup[];

  /**
   * The open checkouts of a window's chain, for `end`'s open-work check, for
   * `workspace.list` and `workspace.path`, and as the gate reclaim uses. Absent
   * for an implementation that keeps no checkouts of its own.
   */
  checkouts?(window: WindowRef): Promise<readonly WorkspaceCheckout[]>;

  /**
   * The prompt section this implementation contributes, or none. It carries the
   * method the model follows - how this implementation wants files changed -
   * rendered in its own tag, so each implementation owns its own prompt text and
   * a host that fell back to another implementation shows that one's instead.
   */
  promptSection?(table: TextTable): PromptSection;

  /**
   * The environment a bash command in this window runs with, beyond the host's
   * own, or none. The ovnfs workspace sets `ARBOR_WINDOW` and the git hook path
   * that stamps `Arbor-Window` onto commits made in a checkout
   * (docs/workspaces.md). Set on the command's own process, never on the host,
   * so it does not reach an MCP server or a service.
   */
  bashEnv?(window: WindowRef): Record<string, string>;

  /**
   * The built-in skills this implementation seeds into the environment, read
   * only, or none. The ovnfs workspace seeds the `ovnfs` skill that documents
   * the full CLI method.
   */
  builtinSkills?(): readonly { name: string; source: string }[];
}
