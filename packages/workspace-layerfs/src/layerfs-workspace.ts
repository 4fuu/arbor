/**
 * The default `Workspace`: a directory per window on LayerFS
 * (docs/workspaces.md).
 *
 * What each arbor ref names in LayerFS, and why:
 *
 * - A workspace `ws3` is the LayerFS Branch `ws3`, forked from the
 *   deployment's base Branch when the window's directory is first used, and
 *   from its predecessor when a continuation window forks it. A fork is
 *   metadata only: no file is copied, so cloned repositories, installed
 *   dependencies and work in progress carry over.
 * - A snapshot is a Commit. Every write and every `bash` call ends with one,
 *   and this package records which Commit an event's snapshot holds, because a
 *   LayerFS Commit id is not a ref and may not cross an interface. The
 *   registry is the only place a LayerFS id is written down.
 * - A read-only view of another workspace's snapshot is mounted through a
 *   Branch forked at that snapshot's Commit: LayerFS mounts a Branch and never
 *   a Commit, and forking at a Commit copies nothing.
 * - `bash` runs inside the Sandbox LayerFS mounts the Workspace in, through
 *   the mount's `exec`. The mounted path is the Sandbox's own, not the host's.
 *
 * Two limits come from LayerFS itself and are worth stating: its Store has no
 * per-Branch delete, so `reclaim` drops this package's refs and leaves the
 * history in the Store until the project is removed; and its storage is
 * deduplicated across the whole Store, so `quota` reports the workspace's
 * logical size rather than bytes it alone occupies.
 */

import { arborError, wrapError } from "@arbor/errors";
import {
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  type DiffFile,
  type EventRef,
  type MountOptions,
  type Page,
  type Snapshot,
  type SnapshotHandle,
  type SnapshotRef,
  type Workspace,
  type WorkspaceDiff,
  type WorkspaceMount,
  type WorkspaceQuota,
  type WorkspaceRef,
  type WindowRef,
} from "@arbor/interfaces";
import { mkdtempSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { layerfsCapabilities, type LayerfsCapabilities } from "./capabilities.ts";
import type { LayerfsClient, LayerfsError, LayerfsWorkspaceHandle } from "./layerfs-sdk.ts";
import { loadLayerfsSdk } from "./layerfs-sdk.ts";
import {
  PAGE_SIZE,
  registryPathOf,
  resolveOptions,
  type LayerfsWorkspaceOptions,
  type ResolvedOptions,
} from "./options.ts";
import { Registry, type SnapshotRecord } from "./registry.ts";
import { parseRef, snapshotRefOf, viewBranchNameOf, type ParsedRef } from "./refs.ts";

/** One operation at a time: the Store has one writer and one publication lane. */
class Mutex {
  private tail: Promise<void> = Promise.resolve();

  run<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release: () => void = () => {};
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    return previous.then(async () => {
      try {
        return await work();
      } finally {
        release();
      }
    });
  }
}

interface ActiveMount {
  id: number;
  /** The ref that was mounted: `ws3`, or `ws3@r902`. */
  ref: WorkspaceRef | SnapshotRef;
  workspace: WorkspaceRef;
  readOnly: boolean;
  /** The LayerFS Branch this mount is bound to. */
  branch: string;
  handle: LayerfsWorkspaceHandle;
  path: string;
  /** One command at a time in this mount. */
  exec: Mutex;
}

interface MountedIn {
  sandbox: string;
  path: string;
}

/** How many Workspaces one LayerFS Sandbox holds. */
const WORKSPACES_PER_SANDBOX = 16;

type ArborError = ReturnType<typeof arborError>;

const LAYERFS_CODES: Record<string, ArborError["code"]> = {
  NoSuchBranch: "not_found",
  NoSuchProject: "not_found",
  NoSuchPath: "not_found",
  NoSuchSandbox: "not_found",
  NoStore: "not_found",
  Conflict: "conflict",
  NameTaken: "conflict",
  ReservedName: "conflict",
  Dirty: "conflict",
  MountsActive: "conflict",
  Capacity: "limit_reached",
  InvalidInput: "invalid_input",
  Binary: "invalid_input",
  NotFile: "invalid_input",
  NotDirectory: "invalid_input",
  Unsupported: "unavailable",
  Busy: "unavailable",
  Failed: "internal",
  Unknown: "internal",
};

function refusal(error: unknown, rule: string, message: string, nextAction: string): ArborError {
  const code = error instanceof Error ? (error as LayerfsError).code : undefined;
  return wrapError(error, {
    code: code === undefined ? "internal" : (LAYERFS_CODES[code] ?? "internal"),
    rule,
    message,
    nextAction,
  });
}

function parse(ref: string): ParsedRef {
  try {
    return parseRef(ref);
  } catch (error) {
    throw wrapError(error, {
      code: "invalid_input",
      rule: "workspace.ref.shape",
      message: `a workspace ref is ws<number>, or one of its snapshots: ws<number>@r<number> or ws<number>@latest (${String(error)})`,
      nextAction: "pass a workspace ref such as ws3, or one of its snapshots such as ws3@r902",
    });
  }
}

export class LayerfsWorkspace implements Workspace {
  private readonly options: ResolvedOptions;
  private readonly registry: Registry;
  private readonly control = new Mutex();
  private sdk: Awaited<ReturnType<typeof loadLayerfsSdk>> = null;
  private client: LayerfsClient | null = null;
  private readonly mounts = new Map<number, ActiveMount>();
  private nextMountId = 1;
  private closed = false;

  constructor(options: LayerfsWorkspaceOptions = {}) {
    this.options = resolveOptions(options);
    this.registry = new Registry(registryPathOf(this.options.stateDir));
  }

  /** What this machine can run. A host reads this before it mounts anything. */
  async capabilities(): Promise<LayerfsCapabilities> {
    return layerfsCapabilities({ sdk: this.options.sdk, deployment: this.options.deployment });
  }

  /**
   * Create the window's own directory. A window that never touches files has
   * none, so nothing is made until this is called.
   */
  async create(window: WindowRef): Promise<WorkspaceRef> {
    return this.control.run(async () => {
      const client = await this.open();
      const record = this.registry.allocate(window, null);
      try {
        await client.branch.fork(record.branch, this.options.baseBranch);
      } catch (error) {
        this.registry.drop(record.ref);
        throw refusal(
          error,
          "workspace.create.fork",
          `workspace ${record.ref} could not be forked from ${this.options.baseBranch}`,
          `check that the LayerFS project ${this.options.project} has the Branch ${this.options.baseBranch}`,
        );
      }
      return record.ref;
    });
  }

  /**
   * Fork for a continuation. The new workspace's Branch is forked from the
   * previous one's head, which is metadata: no file is copied.
   */
  async fork(from: WorkspaceRef, window: WindowRef): Promise<WorkspaceRef> {
    return this.control.run(async () => {
      const client = await this.open();
      const parent = this.recordOf(from);
      const record = this.registry.allocate(window, from);
      try {
        await client.branch.fork(record.branch, parent.branch);
      } catch (error) {
        this.registry.drop(record.ref);
        throw refusal(
          error,
          "workspace.fork.fork",
          `workspace ${record.ref} could not be forked from ${from}`,
          `check that workspace ${from} still has its Branch ${parent.branch} in the LayerFS project`,
        );
      }
      return record.ref;
    });
  }

  /**
   * Snapshot the directory's state, recorded at one event.
   *
   * A mounted workspace is committed first, so the snapshot is the state the
   * agent left it in; a workspace nothing is mounted in is already at its
   * Branch head. Recording the same event twice answers with the snapshot it
   * already has: an append and its snapshot are two steps, and a retry must
   * not fork the history.
   */
  async snapshot(workspace: WorkspaceRef, at?: EventRef): Promise<SnapshotHandle> {
    const event: EventRef | "latest" = at ?? "latest";
    if (at !== undefined && !/^r\d+$/.test(at)) {
      throw arborError({
        code: "invalid_input",
        rule: "workspace.snapshot.event",
        message: `an event ref is r<number>, got ${at}`,
        nextAction: "pass the event the change was recorded at, such as r902, or nothing for the latest snapshot",
      });
    }
    return this.control.run(async () => {
      const client = await this.open();
      this.recordOf(workspace);
      const recorded = this.registry.snapshot(workspace, event);
      if (recorded !== null) return { ref: snapshotRefOf(workspace, event), id: recorded.commit };
      const commit = await this.headOf(client, workspace, this.mountedHandleOf(workspace));
      if (commit === null) {
        throw arborError({
          code: "unavailable",
          rule: "workspace.snapshot.empty",
          message: `workspace ${workspace} has no committed state yet, so it has no snapshot`,
          nextAction: "write a file or run a command in the workspace first, then snapshot it",
        });
      }
      const saved = this.registry.recordSnapshot(workspace, event, commit, this.options.now());
      return { ref: snapshotRefOf(workspace, event), id: saved.commit };
    });
  }

  /** The workspace's snapshots, newest first. */
  async snapshots(
    workspace: WorkspaceRef,
    options?: { limit?: number; offset?: number },
  ): Promise<Page<Snapshot>> {
    const limit = clampPage(options?.limit);
    const offset = Math.max(0, Math.trunc(options?.offset ?? 0));
    const recorded = this.registry
      .snapshots(workspace)
      .filter((row): row is SnapshotRecord & { at: EventRef } => row.at !== "latest");
    const items: Snapshot[] = recorded.slice(offset, offset + limit).map((row) => ({
      ref: snapshotRefOf(workspace, row.at),
      event: row.at,
      time: row.time,
    }));
    return {
      items,
      total: recorded.length,
      limit,
      nextCall: `workspace.snapshots(${workspace}, offset=${offset + limit})`,
    };
  }

  /**
   * Mount a workspace or one of its snapshots, read-only by ref.
   *
   * A bare workspace ref is mounted read-write and its changes are committed
   * when it is released; a snapshot ref is mounted read-only through a Branch
   * forked at that snapshot's Commit, and nothing it sees is ever published.
   */
  async mount(ref: WorkspaceRef | SnapshotRef, options?: MountOptions): Promise<WorkspaceMount> {
    const parsed = parse(ref);
    return this.control.run(async () => {
      const client = await this.open();
      const record = this.recordOf(parsed.workspace);
      const readOnly = options?.readOnly ?? parsed.at !== null;
      const branch =
        parsed.at === null ? record.branch : await this.viewBranchOf(client, parsed.workspace, parsed.at);
      const mounted = await this.mountInSandbox(client, branch, parsed.workspace);
      return this.register(client, parsed, readOnly, branch, mounted);
    });
  }

  async diff(from: WorkspaceRef | SnapshotRef, to: WorkspaceRef | SnapshotRef): Promise<WorkspaceDiff> {
    const left = parse(from);
    const right = parse(to);
    return this.control.run(async () => {
      const client = await this.open();
      const fromCommit = await this.commitOfRef(client, left);
      const toCommit = await this.commitOfRef(client, right);
      const files: DiffFile[] = [];
      let cursor: string | undefined;
      for (;;) {
        const page = await client.branch.diff_commits(fromCommit, toCommit, PAGE_SIZE, 0, {
          ...(cursor === undefined ? {} : { cursor }),
        });
        for (const item of page.items) files.push(changeOf(item));
        if (!page.hasMore) break;
        const next = page.nextCursor ?? page.items.at(-1)?.path;
        if (next === undefined || next === null || next === cursor) break;
        cursor = next;
      }
      return { from, to, files };
    });
  }

  async quota(workspace: WorkspaceRef): Promise<WorkspaceQuota> {
    return this.control.run(async () => {
      const client = await this.open();
      const record = this.recordOf(workspace);
      const head = await this.headCommitOf(client, workspace);
      return {
        bytes: this.options.quotaBytes,
        used: head?.logical ?? 0,
        files: await this.countFiles(client, record.branch),
      };
    });
  }

  /**
   * Reclaim the snapshots after the retention period.
   *
   * LayerFS keeps every Branch and Commit it ever made and has no per-Branch
   * delete, so this releases the mounts, drops the refs that resolved them and
   * marks the workspace reclaimed. The history stays in the Store until the
   * project itself is removed.
   */
  async reclaim(workspace: WorkspaceRef): Promise<void> {
    await this.control.run(async () => {
      const active = [...this.mounts.values()].filter((mount) => mount.workspace === workspace);
      for (const mount of active) await this.release(mount.id);
      if (this.registry.workspace(workspace) === null) return;
      this.registry.markReclaimed(workspace, this.options.now());
    });
  }

  /** Release the Store. A workspace whose mount is left mounted keeps it. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const client = this.client;
    this.client = null;
    this.registry.close();
    if (client !== null) await client.close().catch(() => {});
    if (emptyDirectory !== null) await rm(emptyDirectory, { recursive: true, force: true }).catch(() => {});
    emptyDirectory = null;
  }

  private recordOf(workspace: WorkspaceRef) {
    const record = this.registry.workspace(workspace);
    if (record === null) {
      throw arborError({
        code: "not_found",
        rule: "workspace.unknown",
        message: `there is no workspace ${workspace} on this host`,
        nextAction: "create it for the window, or fork it from a workspace that has one",
        refs: [workspace],
      });
    }
    if (record.reclaimedAt !== null) {
      throw arborError({
        code: "refused",
        rule: "workspace.reclaimed",
        message: `workspace ${workspace} was reclaimed after the retention period`,
        nextAction: "create a new workspace, or read the journal's records of what it held",
        refs: [workspace],
      });
    }
    return record;
  }

  /** Open the project, creating it from `deployment.source` on first use. */
  private async open(): Promise<LayerfsClient> {
    if (this.client !== null) return this.client;
    const sdk = this.sdk ?? (await loadLayerfsSdk({ sdk: this.options.sdk }));
    this.sdk = sdk;
    if (sdk === null) {
      throw arborError({
        code: "unavailable",
        rule: "workspace.layerfs.sdk",
        message: "the LayerFS JavaScript packages are not installed on this host",
        nextAction: "run .agents/setup, or set ARBOR_LAYERFS_SDK to the LayerFS checkout's api directory",
      });
    }
    this.applyEnvironment();
    const store = this.options.deployment.storePath ?? process.env.LAYERFS_STORE_PATH;
    if (store === undefined || store === "") {
      throw arborError({
        code: "unavailable",
        rule: "workspace.layerfs.store",
        message: "no LayerFS Store is configured for this workspace",
        nextAction: "set deployment.storePath (LAYERFS_STORE_PATH) to the project's installed Store file",
      });
    }
    try {
      this.client = storeExists(store)
        ? await sdk.LayerFS.open(this.options.project)
        : await sdk.LayerFS.init(
            this.options.project,
            this.options.deployment.source ?? emptySource(),
            this.options.deployment.initTimeoutMs,
          );
    } catch (error) {
      throw refusal(
        error,
        "workspace.layerfs.open",
        `the LayerFS project ${this.options.project} could not be opened`,
        "check LAYERFS_HOME, LAYERFS_STORE_PATH and that the Store is on ext4, xfs or btrfs",
      );
    }
    return this.client;
  }

  /**
   * Map this package's deployment settings onto the SDK's environment names.
   * The SDK has no options argument: it reads `LAYERFS_` names once, when a
   * client is made, so this runs before the first client is.
   */
  private applyEnvironment(): void {
    const names: Record<string, string | undefined> = {
      LAYERFS_HOME: this.options.deployment.home,
      LAYERFS_STORE_PATH: this.options.deployment.storePath,
      LAYERFS_IMAGE: this.options.deployment.image,
      LAYERFS_DAEMON: this.options.deployment.daemon,
      LAYERFS_DOCKER: this.options.deployment.docker,
      LAYERFS_VOLUME: this.options.deployment.volume,
      LAYERFS_CONTAINER_PREFIX: this.options.deployment.containerPrefix,
      LAYERFS_DAEMON_HOST: this.options.deployment.daemonHost,
      LAYERFS_NATIVE: this.options.deployment.addon,
    };
    for (const [name, value] of Object.entries(names)) {
      if (value !== undefined && value !== "") process.env[name] = value;
    }
  }

  /** The Branch a snapshot is read through, forked at its Commit once. */
  private async viewBranchOf(client: LayerfsClient, workspace: WorkspaceRef, at: EventRef | "latest"): Promise<string> {
    const commit =
      at === "latest" ? await this.headOf(client, workspace) : this.registry.snapshot(workspace, at)?.commit;
    if (commit === null || commit === undefined) {
      throw arborError({
        code: "not_found",
        rule: "workspace.snapshot.unknown",
        message: `workspace ${workspace} has no snapshot recorded at ${at}`,
        nextAction: "list its snapshots, or mount the workspace itself for its latest state",
        refs: [snapshotRefOf(workspace, at)],
      });
    }
    const branch = viewBranchNameOf(workspace, at);
    try {
      await client.branch.fork(branch, commit);
    } catch (error) {
      if ((error as LayerfsError).code !== "NameTaken") {
        throw refusal(
          error,
          "workspace.mount.view",
          `the snapshot ${snapshotRefOf(workspace, at)} could not be read`,
          "check that its Commit is still in the LayerFS project",
        );
      }
    }
    return branch;
  }

  /** Mount a Branch in a Sandbox that still has room for one more Workspace. */
  private async mountInSandbox(client: LayerfsClient, branch: string, workspace: WorkspaceRef): Promise<MountedIn> {
    const running = await client.project.list_sandboxes(PAGE_SIZE, 0);
    const free = running.items.find((sandbox) => sandbox.workspaces < WORKSPACES_PER_SANDBOX);
    let sandbox: string;
    if (free !== undefined) {
      sandbox = free.sandbox;
    } else {
      try {
        sandbox = (await client.sandbox.create()).sandbox;
      } catch (error) {
        throw refusal(
          error,
          "workspace.mount.sandbox",
          `no Sandbox could be started for workspace ${workspace}`,
          "check that the Docker Engine is reachable and the image a Sandbox runs is configured and present",
        );
      }
    }
    try {
      const mounted = await client.workspace.mount(sandbox, branch);
      return { sandbox: mounted.sandbox, path: mounted.path };
    } catch (error) {
      throw refusal(
        error,
        "workspace.mount.mount",
        `workspace ${workspace} could not be mounted in Sandbox ${sandbox}`,
        "check that the Docker Engine is reachable and the image a Sandbox runs is present",
      );
    }
  }

  private register(
    client: LayerfsClient,
    parsed: ParsedRef,
    readOnly: boolean,
    branch: string,
    mounted: MountedIn,
  ): WorkspaceMount {
    const handle: LayerfsWorkspaceHandle = { sandbox: mounted.sandbox, path: mounted.path };
    const id = this.nextMountId++;
    const exec = new Mutex();
    const ref: WorkspaceRef | SnapshotRef =
      parsed.at === null ? parsed.workspace : snapshotRefOf(parsed.workspace, parsed.at);
    this.mounts.set(id, {
      id,
      ref,
      workspace: parsed.workspace,
      readOnly,
      branch,
      handle,
      path: mounted.path,
      exec,
    });
    return {
      ref,
      path: mounted.path,
      readOnly,
      exec: async (command: string) => {
        const active = this.mounts.get(id);
        if (active === undefined) {
          throw arborError({
            code: "refused",
            rule: "workspace.mount.released",
            message: "this mount was released, so no command can run in it",
            nextAction: "mount the workspace again and run the command in the new mount",
          });
        }
        return exec.run(async () => {
          try {
            const result = await client.workspace.exec(handle, command);
            return {
              exitCode: result.exitCode,
              stdout: result.stdout,
              stderr: result.stderr,
              truncated: result.truncated,
            };
          } catch (error) {
            throw refusal(
              error,
              "workspace.exec",
              `the command could not run in workspace ${parsed.workspace}`,
              "check that the Sandbox is still running, then run the command again",
            );
          }
        });
      },
      release: async () => {
        await this.release(id);
      },
    };
  }

  /**
   * End one mount. A read-write mount commits first, so nothing the agent did
   * is lost by releasing it; a read-only view is discarded instead, because a
   * view must never publish anything.
   */
  private async release(id: number): Promise<void> {
    const active = this.mounts.get(id);
    if (active === undefined) return;
    this.mounts.delete(id);
    const client = this.client;
    if (client === null) return;
    if (active.readOnly) {
      try {
        await client.workspace.unmount(active.handle, true);
      } catch (error) {
        throw refusal(
          error,
          "workspace.mount.release",
          `the read-only view of ${active.ref} could not be unmounted`,
          "mount it again, or close the Sandbox it was mounted in",
        );
      }
      return;
    }
    await this.headOf(client, active.workspace, active.handle);
    try {
      await client.workspace.unmount(active.handle);
    } catch (error) {
      throw refusal(
        error,
        "workspace.mount.release",
        `workspace ${active.workspace} could not be unmounted`,
        "check whether its Sandbox is still running, then release it again",
      );
    }
  }

  /**
   * The handle of the workspace's own mount, when one is open. A read-only view
   * is never committed, so it is not the workspace's mount.
   */
  private mountedHandleOf(workspace: WorkspaceRef): LayerfsWorkspaceHandle | undefined {
    let found: ActiveMount | undefined;
    for (const mount of this.mounts.values()) {
      if (mount.workspace !== workspace || mount.readOnly) continue;
      if (found === undefined || mount.id > found.id) found = mount;
    }
    return found?.handle;
  }

  /**
   * The Commit a workspace's directory is at. A mounted workspace is committed
   * first; one nothing is mounted in is at its Branch head already.
   */
  private async headOf(
    client: LayerfsClient,
    workspace: WorkspaceRef,
    handle?: LayerfsWorkspaceHandle,
  ): Promise<string | null> {
    if (handle !== undefined) {
      const outcome = await client.workspace.commit(handle).catch((error) => {
        throw refusal(
          error,
          "workspace.commit",
          `the changes in workspace ${workspace} could not be committed`,
          "look at what the Sandbox reports, then snapshot the workspace again",
        );
      });
      return outcome.commit?.id ?? outcome.head;
    }
    return (await this.headCommitOf(client, workspace))?.id ?? null;
  }

  private async headCommitOf(client: LayerfsClient, workspace: WorkspaceRef) {
    const record = this.registry.workspace(workspace);
    const page = await client.branch.list_commits(record?.branch ?? workspace, 1, 0);
    return page.items[0] ?? null;
  }

  /** The Commit a workspace or snapshot ref names, for a diff. */
  private async commitOfRef(client: LayerfsClient, parsed: ParsedRef): Promise<string> {
    const recorded = parsed.at === null ? null : this.registry.snapshot(parsed.workspace, parsed.at);
    if (recorded !== null) return recorded.commit;
    const head = await this.headOf(client, parsed.workspace);
    if (head === null) {
      throw arborError({
        code: "unavailable",
        rule: "workspace.diff.empty",
        message: `workspace ${parsed.workspace} has no committed state, so it cannot be compared`,
        nextAction: "write a file or run a command in it first, then diff it",
      });
    }
    return head;
  }

  /** The regular files in the workspace's tree, counted by walking it. */
  private async countFiles(client: LayerfsClient, branch: string): Promise<number> {
    const ref = branch;
    let files = 0;
    const folders: string[] = ["/"];
    while (folders.length > 0) {
      const folder = folders.pop() as string;
      let offset = 0;
      for (;;) {
        const page = await client.fs.list(ref, folder, PAGE_SIZE, offset);
        for (const entry of page.items) {
          if (entry.type === "file") files += 1;
          else if (entry.type === "directory") folders.push(entry.path);
        }
        offset += page.items.length;
        if (!page.hasMore || page.items.length === 0) break;
      }
    }
    return files;
  }
}

function clampPage(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_PAGE_LIMIT;
  return Math.min(MAX_PAGE_LIMIT, Math.max(1, Math.trunc(limit)));
}

/** One LayerFS change as arbor's `DiffFile`. */
function changeOf(item: {
  path: string;
  kind: "Added" | "Removed" | "Modified";
  hunks: { op: string; text: string }[] | null;
}): DiffFile {
  const status = item.kind === "Added" ? "added" : item.kind === "Removed" ? "removed" : "changed";
  const hunks = item.hunks ?? [];
  if (hunks.length === 0) return { path: item.path, status };
  return {
    path: item.path,
    status,
    added: hunks.filter((line) => line.op === "+").length,
    removed: hunks.filter((line) => line.op === "-").length,
  };
}

function storeExists(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

let emptyDirectory: string | null = null;

/** The source a first Init imports when a deployment names none: nothing. */
function emptySource(): string {
  emptyDirectory ??= mkdtempSync(join(tmpdir(), "arbor-layerfs-source-"));
  return emptyDirectory;
}
