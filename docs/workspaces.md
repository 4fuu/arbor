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

The default `Workspace` is a plain directory
([@arbor/workspace-dir](../packages/workspace-dir)): every window's directory
lives under one root the host names, `bash` runs on the host in it, and a
background job runs there too, through the host's own process API, so a
command that outlives `bash`'s wait window keeps running after the call that
started it. Nothing is mounted and nothing is containerised, so it works
unchanged on Windows, Linux and macOS, and a disk quota is the size the
implementation reports against a workspace's directory.

A deployment that wants real isolation - a sandbox, a container per window -
implements `Workspace` itself and registers it; the core knows nothing about
what an implementation does beyond the interface
([architecture.md](architecture.md#interfaces)).

The shared environment reaches a command the same way. The environment is one
shared directory on the host and a window's workspace is a directory on that
same host, so `read` and `bash` resolve the prefix `/env` onto the directory
itself. Nothing is staged and nothing is copied: what a command reads at `/env`
is the environment's own file, which is why it is read-only and a change goes
through the environment's draft and `reload`
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

A deployment that never works with files needs no workspace.
