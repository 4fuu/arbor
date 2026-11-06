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
window, plus the persistent directories a window asks to keep, which needs
nothing a host does not already have and runs the same way on Windows, Linux and
macOS.

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
ovnfs new <project dir> --name <window ref>-<short name>   # open a checkout, print its path
cd <checkout path>                                        # work in it
ovnfs diff <name>                                         # what changed
ovnfs apply <name>                                        # merge it back into the shared folder
ovnfs rm <name>                                           # remove the checkout
```

The checkout is named after the window that opened it (`<window ref>-<short
name>`), and that name is how the host binds a checkout to a window: the
open-work report ([below](#open-work)) and reclaim both find a window's
checkouts by the `<ref>-` prefix. The module functions `workspace.checkout`,
`list`, `diff`, `apply`, `rm` and `path` are a convenience over the same
operations; the plain CLI works just as well, and a command run in `bash`
reaches the same daemon.

A checkout is frozen at open. To see what another window has applied since, read
the shared folder or open a new checkout. In a git repository, open the checkout
at the repository's own subfolder - not a parent folder - so it gets the private
git directory `apply --branch` needs: commit inside the checkout, then
`apply <name> --branch arbor/<name>` brings the commits back as a branch.
A branch apply moves commits only: it leaves the shared folder's working files
alone, and the checkout still differs from its base, so the window removes it
with `rm` before `end` accepts. Never commit in the shared folder.

Path classes decide what a checkout captures: `source` paths are captured and
merged back; `cache` (`node_modules` and build outputs) and `local` (`.env` and
other secrets) show the live folder, read-only, and are never merged; `hidden`
paths are absent.

A command run in `bash` inside a checkout is given two variables of this
workspace's own: `ARBOR_WINDOW`, the window that runs it, and a git
configuration that points `core.hooksPath` at the hooks that stamp an
`Arbor-Window` trailer onto a commit. A `Workspace` implementation declares
them through `bashEnv`, and they are the only variables a command gets beyond
the minimum the framework gives every subprocess
([environment.md](environment.md#what-a-subprocess-gets)); the host's own
environment never reaches a command.

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

## Open work

A window can start something in its workspace and not finish it. What that is
differs per implementation, so each one reports it itself, through one optional
method on `Workspace`:

```ts
openWork?(window: WindowRef): Promise<readonly OpenWorkItem[]>
```

The host asks for it where a window's own state is not enough: the reminder
tiers name the open items, the board shows them on the window's line, `end`
refuses without a handoff while any are open and names them in the refusal, and
a continuation's first input names the ones its predecessor left
([windows.md](windows.md#ending-and-continuing)). The host knows nothing about
what is open in a workspace: an implementation that keeps nothing open answers
nothing, and a host with no workspace at all asks nobody.

The ovnfs workspace answers with the chain's checkouts that hold changes not
yet applied back, each named the way `workspace.list` names it and carrying that
implementation's own words for what is open about it. A checkout that is applied
is finished work and is not reported; one that is merely still there is listed
by `workspace.list` and `workspace.path` and not by this report. The
plain-directory workspace answers nothing: a window works in place, its
continuation keeps working in the same directory, and there is no step between
the two where work could be left unapplied.

## The plain directory workspace

The fallback. Every window gets its own directory under one root the host names;
a new window gets a directory of its own, created on first use, and a
continuation keeps working in its predecessor's directory in place, under the
same ref - no copy, no link, no fork. Only one window in a chain is live at a
time, so in place is safe, and the chain is in the journal, so a restart
recovers which directory a continuation uses. `bash` runs on the host in it, and
a background job runs there too, through the host's own process API. A disk
quota is the size the implementation reports against a workspace's directory.

```text
<root>/ws3/                    the window's own directory
<root>/keep/notes/             a persistent directory, kept past the window
```

### Persistent directories

A window's own directory ends with its chain. Content that has to outlive that -
a build cache, a cloned repository, notes a later window needs - is a
**persistent directory**, kept under one `keep` directory beside the windows'
own:

```text
workspace.keep("build-cache")          # the directory, created on first use
mkdir -p <root>/keep/build-cache       # the same directory, by hand
```

Both make the same directory, and both are the documented way in: the module
function answers with the path and records the write in the journal with the
window that asked for it, and a plain `mkdir` under the same root makes the
directory nothing else has to know about. A name the directory already has is
handed back as it is, so a later window that wants the same place gets the same
directory rather than a second one - which is how a persistent directory is
shared. A name is one segment: lowercase letters, digits, `.`, `_` and `-`,
starting with a letter or a digit, at most 64 characters.

They live outside the windows' own directories, so nothing the lifecycle does to
a window's own directory reaches them: reclaim removes `<root>/ws<n>` and
nothing else, a restart finds them where they were, and a host restart loses
nothing. `workspace.keeps()` lists them all by name and path, a continuation's
first input names the ones its own chain created, and `journal.search` finds the
writes. Removing one is the model's own `rm`, in `bash`; nothing reclaims a
persistent directory.

A persistent directory is shared, exactly as the shared folder is in the ovnfs
workspace: the name says what belongs in it, and the prompt text asks a window
not to overwrite what is not its own. It is not a security boundary, and neither
is a window's own directory.

## Prompt text

Each implementation carries its own prompt text and its own module functions,
chosen with the implementation: the ovnfs workspace's section and text table
(`packages/workspace-ovnfs`) describe the shared folder, the checkouts and the
`ovnfs` skill it seeds; the plain-directory workspace's
(`packages/workspace-dir`) describe working in place, the persistent directories
and another window's directory. The host merges the active implementation's
table over its own when it starts, so a host that fell back to the plain
directory never shows the ovnfs method and a host running ovnfs never shows the
plain-directory one. Where the two restate the same key - `workspace.path`'s
description, result and refusal - each carries its own wording, and a host's
table is its own copy, so one host's strings never reach another's.

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
  and `Workspace.reclaim`. What it does not reclaim is a persistent directory:
  those live outside the windows' own directories and outlive the chain, the
  period and the restart ([above](#persistent-directories)).

A deployment that never works with files needs no workspace.
