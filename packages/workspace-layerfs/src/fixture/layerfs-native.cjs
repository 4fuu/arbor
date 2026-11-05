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

function reset() {
  state.branches.clear();
  state.commits.clear();
  state.files.clear();
  state.sandboxes.length = 0;
  state.mounts.clear();
  state.diffs.clear();
  state.refusals.clear();
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
  files.set(path, { type: "file", size: Buffer.byteLength(text, "utf8"), mode: 0o644 });
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
    seen.set(child, slash < 0 ? { type: entry.type, size: entry.size, mode: entry.mode } : { type: "directory" });
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
      const copied = new Map(state.files.get(from) ?? new Map());
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
      state.mounts.delete(args.path);
      const sandbox = state.sandboxes.find((item) => item.sandbox === mount.sandbox);
      if (sandbox !== undefined) sandbox.workspaces = Math.max(0, sandbox.workspaces - 1);
      return value(args.force ? { kind: "ForceUnmounted", abort: "Written", detach: "Detached", cleanup: "Queued" } : { kind: "Unmounted" });
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

/** Marks a mounted Workspace's overlay dirty, as a command that wrote a file would. */
exports.touch = (path) => {
  const mount = state.mounts.get(path);
  if (mount === undefined) throw new Error(`no Workspace at ${path}`);
  mount.dirty = true;
};

reset();
