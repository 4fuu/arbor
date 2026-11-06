# Workspaces

A workspace is where a window works with files. The framework ships two
implementations and picks one at start.

The default is **ovnfs** ([@4fu/arbor-workspace-ovnfs](../packages/workspace-ovnfs)):
one shared folder every window reads and writes, which can hold several projects
and several git repositories, with per-window copy-on-write checkouts a window
opens, works in and merges back. It is used when the `ovnfs` binary is found and
its daemon starts. When ovnfs is not installed - or its daemon will not start -
the host falls back to the **plain directory** workspace
([@4fu/arbor-workspace-dir](../packages/workspace-dir)): one directory per
window, which needs nothing a host does not already have and runs the same way
on Windows, Linux and macOS.

ovnfs isolates files, not processes: a command a window runs can still reach any
process, socket or file on the host. **It is not a sandbox.** Real process
isolation comes from an implementation that owns its execution environment - a
container per window - which implements `Workspace` itself and registers it; the
core knows nothing about what an implementation does beyond the interface
([architecture.md](architecture.md#interfaces)).

## The ovnfs workspace

One shared folder, named by the host, is where every window works. It is
read-only by convention: the prompt text says so, and nothing enforces it - a
window that writes to it writes to the shared folder, exactly as the plain
directory workspace documents for another window's directory. What keeps a
window out of the shared folder is the prompt text, and prompt text only.

A window that wants to change files opens its own **checkout** of the project
subfolder it needs and works there:

```text
ovnfs new <项目子目录> --name <本窗口引用>-<简称>   # open a checkout, print its path
cd <检出的路径>                                    # work in it
ovnfs diff <检出名>                                # what changed
ovnfs apply <检出名>                               # merge it back into the shared folder
ovnfs rm <检出名>                                  # remove the checkout
```

The checkout is named after the window that opened it (`<window ref>-<short
name>`), and that name is how the host binds a checkout to a window: `end`'s
open-work check and reclaim both find a window's checkouts by the `<ref>-`
prefix. The module functions `workspace.checkout`, `list`, `diff`, `apply`, `rm`
and `path` are a convenience over the same operations; the plain CLI works just
as well, and a command run in `bash` reaches the same daemon.

A checkout is frozen at open. To see what another window has applied since, read
the shared folder or open a new checkout. In a git repository, open the checkout
at the repository's own subfolder - not a parent folder - so it gets the private
git directory `apply --branch` needs: commit inside the checkout, then
`apply <name> --branch arbor/<name>` brings the commits back as a branch.
Never commit in the shared folder.

Path classes decide what a checkout captures: `source` paths are captured and
merged back; `cache` (`node_modules` and build outputs) and `local` (`.env` and
other secrets) show the live folder, read-only, and are never merged; `hidden`
paths are absent.

## Another window's checkout

`workspace.path(window)` names the checkouts a window's chain has, and both the
description and the result say they belong to another window and must not be
modified. Nothing enforces it - another window's checkout is a path on the same
host, which a command may name and `read`, `write` and `edit` may open and
change. It is not a security boundary, and the docs say so.

The shared environment reaches a command the same way. The environment is one
shared directory on the host and a window's workspace is a directory on that
same host, so `read` and `bash` resolve the prefix `/env` onto the directory
itself. Nothing is staged and nothing is copied: what a command reads at `/env`
is the environment's own file, which is why it is read-only and a change goes
through the environment's draft and `reload`
([environment.md](environment.md#layout)). The prefix is a string rewrite, not a
mount, so it is a convenience for reading and not a boundary.

## The plain directory workspace

The fallback. Every window gets its own directory under one root the host names;
a new window gets a directory of its own, created on first use, and a
continuation keeps working in its predecessor's directory in place, under the
same ref - no copy, no link, no fork. Only one window in a chain is live at a
time, so in place is safe, and the chain is in the journal, so a restart
recovers which directory a continuation uses. `bash` runs on the host in it, and
a background job runs there too, through the host's own process API. A disk
quota is the size the implementation reports against a workspace's directory.

## Detection and restart

At start the host finds the `ovnfs` binary, checks its version against the
pinned v0.1.1 (a mismatch is a warning, not a failure), and starts the daemon
with its state and mount under the host's data directory. It reports which
backend it chose, and falls back to the plain directory when the binary is
missing or the daemon will not start.

A restart starts the daemon again; checkouts survive it and are found by their
`<ref>-` prefix, resolved through the journal's chain, the way the plain
directory workspace resolves a continuation's directory.

## What the agent does

Everything that is a judgment or a workflow: deciding when to open a checkout,
which project subfolder to check out, when to apply, and resolving merge
conflicts itself. Changes reach others through the repository's own flow - push,
review, CI - not through the framework. The framework neither merges files nor
makes tasks for the agent to do so.

Two windows may change the same project at once; the conflict shows at `apply`,
and that window resolves it with the conflict markers. The board shows who is
working where, and the judge takes it into account when dispatching
([coordination.md](coordination.md#the-board)).

## Lifecycle

- A window's checkouts are created when the model opens them; a window that
  never opens one has none. Each is named after the window that opened it.
- When the last window of a continuation chain ends, the chain's checkouts stay
  where they are. Whether work was applied before the end is the agent's
  responsibility; nothing in a checkout is lost either way.
- After `workspaces.retentionMs` the host reclaims the chain's checkouts by
  itself, once the chain's last window has ended, removing each with `ovnfs rm`.
  This is a setting, not a task for a model: with no retention period set,
  nothing is ever reclaimed.
- The period is counted from the end the journal recorded, not from the host's
  start, so a restart in the middle of it reclaims on time. The plain directory
  workspace reclaims the chain's directory the same way, by `Workspace.refOf`
  and `Workspace.reclaim`.

A deployment that never works with files needs no workspace.
