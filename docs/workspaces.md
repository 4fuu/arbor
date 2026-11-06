# Workspaces

A workspace is a directory a window works in. It is a plain directory, not
bound to any repository: the framework gives isolation and continuity, and the
agent does the rest.

## What the framework guarantees

1. **Isolation.** Every window gets its own directory. `read`, `write`,
   `edit` and `bash` work in it, and nothing one window does there reaches
   another window's directory.
2. **Continuity.** A continuation window works in its predecessor's
   directory, in place, so cloned repositories, installed dependencies and
   work in progress carry over and long work spans windows.
3. **Means.** Credentials the deployment configures (git, package
   registries), network access within the egress rules, background jobs for
   long commands, and a disk quota per workspace.

The default `Workspace` is a plain directory
([@arbor/workspace-dir](../packages/workspace-dir)): every window's directory
lives under one root the host names, `bash` runs on the host in it, and a
background job runs there too, through the host's own process API, so a
command that outlives `bash`'s wait window keeps running after the call that
started it. A new window gets a directory of its own, created on first use; a
continuation keeps working in its predecessor's directory in place, under the
same ref - no copy, no link, no fork. Only one window in a chain is live at a
time, so in place is safe, and the chain is in the journal, so a restart
recovers which directory a continuation uses. Nothing is mounted and nothing
is containerised, and no symlink or POSIX-only call is on the path, so it works
unchanged on Windows, Linux and macOS; a disk quota is the size the
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
  files has none. A new window gets a directory of its own; a continuation
  keeps the one it continues, under the same ref.
- When the last window of a continuation chain ends, the directory stays
  where it is. Whether work was pushed before the end is the agent's
  responsibility; nothing in the directory is lost either way.
- After a retention period the host reclaims the chain's directory by itself.
  This is a setting, not a task for a model.

A deployment that never works with files needs no workspace.
