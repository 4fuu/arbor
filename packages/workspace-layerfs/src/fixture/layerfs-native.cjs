// The stand-in native binding for the LayerFS SDK: one in-memory Store, one
// set of Sandboxes, no Docker, no FUSE and no filesystem. The answers below
// are the shapes the real binding returns - a Commit as
// layerfs-bridge's `commit_value` builds it, a mount as `layerfs-api`'s
// `values::mounted` plus the binding's own sandbox, container and image, a
// listed change as `layerfs-store-service`'s `compare::change` builds it - so
// the tests drive the real `@layerfs/agent` JavaScript against a Store that
// behaves like the one a host runs.
//
// `node --test` loads this file through the SDK's LAYERFS_NATIVE, so the
// package's own tests need no Rust build and no Docker. Everything the real
// binding would refuse is refused with the same code, and `exports.state`,
// `exports.calls` and the helpers at the bottom let a test inspect and seed it.

const MAIN_BASE = "layer0000000000aa";
const MAIN_LAYER = "layer0000000000aa";

const state = {
  branches: new Map(),
  commits: new Map(),
  files: new Map(),
  sandboxes: [],
  mounts: new Map(),
  diffs: new Map(),
  refusals: new Map(),
  processes: new Map(),
  stale: new Set(),
  container: new Map(),
  initialized: false,
  calls: [],
  serial: 0,
};

const hex = (length) => "a".repeat(length);
const nextSerial = () => {
  state.serial += 1;
  return state.serial;
};

const commitId = () => `commit${hex(58)}${nextSerial().toString(16).padStart(2, "0")}`;
const branchId = () => `branch${hex(58)}${nextSerial().toString(16).padStart(2, "0")}`;
const layerId = () => `layer${hex(58)}${nextSerial().toString(16).padStart(2, "0")}`;

const refused = (code, message, detail = null) => ({ refused: { code, message, detail } });
const value = (body) => ({ value: body });

/** The exit a command answers with. */
const exit = (code, stdout = "", stderr = "") => value({ kind: `exit:${code}`, exitCode: code, stdout, stderr, truncated: false });

/**
 * How long the engine takes to observe a background process, in the seconds a
 * command must outlast to be seen. The engine starts a command, then reads
 * `/proc/<pid>/stat` in a second command inside the Sandbox; a process the
 * Sandbox's first process - docker-init on a Docker host - has already reaped
 * is refused, because its `/proc` entry is gone. A command that sleeps past the
 * observation survives it, and one that does not - `ls`, `cat`, a bare
 * `printf` - is refused with exactly that.
 */
const OBSERVE_SECONDS = 1;

/** The longest a command sleeps, which is how long its process stays observable. */
function observable(command) {
  const sleeps = [...command.matchAll(/\bsleep (\d+(?:\.\d+)?)/g)].map((match) => Number(match[1]));
  return Math.max(0, ...sleeps) >= OBSERVE_SECONDS;
}

/** One Sandbox's own filesystem, outside every Workspace it holds. */
const containerOf = (sandbox) => {
  let files = state.container.get(sandbox);
  if (files === undefined) {
    files = new Map();
    state.container.set(sandbox, files);
  }
  return files;
};

/** The commands a staged file is written and read with, answered from the container's own filesystem. */
function containerExec(sandbox, command) {
  // A staging call is a whole script: every line runs in order, and the answer
  // is the last one, the way `bash -c` reports a script's exit.
  let answer = null;
  for (const line of command.split("\n")) {
    const step = containerLine(sandbox, line);
    if (step === null) return null;
    answer = step;
    if (step.value?.exitCode !== 0) return step;
  }
  return answer;
}

/** One command against the container's own filesystem, or null when it is not one. */
function containerLine(sandbox, command) {
  const files = containerOf(sandbox);
  const clean = /^rm -rf '([^']+)'$/.exec(command);
  if (clean !== null) {
    const root = `${clean[1]}/`;
    const kept = [...files.keys()].filter((path) => path === clean[1] || path.startsWith(root));
    // A directory whose write bit is off cannot have its entries removed, so a
    // staging makes what it finds writable first.
    if (kept.some((path) => files.get(path)?.readOnly)) {
      return exit(1, "", `rm: cannot remove '${clean[1]}': Permission denied`);
    }
    for (const path of kept) files.delete(path);
    return exit(0);
  }
  const make = /^mkdir -p '?([^']+)'?$/.exec(command);
  if (make !== null) return exit(0);
  const write = /^printf '%s' (\S+) \| base64 -d > '?([^']+)'?$/.exec(command);
  if (write !== null) {
    const path = write[2];
    // Staged files are read-only, so a command cannot change them.
    if (files.get(path)?.readOnly) return exit(1, "", `bash: ${path}: Permission denied`);
    files.set(path, { text: Buffer.from(write[1], "base64").toString("utf8"), readOnly: false });
    return exit(0);
  }
  const readOnly = /^chmod -R a-w '?([^']+)'?$/.exec(command);
  if (readOnly !== null) {
    const root = `${readOnly[1]}/`;
    for (const [path, entry] of files) if (path === readOnly[1] || path.startsWith(root)) entry.readOnly = true;
    return exit(0);
  }
  // What a staging that follows another one does first: a directory whose
  // write bit is off cannot have its entries removed.
  const writable = /^chmod -R u\+w '?([^']+)'? 2>\/dev\/null$/.exec(command);
  if (writable !== null) {
    const root = `${writable[1]}/`;
    for (const [path, entry] of files) if (path === writable[1] || path.startsWith(root)) entry.readOnly = false;
    return exit(0);
  }
  const read = /^cat '?([^']+)'?$/.exec(command);
  if (read !== null) {
    const entry = files.get(read[1]);
    if (entry === undefined) return exit(1, "", `cat: ${read[1]}: No such file or directory`);
    return exit(0, entry.text);
  }
  return null;
}

function reset() {
  state.branches.clear();
  state.commits.clear();
  state.files.clear();
  state.sandboxes.length = 0;
  state.mounts.clear();
  state.diffs.clear();
  state.refusals.clear();
  state.processes.clear();
  state.stale.clear();
  state.container.clear();
  state.initialized = false;
  state.calls.length = 0;
  state.serial = 0;
  state.branches.set("main", {
    name: "main",
    id: null,
    base: MAIN_BASE,
    head: null,
    forkedFrom: null,
    commits: [],
  });
  state.files.set("main", new Map());
}

const logicalOf = (branch) => {
  let bytes = 0;
  for (const entry of state.files.get(branch)?.values() ?? []) bytes += entry.size;
  return bytes;
};

/** One write, as the real Store would publish it. Returns the new Commit id. */
function write(branch, path, text, message = "write") {
  const record = state.branches.get(branch);
  if (record === undefined) throw new Error(`no such branch ${branch}`);
  const files = state.files.get(branch) ?? new Map();
  state.files.set(branch, files);
  files.set(path, { type: "file", size: Buffer.byteLength(text, "utf8"), mode: 0o644, text });
  const id = commitId();
  const commit = {
    id,
    branch,
    parent: record.head,
    secondParent: null,
    base: record.base,
    root: hex(64),
    via: "sdk.write",
    message,
    mergedFrom: null,
    time: 1_700_000_000_000 + nextSerial(),
    logical: logicalOf(branch),
    newCanonical: Buffer.byteLength(text, "utf8"),
    newStored: Buffer.byteLength(text, "utf8"),
    newMetadata: 64,
    displaced: null,
  };
  state.commits.set(id, commit);
  record.commits.unshift(id);
  record.head = id;
  return id;
}

const headOf = (branch) => state.branches.get(branch)?.head ?? null;

const branchNames = () => [...state.branches.keys()].sort();

function seedDiff(from, to, items) {
  state.diffs.set(`${from}..${to}`, items);
}

function refuse(op, code, message) {
  state.refusals.set(op, { code, message });
}

const childrenOf = (branch, folder) => {
  const files = state.files.get(branch) ?? new Map();
  const prefix = folder === "/" ? "/" : `${folder.replace(/\/$/, "")}/`;
  const seen = new Map();
  for (const [path, entry] of files) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    if (rest === "") continue;
    const slash = rest.indexOf("/");
    const name = slash < 0 ? rest : rest.slice(0, slash);
    const child = slash < 0 ? prefix + name : `${prefix}${name}/`;
    if (seen.has(child)) continue;
    seen.set(child, slash < 0 ? { type: entry.type, size: entry.size, mode: entry.mode } : { type: "dir" });
  }
  return [...seen.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
};

function answer(op, args) {
  const refusalFor = state.refusals.get(op);
  if (refusalFor !== undefined) return refused(refusalFor.code, refusalFor.message, { op });

  switch (op) {
    case "project.init": {
      if (state.initialized) return refused("Exists", `project ${args.name} already exists`);
      state.initialized = true;
      return value({ kind: "Initialized", project: args.name, layer: layerId(), root: hex(64), store: args.storePath });
    }
    case "project.list_branches": {
      const items = [...state.branches.values()].map((branch) => ({
        name: branch.name,
        id: branch.id,
        base: branch.base,
        head: branch.head,
        forkedFrom: branch.forkedFrom,
      }));
      return value({ items, hasMore: false, nextPagePos: null });
    }
    case "branch.fork": {
      const { name, from = "main" } = args;
      if (name === "main") return refused("ReservedName", '"main" names the project\'s main line');
      if (state.branches.has(name)) return refused("NameTaken", `Branch ${name} already exists`);
      const source = state.branches.get(from) ?? state.commits.get(from);
      const base = layerId();
      const head = source === undefined ? null : (source.head ?? (source.id ?? null));
      state.branches.set(name, {
        name,
        id: branchId(),
        base,
        head,
        forkedFrom: from,
        commits: head === null ? [] : [head],
      });
      // Forking from a Commit copies the files of the Branch that holds it,
      // which is what a read-only view of a snapshot reads.
      const sourceFiles =
        state.files.get(from) ?? (source?.branch === undefined ? undefined : state.files.get(source.branch));
      const copied = new Map(sourceFiles ?? new Map());
      state.files.set(name, copied);
      return value({ kind: "Forked", branch: name, base, head });
    }
    case "branch.list_commits": {
      const record = state.branches.get(args.branch);
      if (record === undefined) return refused("NoSuchBranch", `no Branch ${args.branch}`);
      const items = record.commits.map((id) => state.commits.get(id)).filter(Boolean);
      const size = args.pageSize ?? 50;
      const pos = args.pagePos ?? 0;
      return value({ items: items.slice(pos, pos + size), hasMore: pos + size < items.length, nextPagePos: null });
    }
    case "branch.diff_commits": {
      const key = `${args.from}..${args.to}`;
      if (!state.diffs.has(key)) return value({ kind: "ok", from: { commit: args.from, root: hex(64) }, to: { commit: args.to, root: hex(64) }, items: [], hasMore: false, nextPagePos: null, nextCursor: null });
      const items = state.diffs.get(key);
      const size = args.pageSize ?? 50;
      const pos = args.pagePos ?? 0;
      return value({ kind: "ok", from: { commit: args.from, root: hex(64) }, to: { commit: args.to, root: hex(64) }, items: items.slice(pos, pos + size), hasMore: false, nextPagePos: null, nextCursor: null });
    }
    case "fs.list": {
      const record = state.branches.get(args.branch);
      if (record === undefined) return refused("NoSuchBranch", `no Branch ${args.branch}`);
      const folder = args.path ?? "/";
      const entries = childrenOf(args.branch, folder);
      const size = args.pageSize ?? 50;
      const pos = args.pagePos ?? 0;
      const items = entries.slice(pos, pos + size).map(([path, entry], index) => ({
        name: path.replace(/\/$/, "").split("/").pop(),
        path,
        type: entry.type,
        inode: 1000 + pos + index,
      }));
      return value({ items, hasMore: pos + size < entries.length, nextPagePos: null });
    }
    case "fs.stat": {
      const record = state.branches.get(args.branch);
      if (record === undefined) return refused("NoSuchBranch", `no Branch ${args.branch}`);
      const entry = (state.files.get(args.branch) ?? new Map()).get(args.path);
      if (entry === undefined) return refused("NoSuchPath", `${args.path} does not exist`);
      return value({ type: entry.type, inode: 1001, size: entry.size, mode: entry.mode, path: args.path });
    }
    case "fs.read": {
      const record = state.branches.get(args.branch);
      if (record === undefined) return refused("NoSuchBranch", `no Branch ${args.branch}`);
      const entry = (state.files.get(args.branch) ?? new Map()).get(args.path);
      if (entry === undefined) return refused("NoSuchPath", `${args.path} does not exist`);
      if (entry.type !== "file") return refused("NotFile", `${args.path} is not a file`);
      return value({
        kind: "ok",
        snapshot: `${args.branch}@${hex(12)}`,
        root: hex(64),
        path: args.path,
        text: entry.text ?? "",
        startLine: args.startLine ?? 1,
        endLine: args.startLine ?? 1,
        lineTruncated: false,
        truncated: false,
        nextLine: null,
        size: entry.size,
      });
    }
    case "fs.write": {
      const record = state.branches.get(args.branch);
      if (record === undefined) return refused("NoSuchBranch", `no Branch ${args.branch}`);
      const text =
        typeof args.content === "string"
          ? args.content
          : Buffer.from(args.bytes.base64, "base64").toString("utf8");
      const id = write(args.branch, args.path, text, args.message ?? "write");
      return value({ kind: "Committed", head: id, commit: state.commits.get(id) });
    }
    case "fs.mkdir": {
      const record = state.branches.get(args.branch);
      if (record === undefined) return refused("NoSuchBranch", `no Branch ${args.branch}`);
      const files = state.files.get(args.branch) ?? new Map();
      state.files.set(args.branch, files);
      // recursive: every missing parent is made, as the real call does.
      let folder = "";
      for (const part of args.path.split("/").filter(Boolean)) {
        folder += `/${part}`;
        if (!files.has(folder)) files.set(folder, { type: "dir", size: 0, mode: 0o755, text: "" });
      }
      return value({ kind: "Committed", head: headOf(args.branch), commit: null });
    }
    case "sandbox.create": {
      const used = new Set(state.sandboxes.map((sandbox) => Number(sandbox.sandbox)));
      let number = 1;
      while (used.has(number)) number += 1;
      const sandbox = {
        sandbox: String(number),
        name: `layerfs-${args.project}-${number}`,
        image: args.deploy?.image ?? "sha256:" + hex(64),
        workspaces: 0,
      };
      state.sandboxes.push(sandbox);
      return value({ sandbox: sandbox.sandbox, name: sandbox.name, image: sandbox.image });
    }
    case "project.list_sandboxes":
      return value({ kind: "ok", items: state.sandboxes.map((sandbox) => ({ ...sandbox })) });
    case "workspace.mount": {
      const sandbox = state.sandboxes.find((item) => item.sandbox === args.sandbox);
      if (sandbox === undefined) return refused("NoSuchSandbox", `the project has no Sandbox ${args.sandbox}`);
      if (sandbox.workspaces >= 16) return refused("Capacity", `Sandbox ${args.sandbox} already holds 16 Workspaces`);
      const record = state.branches.get(args.branch);
      if (record === undefined) return refused("NoSuchBranch", `no Branch ${args.branch}`);
      const path = `/workspaces/${sandbox.sandbox}-${nextSerial()}`;
      sandbox.workspaces += 1;
      state.mounts.set(path, { sandbox: args.sandbox, path, branch: args.branch, dirty: false });
      return value({
        kind: "Mounted",
        path,
        workspace: hex(32),
        namespace: nextSerial(),
        branch: args.branch,
        base: record.head,
        baseLayer: record.base,
        root: hex(64),
        sandbox: args.sandbox,
        container: sandbox.name,
        image: sandbox.image,
      });
    }
    case "workspace.exec": {
      const mount = state.mounts.get(args.path);
      if (mount === undefined) return refused("NoSuchWorkspace", `no Workspace at ${args.path}`);
      const command = args.command ?? "";
      // The log a background process writes, read back the way this package
      // reads it: the last bytes of `/tmp/layerfs-<id>.log`.
      const log = /^tail -c (\d+) \/tmp\/layerfs-([^ ]+)\.log$/.exec(command);
      if (log !== null) {
        const text = state.processes.get(log[2])?.log ?? "";
        const kept = text.slice(-Number(log[1]));
        return value({ kind: "exit:0", exitCode: 0, stdout: kept, stderr: "", truncated: false });
      }
      // The container's own filesystem, outside the Workspace: what a staged
      // file lands in. It is never committed, forked or diffed.
      const staged = containerExec(mount.sandbox, command);
      if (staged !== null) return staged;
      const exit = /^exit (\d+)$/.exec(command);
      if (exit !== null) {
        return value({ kind: `exit:${exit[1]}`, exitCode: Number(exit[1]), stdout: "", stderr: "err", truncated: false });
      }
      return value({ kind: "exit:0", exitCode: 0, stdout: `ran: ${command}\n`, stderr: "", truncated: false });
    }
    case "workspace.commit": {
      const mount = state.mounts.get(args.path);
      if (mount === undefined) return refused("NoSuchWorkspace", `no Workspace at ${args.path}`);
      const record = state.branches.get(mount.branch);
      if (record === undefined) return refused("NoSuchBranch", `no Branch ${mount.branch}`);
      if (!mount.dirty) {
        return value({ kind: "UpToDate", head: record.head, root: hex(64), merged: null, lww: [], lwwTruncated: false });
      }
      const id = commitId();
      state.commits.set(id, {
        id,
        branch: mount.branch,
        parent: record.head,
        secondParent: null,
        base: record.base,
        root: hex(64),
        via: "workspace.commit",
        message: args.message ?? "commit",
        mergedFrom: null,
        time: 1_700_000_000_000 + nextSerial(),
        logical: logicalOf(mount.branch),
        newCanonical: 0,
        newStored: 0,
        newMetadata: 64,
        displaced: null,
      });
      record.commits.unshift(id);
      record.head = id;
      mount.dirty = false;
      return value({ kind: "Committed", head: id, commit: state.commits.get(id), displacedHead: null, merged: null, lww: [], lwwTruncated: false });
    }
    case "workspace.unmount": {
      const mount = state.mounts.get(args.path);
      if (mount === undefined) return refused("NoSuchWorkspace", `no Workspace at ${args.path}`);
      // The daemon refuses to unmount a Workspace a background process this
      // binding started still runs in.
      const running = [...state.processes.values()].filter(
        (process) => process.path === args.path && !process.stopped && !process.exited,
      );
      if (running.length > 0) {
        return refused("Busy", `${args.sandbox}:${args.path} is busy: ${running.map((p) => p.id).join(", ")} still running`);
      }
      state.mounts.delete(args.path);
      const sandbox = state.sandboxes.find((item) => item.sandbox === mount.sandbox);
      if (sandbox !== undefined) sandbox.workspaces = Math.max(0, sandbox.workspaces - 1);
      return value(args.force ? { kind: "ForceUnmounted", abort: "Written", detach: "Detached", cleanup: "Queued" } : { kind: "Unmounted" });
    }
    case "backend.daemon.process.start": {
      const mount = state.mounts.get(args.path);
      if (mount === undefined) return refused("NoSuchWorkspace", `no Workspace at ${args.path}`);
      // The engine starts the command, then observes the process it started
      // with a second command. One the Sandbox's first process has already
      // reaped is refused: this is the refusal a bare quick command gets on a
      // machine whose first process reaps, which is why arbor wraps every
      // command it starts here (`OBSERVE_SECONDS`).
      if (!observable(args.command ?? "")) {
        return refused("Unknown", "background process exited before its identity was observed");
      }
      const id = `proc_${args.sandbox}_${nextSerial().toString(16).padStart(2, "0")}${hex(8)}`;
      state.processes.set(id, {
        id,
        sandbox: args.sandbox,
        path: args.path,
        command: args.command ?? "",
        stopped: false,
        exited: false,
        log: "",
      });
      return value({ kind: "running", process: id, command: args.command ?? "" });
    }
    case "backend.daemon.process.list": {
      // The engine proves every process it recorded is still the one it
      // started, by reading `/proc/<pid>/stat` and comparing the start time it
      // wrote down. A finished job whose pid a later group leader reused fails
      // that proof, and the whole listing is refused - so one stale record
      // takes the status read of every job in the Sandbox with it.
      if ([...state.processes.values()].some((process) => state.stale.has(process.id))) {
        return refused("Unknown", "process group identity is no longer provable; no signal sent", { op });
      }
      const items = [...state.processes.values()].map((process) => ({
        id: process.id,
        sandbox: process.sandbox,
        path: process.path,
        command: process.command,
        status: process.stopped ? "stopped" : process.exited ? "exited" : "running",
      }));
      const size = args.pageSize ?? 50;
      const pos = args.pagePos ?? 0;
      return value({ kind: "ok", items: items.slice(pos, pos + size), hasMore: pos + size < items.length, nextPagePos: null });
    }
    case "backend.daemon.process.cancel": {
      const process = state.processes.get(args.process);
      if (process === undefined) return refused("NoSuchProcess", `${args.process} is not a process id`);
      process.stopped = true;
      return value({ kind: "Stopped", process: process.id, status: "stopped" });
    }
    default:
      return refused("UnknownMethod", `no such method ${op}`);
  }
}

exports.call = async (op, args) => {
  state.calls.push({ op, args });
  return answer(op, args);
};

exports.backendCall = async (op, args) => {
  state.calls.push({ op, args });
  return answer(op, args);
};

exports.storeOpen = async () => value({ clients: 1 });
exports.storeClose = async () => value({ clients: 0 });

exports.state = state;
exports.calls = state.calls;
exports.reset = reset;
exports.write = write;
exports.headOf = headOf;
exports.branchNames = branchNames;
exports.seedDiff = seedDiff;
exports.refuse = refuse;
exports.mounts = () => [...state.mounts.values()];
exports.sandboxes = () => state.sandboxes.map((sandbox) => ({ ...sandbox }));
exports.commitId = commitId;

/** The background processes the stand-in daemon holds, as `process.list` sees them. */
exports.processes = () =>
  [...state.processes.values()].map((process) => ({
    id: process.id,
    sandbox: process.sandbox,
    path: process.path,
    command: process.command,
    status: process.stopped ? "stopped" : process.exited ? "exited" : "running",
  }));

/** One background process's log, which a test writes what a command would. */
exports.jobLog = (id, text) => {
  const process = state.processes.get(id);
  if (process === undefined) throw new Error(`no process ${id}`);
  process.log += text;
};
/** Mark one background process ended on its own, the way a finished command does. */
exports.jobExit = (id) => {
  const process = state.processes.get(id);
  if (process === undefined) throw new Error(`no process ${id}`);
  process.exited = true;
};

/**
 * What a wrapped command leaves in its log when it ends: a newline, a record
 * separator and the command's exit code, on the last line. This is the line
 * arbor's wrapper writes (`layerfs-workspace.ts`), which is how a caller learns
 * an exit code the daemon never reports. The process is left as it stands: the
 * wrapper holds itself open for a moment after the line, exactly as the engine
 * does on a machine that reaps.
 */
exports.jobFinish = (id, exitCode) => {
  const process = state.processes.get(id);
  if (process === undefined) throw new Error(`no process ${id}`);
  process.log += `\n\u001e${exitCode}\n`;
};

/**
 * Mark one background process's identity no longer provable: the pid it ran as
 * has since been reused by a later group leader, so the start time the engine
 * recorded for it no longer matches the one `/proc/<pid>/stat` reports. The
 * engine proves every record it holds before it answers `process.list`, so one
 * such record refuses the whole call - which is what a burst of quick commands
 * hits when an earlier command's pid is reused.
 */
exports.staleJob = (id) => {
  if (!state.processes.has(id)) throw new Error(`no process ${id}`);
  state.stale.add(id);
};

/** One Sandbox's own files, outside every Workspace it holds: what staging lands in. */
exports.containerFiles = (sandbox) =>
  [...(state.container.get(sandbox) ?? new Map())].map(([path, entry]) => ({ path, ...entry }));

/** Marks a mounted Workspace's overlay dirty, as a command that wrote a file would. */
exports.touch = (path) => {
  const mount = state.mounts.get(path);
  if (mount === undefined) throw new Error(`no Workspace at ${path}`);
  mount.dirty = true;
};

reset();
