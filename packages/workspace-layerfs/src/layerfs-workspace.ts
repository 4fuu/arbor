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
 * - A command that outlives the call that started it runs as a background job
 *   through LayerFS's daemon process API, exposed as the mount's `jobs`
 *   capability, and is stopped when the mount is released - an unmount with
 *   one still running is refused. Every command that capability starts is
 *   wrapped: the engine observes the process it started with a second command
 *   and refuses one that has already been reaped, so a bare quick command would
 *   never start, and the daemon reports whether a process runs and never how a
 *   command ended, so the wrapper leaves the exit code in the log it is already
 *   writing to. That log is read before the daemon is asked anything, because
 *   the engine proves every process it recorded is still the one it started and
 *   refuses a whole `process.list` when one finished job's pid has been reused:
 *   a status read must not depend on a call one stale record can refuse.
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
  type BackgroundJob,
  type DiffFile,
  type EventRef,
  type MountOptions,
  type Page,
  type Snapshot,
  type SnapshotHandle,
  type SnapshotRef,
  type StagedFile,
  type Workspace,
  type WorkspaceDiff,
  type WorkspaceJobs,
  type WorkspaceMount,
  type WorkspaceQuota,
  type WorkspaceRef,
  type WindowRef,
} from "@arbor/interfaces";
import { mkdtempSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";
import { layerfsCapabilities, type LayerfsCapabilities } from "./capabilities.ts";
import type {
  LayerfsBackendClient,
  LayerfsClient,
  LayerfsError,
  LayerfsWorkspaceHandle,
} from "./layerfs-sdk.ts";
import { loadLayerfsBackend, loadLayerfsSdk } from "./layerfs-sdk.ts";
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
  /**
   * The background commands this mount started, each with the command a caller
   * passed for it, so releasing the mount stops them and a status read names
   * the command without asking the daemon.
   */
  jobs: Map<string, string>;
}

interface MountedIn {
  sandbox: string;
  path: string;
}

/** How many Workspaces one LayerFS Sandbox holds. */
const WORKSPACES_PER_SANDBOX = 16;

/**
 * Where staged files live inside a Sandbox: beside the mount, in the
 * container's own writable layer, never inside the Workspace's tree.
 *
 * `/tmp` is the container's home and the one place its unprivileged command
 * identity can always write; the container's root is not, which is why the
 * files cannot simply be staged at the prefix a window reads them at.
 */
const STAGE_ROOT = "/tmp/arbor-env";

/**
 * How much of a background job's output this package hands back: the last
 * 256 KiB, read in one command. A command that writes more than that keeps
 * its own log in the Sandbox; the bound is what one read costs.
 */
const JOB_OUTPUT_BYTES = 262144;

/**
 * How long a wrapped command holds its process open after the command has
 * ended.
 *
 * LayerFS starts a background command and then observes the process it started
 * with a second command inside the Sandbox, which reads `/proc/<pid>/stat`. A
 * command that has already ended by then is refused, because the Sandbox's
 * first process - docker-init on a Docker host - has reaped it and its `/proc`
 * entry is gone: "background process exited before its identity was observed".
 * Ordinary quick commands - `ls`, `cat` - end long before that second command
 * lands, so every one of them would be refused.
 *
 * The observation happens inside the same call that starts the command, so a
 * pause of a couple of seconds is far longer than the one command the engine
 * needs; the process is gone before anything else could want it, and a mount
 * that is released stops whatever it started anyway. A command that outlives
 * the pause keeps running: the pause only follows the command's end.
 */
const JOB_TAIL_SECONDS = 2;

/**
 * The line a wrapped command ends with: its exit code, after a record
 * separator, so no ordinary output is mistaken for it. It is the last thing a
 * command writes, so the bounded read of the log always carries it, and the
 * caller takes the code off it and hands back the output without it.
 */
const EXIT_MARK = "\u001e";

/**
 * The log a background process writes inside its Sandbox. LayerFS's daemon
 * starts one with its streams redirected there, and the Sandbox's own command
 * identity can read it, so the output comes back through one command in the
 * same mount - a Workspace's uncommitted files are not readable any other
 * way.
 */
function logPathOf(job: string): string {
  return `/tmp/layerfs-${job}.log`;
}

/**
 * One command as a background job runs it: the command itself, its exit code
 * recorded in the log the daemon keeps for it, and a pause that keeps the
 * process observable long enough for the engine to see it (`JOB_TAIL_SECONDS`).
 *
 * The command is passed as base64 and decoded inside, so no byte of it is read
 * as the wrapper's own syntax - a command may hold quotes, `$`, backticks and
 * newlines. What it writes goes to the log the daemon redirected, which is
 * where its exit code lands too, one line at the end.
 */
function jobScript(command: string): string {
  const encoded = Buffer.from(command, "utf8").toString("base64");
  return [
    `bash -c "$(printf '%s' ${encoded} | base64 -d)"`,
    // The command's own exit, not the wrapper's: what follows must not change it.
    `code=$?`,
    `printf '\\n\\036%s\\n' "$code"`,
    `sleep ${JOB_TAIL_SECONDS}`,
    `exit "$code"`,
  ].join("\n");
}

/** A log's exit code, and the log without the line that carried it. */
function exitOf(log: string): { exitCode: number | undefined; output: string } {
  const at = log.lastIndexOf(EXIT_MARK);
  const code = at < 0 ? "" : log.slice(at + 1);
  if (!/^\d+\n?$/.test(code)) return { exitCode: undefined, output: log };
  // The line the wrapper wrote is dropped with the newline that opened it, so
  // what is left is exactly what the command wrote.
  const output = log.slice(0, at).replace(/\n$/, "");
  return { exitCode: Number(code.trim()), output };
}

/**
 * One command that stages files into a Sandbox and makes them read-only.
 *
 * Every file is written from base64, so no byte of a skill, a script or a
 * configuration can be read as shell syntax, and the write bits are dropped
 * last, so a command that follows cannot change what was staged. A Sandbox
 * runs `bash -c`, and the image carries coreutils, so `base64` is there.
 */
function stageScript(at: string, files: readonly StagedFile[]): string {
  const lines = [
    // A staging that follows another one first makes what it finds writable
    // again: `chmod -R a-w` takes the write bit off the directories too, and a
    // directory without it cannot have its entries removed. A first staging
    // finds nothing there, which is why the error is not one.
    `chmod -R u+w ${quotePath(at)} 2>/dev/null`,
    `rm -rf ${quotePath(at)}`,
    `mkdir -p ${quotePath(at)}`,
  ];
  for (const file of files) {
    const target = `${at}/${file.path}`;
    lines.push(`mkdir -p ${quotePath(dirname(target))}`);
    lines.push(`printf '%s' ${Buffer.from(file.text, "utf8").toString("base64")} | base64 -d > ${quotePath(target)}`);
  }
  lines.push(`chmod -R a-w ${quotePath(at)}`);
  return lines.join("\n");
}

/** One path quoted for the shell, so a space or a quote in it survives. */
function quotePath(path: string): string {
  return `'${path.replace(/'/g, "'\\''")}'`;
}

/** A path's last component. */
function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

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

/**
 * The refusal LayerFS answers when it can no longer prove that a process it
 * recorded is the one it started: it reads the process's start time from
 * `/proc/<pid>/stat` and refuses one that does not match, which is what a
 * finished job whose pid a later group leader reused looks like. Its
 * `process.list` proves every record it holds that way, so a single stale
 * record refuses the whole call - and the status read of every job in the
 * Sandbox with it.
 */
function staleIdentity(error: unknown): boolean {
  const refused = error as { code?: unknown; message?: unknown };
  return (
    refused.code === "Unknown" &&
    typeof refused.message === "string" &&
    refused.message.includes("process group identity is no longer provable")
  );
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
  private backend: LayerfsBackendClient | null = null;
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
    const active: ActiveMount = {
      id,
      ref,
      workspace: parsed.workspace,
      readOnly,
      branch,
      handle,
      path: mounted.path,
      exec,
      jobs: new Map<string, string>(),
    };
    this.mounts.set(id, active);
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
      /**
       * Read one file over LayerFS's own `fs.read`, which answers the
       * workspace's committed state - what its last snapshot holds - without a
       * command in the Sandbox. `null` is a file that is not there.
       */
      readFile: async (path: string): Promise<string | null> => {
        const target = layerfsPathOf(mounted.path, path);
        if (target === null) return null;
        try {
          const read = await client.fs.read(branch, target);
          return read.text;
        } catch (error) {
          // A path that is not there, and one that is a folder, are the same
          // answer the host path gives: nothing to read.
          const code = (error as LayerfsError).code;
          if (code === "NoSuchPath" || code === "NotFile") return null;
          throw refusal(
            error,
            "workspace.read",
            `the file ${path} could not be read in workspace ${parsed.workspace}`,
            "check that the workspace still holds the file, then read it again",
          );
        }
      },
      /**
       * Write one file over LayerFS's own `fs.write`, which publishes the
       * write as a Commit on the workspace's Branch, so the next snapshot
       * holds it. A view refuses: it must never publish anything.
       */
      writeFile: async (path: string, text: string): Promise<void> => {
        if (readOnly) {
          throw arborError({
            code: "refused",
            rule: "mount.readonly",
            message: `${ref} is a read-only view, so nothing can be written in it`,
            nextAction: "mount the workspace itself to write in it",
            refs: [ref],
          });
        }
        const target = layerfsPathOf(mounted.path, path);
        if (target === null || target === "/") {
          throw arborError({
            code: "refused",
            rule: "file.outside_workspace",
            message: `${path} is not inside workspace ${parsed.workspace}`,
            nextAction: "pass a path inside the workspace, such as notes.txt",
            refs: [ref],
          });
        }
        const folder = dirname(target);
        const message = `write ${target}`;
        try {
          // The parent is made first: a write creates its directory, and a
          // folder that is already there publishes nothing.
          if (folder !== "/") await client.fs.mkdir(branch, folder, message);
          await client.fs.write(branch, target, text, message);
        } catch (error) {
          throw refusal(
            error,
            "workspace.write",
            `the file ${path} could not be written in workspace ${parsed.workspace}`,
            "look at what LayerFS reports, then write the file again",
          );
        }
      },
      release: async () => {
        await this.release(id);
      },
      // A read-only view starts nothing: it must never publish anything, and a
      // command that ran in it would write in the workspace it views.
      ...(readOnly ? {} : { jobs: this.jobsOf(active) }),
      // The environment is staged beside the mount, never inside it.
      ...(readOnly ? {} : { stage: this.stageOf(active) }),
    };
  }

  /**
   * Stage files into the mount's execution environment, outside the Workspace.
   *
   * The staged files are the shared environment, which lives on the host and
   * which a window reads at `/env` (docs/environment.md#layout). A Sandbox
   * cannot mount a host directory - its only volume is the project's Store -
   * and its command identity is an unprivileged user that cannot write at the
   * container's root, so the files are written beside the mount, in the
   * container's own writable layer, and the caller rewrites the prefix onto
   * where they landed.
   *
   * They are written outside the Workspace's tree, so no Commit holds them: a
   * snapshot, a fork, a diff and a read-only view never see them. They are
   * read-only once staged, because a change goes through the environment's own
   * draft and `reload`.
   */
  private stageOf(active: ActiveMount) {
    return async (prefix: string, files: readonly StagedFile[]): Promise<string> => {
      const client = this.client;
      if (client === null) throw this.noClient();
      // One directory per Workspace, beside the mount: a Sandbox holds up to
      // sixteen, and two windows staging at one path would overwrite each other.
      const at = `${STAGE_ROOT}/${basename(active.path)}`;
      try {
        await client.workspace.exec(active.handle, stageScript(at, files));
      } catch (error) {
        throw refusal(
          error,
          "workspace.stage",
          `the files under ${prefix} could not be staged for workspace ${active.workspace}`,
          "check that the Sandbox still runs, then run the command again",
        );
      }
      // The caller rewrites the prefix onto this: a Sandbox's command identity
      // cannot write at the container's root, so the files cannot be staged at
      // the prefix itself.
      return at;
    };
  }

  /** Why this mount has no execution environment: the SDK is not installed. */
  private noClient(): ReturnType<typeof arborError> {
    return arborError({
      code: "unavailable",
      rule: "workspace.layerfs.sdk",
      message: "the LayerFS JavaScript packages are not installed on this host",
      nextAction: "run .agents/setup, or set ARBOR_LAYERFS_SDK to the LayerFS checkout's api directory",
    });
  }

  /**
   * Background commands in one mount, over LayerFS's daemon process API.
   *
   * `backend.daemon.process.*` is the part of the SDK the agent's own client
   * refuses: it starts a command in its own session inside the Sandbox, keeps
   * it after the call returns, and lists or cancels it. Its output is the log
   * the daemon redirects it to, read back with one command in this mount.
   *
   * Every command is wrapped (`jobScript`): a bare quick command would be
   * refused, because the engine observes the process it started with a second
   * command and a Sandbox's first process reaps one that has already ended.
   * The wrapper's exit-code line is what makes a finished command answerable:
   * the daemon reports whether a process still runs and never how it ended, so
   * the code comes back in the log and a job that carries it is answered as
   * ended even while its pause keeps the process observable.
   *
   * The log is read before the daemon is asked anything, because one finished
   * job can refuse every status read in its Sandbox: the engine proves each
   * process it recorded is still the one it started, and a finished job whose
   * pid a later group leader reused is not, so its `process.list` is refused
   * outright (`staleIdentity`). A job that carries the exit-code line answers
   * from the log alone, and one that does not is answered as still running
   * rather than with the refusal - `bash` reads a job while it waits, so the
   * refusal would otherwise reach the model instead of the command's output.
   */
  private jobsOf(active: ActiveMount): WorkspaceJobs {
    return {
      start: async (command: string): Promise<BackgroundJob> => {
        const backend = await this.backendOf();
        if (backend === null) throw this.noBackend(active.ref);
        try {
          const started = await backend.daemon.process.start(active.handle, jobScript(command));
          active.jobs.set(started.process, command);
          // The daemon answers with the script it ran; the command a caller
          // passed is the one it asked for.
          return { id: started.process, command, running: true, output: "" };
        } catch (error) {
          throw refusal(
            error,
            "workspace.job.start",
            `a background command could not be started in workspace ${active.workspace}`,
            "check that the Sandbox still runs, then start the command again",
          );
        }
      },
      output: async (job: string): Promise<BackgroundJob> => {
        const backend = await this.backendOf();
        if (backend === null) throw this.noBackend(active.ref);
        const log = await this.jobOutput(active.handle, job);
        const ended = exitOf(log);
        // The answer is already known: the wrapper's exit-code line is the
        // command's own, so it needs nothing the daemon has to say.
        if (ended.exitCode !== undefined) {
          return {
            id: job,
            command: active.jobs.get(job) ?? "",
            running: false,
            output: ended.output,
            exitCode: ended.exitCode,
          };
        }
        let found: { command: string; running: boolean } | undefined;
        try {
          const page = await backend.daemon.process.list(PAGE_SIZE, 0);
          const listed = page.items.find((item) => item.id === job);
          if (listed !== undefined) found = { command: listed.command, running: listed.status === "running" };
        } catch (error) {
          // One stale record refuses the whole list call, and with it the
          // status read of every job in the Sandbox. A command this mount
          // started has written no exit code, so it is still running: that is
          // what its log says, and what the daemon was asked to confirm. Every
          // other refusal is the Sandbox's own, and is reported as one.
          if (!staleIdentity(error) || !active.jobs.has(job)) {
            throw refusal(
              error,
              "workspace.job.list",
              `the background commands of workspace ${active.workspace} could not be listed`,
              "check that the Sandbox still runs, then read the command's output again",
            );
          }
          return { id: job, command: active.jobs.get(job) ?? "", running: true, output: ended.output };
        }
        // A job this mount never started is not followed: its id names another
        // Sandbox, or one that is gone.
        if (found === undefined && !active.jobs.has(job)) {
          throw arborError({
            code: "not_found",
            rule: "workspace.job.unknown",
            message: `workspace ${active.workspace} has no background job ${job}`,
            nextAction: "start the command again with bash, then follow the job it names",
            refs: [active.ref],
          });
        }
        // The daemon holds a record of the job, or this mount started one it no
        // longer holds. Either way the job has written no exit code, so what the
        // daemon says about its process is the whole answer.
        return {
          id: job,
          command: active.jobs.get(job) ?? found?.command ?? "",
          running: found?.running ?? false,
          output: log,
        };
      },
      stop: async (job: string): Promise<void> => {
        // A command that already ended - its exit-code line is in the log - is
        // left alone: the engine's own cancel answers Stopped for a process
        // that is no longer alive, and a stale record refuses the call instead,
        // so signalling an ended command is neither needed nor possible. It
        // stays in the mount's bookkeeping, because its process holds itself
        // open for a moment after the line and releasing the mount stops it
        // then, exactly as it stops a command that is still running.
        const ended = exitOf(await this.jobOutput(active.handle, job)).exitCode !== undefined;
        if (ended) return;
        await this.cancelJob(job);
        active.jobs.delete(job);
      },
    };
  }

  /** Stop one background command through the daemon's process API. */
  private async cancelJob(job: string): Promise<void> {
    const backend = await this.backendOf();
    if (backend === null) throw this.noBackend();
    try {
      await backend.daemon.process.cancel(job);
    } catch (error) {
      throw refusal(
        error,
        "workspace.job.stop",
        `the background command ${job} could not be stopped`,
        "check that the Sandbox still runs, then stop the command again",
      );
    }
  }

  /** Why no background command can run: the checkout carries no backend package. */
  private noBackend(ref?: WorkspaceRef | SnapshotRef): ReturnType<typeof arborError> {
    return arborError({
      code: "unavailable",
      rule: "workspace.job.backend",
      message:
        `the LayerFS checkout has no @layerfs/backend, so no background command can run` +
        (ref === undefined ? "" : ` in ${ref}`),
      nextAction: "run npm install in the LayerFS checkout's api directory, then mount the workspace again",
      ...(ref === undefined ? {} : { refs: [ref] }),
    });
  }

  /** The last bytes of a background job's log, read with one command in its mount. */
  private async jobOutput(handle: LayerfsWorkspaceHandle, job: string): Promise<string> {
    const client = this.client;
    if (client === null) return "";
    try {
      const read = await client.workspace.exec(handle, `tail -c ${JOB_OUTPUT_BYTES} ${logPathOf(job)}`);
      return read.stdout;
    } catch {
      // A log that is not there yet is a command that has written nothing.
      return "";
    }
  }

  /** The backend client of the open SDK client, or null when the checkout has none. */
  private async backendOf(): Promise<LayerfsBackendClient | null> {
    const client = this.client;
    if (client === null) {
      throw arborError({
        code: "unavailable",
        rule: "workspace.layerfs.sdk",
        message: "the LayerFS JavaScript packages are not installed on this host",
        nextAction: "run .agents/setup, or set ARBOR_LAYERFS_SDK to the LayerFS checkout's api directory",
      });
    }
    this.backend ??= await loadLayerfsBackend(client, { sdk: this.options.sdk });
    return this.backend;
  }

  /**
   * End one mount. A read-write mount commits first, so nothing the agent did
   * is lost by releasing it; a read-only view is discarded instead, because a
   * view must never publish anything.
   *
   * A background command still running there is stopped first: LayerFS refuses
   * to unmount a Workspace whose daemon still holds a process it started, and
   * a command the host never stopped would keep the Workspace - and its
   * Sandbox - alive. A cancel that fails is left to the unmount that follows,
   * which reports what is still holding the Workspace.
   */
  private async release(id: number): Promise<void> {
    const active = this.mounts.get(id);
    if (active === undefined) return;
    this.mounts.delete(id);
    const client = this.client;
    if (client === null) return;
    for (const job of [...active.jobs.keys()]) {
      await this.cancelJob(job).catch(() => {});
      active.jobs.delete(job);
    }
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
          // LayerFS names a folder "dir"; anything that is not a file and not
          // a folder - a symbolic link - is not walked.
          if (entry.type === "file") files += 1;
          else if (entry.type === "dir") folders.push(entry.path);
        }
        offset += page.items.length;
        if (!page.hasMore || page.items.length === 0) break;
      }
    }
    return files;
  }
}

/**
 * One tool path as the LayerFS path it names inside the mounted workspace, or
 * null when it escapes it. The rules are the host path's own: an absolute
 * path is taken as it is, a relative one resolves against the mount's
 * directory, and the result must be that directory or something inside it.
 * LayerFS paths start at the workspace root, so the mount's directory is
 * stripped.
 */
function layerfsPathOf(root: string, path: string): string | null {
  if (path === "") return null;
  const wanted = isAbsolute(path) ? normalize(path) : resolve(root, path);
  if (wanted !== root && !wanted.startsWith(`${root}/`)) return null;
  return wanted === root ? "/" : wanted.slice(root.length);
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
