# Workspaces

A workspace is a directory a window works in. It is a plain directory, not
bound to any repository: the framework gives isolation, continuity and
snapshots, and the agent does the rest.

## What the framework guarantees

1. **Isolation.** Every window gets its own directory. `read`, `write`,
   `edit` and `bash` work in it, and nothing one window does there reaches
   another window's directory.
2. **Continuity.** A continuation window forks the previous window's
   directory, so cloned repositories, installed dependencies and work in
   progress carry over and long work spans windows. A fork copies no files.
3. **Snapshots.** Every write and every `bash` call ends with a snapshot of
   the directory, and the event records its id. A snapshot is the directory's
   state at that event and can be read later. A call that changes no file takes
   none, and a window that never touches files has no directory to snapshot.
4. **Read-only views.** Any window can mount another workspace's latest
   snapshot, or any snapshot by its event, read-only by its ref (`ws3`,
   `ws3@r902`), to look at work that is not pushed anywhere.
5. **Means.** Credentials the deployment configures (git, package
   registries), network access within the egress rules, background jobs for
   long commands, and a disk quota per workspace.

The default `Workspace` is [LayerFS](https://github.com/Ephemeral-AI-Lab/layerfs),
used only for cheap forks, snapshots and mounts
([architecture.md](architecture.md#stack) lists what it requires). In that
implementation a workspace is a LayerFS Branch and a snapshot is one of its
Commits, and `bash` runs inside the Sandbox LayerFS mounts the Branch in, so a
mount's path is that Sandbox's own directory. A background job runs there too,
through LayerFS's own daemon process API, so a command that outlives `bash`'s
wait window keeps running after the call that started it; a command that ends
inside the window answers from the job it ran as, with its output and its exit
code, exactly as one that ran to completion does. Two consequences come
from LayerFS itself: its Store has no per-Branch delete, so reclaiming a
workspace drops the refs that resolved it and leaves its history in the Store
until the project is removed; and its storage is deduplicated across the whole
Store, so a disk quota is a limit the deployment sets against a workspace's
logical size, not one LayerFS enforces.

A host that cannot run LayerFS - no `/dev/fuse`, no Docker Engine at the API
version LayerFS speaks, no Store on its filesystem allowlist, or no Linux at
all - falls back to a plain directory and logs the reason its capability check
gave. The interface is the same: forks and snapshots are copies instead of
metadata, and background jobs stay on the host. The work environment degrades,
the framework does not fail.

The shared environment reaches a command the same way in both. A Sandbox
cannot mount a host directory - its only volume is the project's Store - so
the files are staged into it beside the mount, in the container's own writable
layer, and the prefix `/env` is rewritten onto where they landed. What is
staged sits outside the workspace's tree, so no snapshot holds it, no fork
copies it and no read-only view shows it
([environment.md](environment.md#layout)).

## What the agent does

Everything that is a judgment or a workflow: cloning, branching, committing,
pushing, opening pull requests, resolving merge conflicts, running tests,
tidying its own directory. Changes reach others through the repository's own
flow - push, review, CI - not through the framework. The framework neither
merges files nor makes tasks for the agent to do so.

Two windows may change the same repository at once; the conflict shows when
the second one pulls or merges, and that window resolves it with git. The
board shows who is working where, and the judge takes it into account when
dispatching ([coordination.md](coordination.md#the-board)).

## Lifecycle

- A window's directory is created on first use; a window that never touches
  files has none.
- When the last window of a continuation chain ends, the directory keeps its
  snapshots, read-only. Whether work was pushed before the end is the agent's
  responsibility; nothing in the directory is lost either way.
- After a retention period the host reclaims the snapshots by itself. This is
  a setting, not a task for a model. Reclaiming drops the refs that resolved
  them; whether the history underneath is erased too is the implementation's,
  and the default one keeps it until the project is removed.

A deployment that never works with files needs no workspace and no LayerFS.
