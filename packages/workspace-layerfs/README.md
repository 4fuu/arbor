# @arbor/workspace-layerfs

The default `Workspace`: a directory per window on
[LayerFS](https://github.com/Ephemeral-AI-Lab/layerfs), with forks for
continuations that copy no files, a snapshot after every write and every `bash`
call, and read-only mounts of another workspace's snapshots by ref
([docs/workspaces.md](../../docs/workspaces.md)).

```ts
import { LayerfsWorkspace } from "@arbor/workspace-layerfs";

const workspace = new LayerfsWorkspace({
  project: "arbor",
  retentionMs: 30 * 24 * 60 * 60 * 1000,
  quotaBytes: 20 * 1024 * 1024 * 1024,
  deployment: {
    home: "/var/lib/arbor/layerfs",
    storePath: "/var/lib/arbor/layerfs/store.sqlite",
    image: "sha256:…",
    daemon: "/opt/layerfs/layerfs-daemon",
    docker: "/var/run/docker.sock",
    volume: "arbor-store",
  },
});

const ws1 = await workspace.create("c41");   // the window's own directory
const ws2 = await workspace.fork(ws1, "c42"); // a continuation: no file copied
const mount = await workspace.mount(ws1);
await mount.exec?.("npm test");
await workspace.snapshot(ws1, "r902");        // the event that changed files
await mount.release();
const view = await workspace.mount("ws1@r902"); // read-only, by ref
await view.release();
```

## What an arbor ref names in LayerFS

| Arbor | LayerFS |
| --- | --- |
| `ws3` | the Branch `ws3`, forked from the base Branch (`main`) on first use, or from the workspace it continues |
| `ws3@r902` | the Commit this package recorded for event `r902` |
| `mount("ws3")` | that Branch, mounted read-write in a Sandbox |
| `mount("ws3@r902")` | the Branch `ws3-r902-view`, forked at that Commit once and mounted read-only |

No LayerFS id crosses the interface. This package keeps the mapping - which
Branch a workspace is, which Commit an event's snapshot holds - in its own
SQLite registry beside the LayerFS Store, because a Commit id is not a ref and
may not be recorded where the core can see it
([docs/architecture.md](../../docs/architecture.md#interfaces)). The registry is
also what makes a snapshot ref stable: `ws3@r902` keeps resolving to the same
Commit after the workspace moves on.

## Mounts and `bash`

LayerFS mounts a Workspace inside the Sandbox its daemon runs in, over FUSE, so
a mount's `path` is that Sandbox's own directory and not a host path. A command
therefore runs through the mount's `exec`, which the interface carries for an
implementation that owns its execution environment
([`ExecResult`](../../packages/interfaces/src/workspace.ts)); a
host-directory implementation leaves it out and the caller runs the command
itself in `path`.

Releasing a read-write mount commits it first, so nothing the agent did is lost
by ending a mount - a LayerFS unmount of a dirty Workspace is refused, and
discarding one throws the work away. A read-only view is discarded instead: a
view must never publish anything.

## Settings

| Setting | Meaning |
| --- | --- |
| `project` | the LayerFS project every window's directory lives in. `arbor` |
| `baseBranch` | the Branch a new window's directory forks from. `main` |
| `retentionMs` | how long snapshots are kept before the host reclaims them (`settings.workspaces.retentionMs`). The host calls `reclaim`; this package runs no clock |
| `quotaBytes` | the limit `quota` reports. `0` is no limit |
| `stateDir` | where the registry lives. Inside `deployment.home` by default |
| `deployment` | LayerFS's own settings, mapped onto its `LAYERFS_` environment names |
| `sdk` | where the LayerFS JavaScript packages are, when not the checkout `.agents/setup` makes |

`deployment.source` is the folder a first Init imports into the base Branch, so
a deployment that wants every window to start from something - credentials, a
skeleton - points it there. With none, the project starts empty.

## What LayerFS does not give

- **Reclaim cannot erase history.** Its Store has no per-Branch delete, so
  `reclaim` releases the mounts, drops the refs that resolved them and marks
  the workspace reclaimed; the Branch and its Commits stay in the Store until
  the project itself is removed.
- **A quota is reported, not enforced.** LayerFS has no quota of its own, and
  its storage is deduplicated across the whole Store, so `quota` reports the
  workspace's logical size (the newest Commit's tree) and its file count, which
  costs one walk of the tree.
- **A snapshot needs a Commit.** LayerFS publishes a Commit from a mounted
  Workspace, so a workspace nothing was ever written to has none, and
  `snapshot` refuses it rather than inventing an id.

## Installing LayerFS

LayerFS is not a dependency of this repository: its core is Rust and its
JavaScript packages are built beside a pinned checkout. `.agents/setup` clones
that checkout into `.layerfs`, builds `engine/crates/layerfs-node/layerfs.node`
and `layerfs-daemon`, and leaves them where this package finds them.
`ARBOR_LAYERFS_SDK` (or the `sdk` option) names another checkout.

The toolchain has two paths. On a machine with mise, the repository's
`mise.toml` provides Node, pnpm and Rust 1.85.1 under `~/.local/share/mise` -
never into `~/.cargo` - and the system provides the C compiler, pkg-config and
fuse3; that is the path for Arch and other hosts without apt. On an apt machine
`.agents/setup` installs those as packages and takes Rust from rustup.

Running a mount needs more than the build: `/dev/fuse`, a Docker Engine
speaking Engine API 1.48 or newer, the image a Sandbox runs, and a Store on
ext4, xfs or btrfs. Podman's Docker-compatible socket is not enough: its
compatibility API stops at 1.44, which LayerFS refuses before it sends a
request, so `capabilities()` reports it unavailable with the version as the
reason instead of a false green.

A rootless Engine can run it, with two things the deployment provides. The
Sandbox's daemon runs in a user namespace and refuses a `/dev/fuse` it does
not own, and a rootless container's root is the unprivileged user on the
host, so the device must belong to that user - a udev rule
(`KERNEL=="fuse", OWNER="<user>", GROUP="<user>", MODE="0666"`) plus a
`chown` until the rule applies. And pasta's default `implicit` port driver
leaves a published port unforwarded, so the SDK's dial to the daemon is
refused: rootlesskit's `pesto` driver forwards it.

```sh
mkdir -p ~/.config/systemd/user/docker.service.d
printf '[Service]\nEnvironment=DOCKERD_ROOTLESS_ROOTLESSKIT_PORT_DRIVER=pesto\n' \
  > ~/.config/systemd/user/docker.service.d/port-driver.conf
systemctl --user restart docker
```

The image a Sandbox runs is built from the pinned commit with the
`sandbox.Dockerfile` beside this README, on the machine that has the Engine:

```sh
docker build -f packages/workspace-layerfs/sandbox.Dockerfile -t arbor-layerfs-sandbox .
```

Name it by digest, never a tag: read it with `docker images --digests` and set
`LAYERFS_IMAGE` to it. The daemon that runs in the Sandbox is the host build
(`LAYERFS_DAEMON`), which the SDK uploads into the container, so the image's
base must carry a glibc at least as new as the host build's; the Dockerfile's
`BASE_IMAGE` argument selects it.

## Running the real tests

`layerfs-workspace.real.test.ts` runs against a real Store, and mounts where
the machine has them. It reads the deployment from the environment, so run it
through mise, which `mise.toml` fills in:

```sh
mise x -- pnpm --filter @arbor/workspace-layerfs test
```

Two rules come from LayerFS itself, not from this package:

- **One project per Store.** LayerFS initializes one project per Store, and a
  project's Branches outlive the run that made them, so a full run needs a
  Store no project was initialized in yet. Remove the Store file first, the
  way LayerFS's own end-to-end runs use a fresh volume; a Store that already
  holds a project skips the run and says so.
- **The Store install runs as user 0.** LayerFS's installer refuses any other
  user, so under rootless Docker the client runs inside a user namespace of
  its own - `mise x -- unshare -Ur pnpm ...` - where it is user 0 and the
  files it makes still belong to the unprivileged user on the host. The
  Store's directory must also be private (mode 0700): the Sandbox's daemon
  refuses a Store whose parent it does not own exclusively, which is what
  `umask 077; mkdir -p .../global` gives it.

## Tests

- `layerfs-workspace.test.ts` drives the real `@layerfs/agent` JavaScript over
  the stand-in native binding in `fixture/`, so it needs no Docker, no FUSE and
  no Store, and runs wherever the packages are installed. It checks this
  package's side of the contract: which Branch a ref names, which Commit an
  event's snapshot holds, what a mount does and what it never publishes.
- `layerfs-workspace.real.test.ts` runs against a real Store, and a real mount
  where the machine has one, and skips with its reason otherwise.
