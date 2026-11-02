# Overview

## Goals

1. **Throughput.** Many pieces of work progress at the same time, with no cap
   on how many.
2. **Fast replies.** A new input reaches a model within seconds: either a
   window already working on something related, or a new window whose prefix
   is already cached.
3. **Everything known.** Every window can find everything that was ever done
   in the project, down to the original event.
4. **No sessions to manage.** Nobody - neither a person nor the model -
   manages a session or a context. Windows are disposable; the model looks up
   what it needs.
5. **Low load on the model.** The model decides what to do. Dispatch,
   insertion timing, prefix caching, file merges and bookkeeping stay with the
   host; hard operations reach the model as tasks with instructions.
6. **Replaceable modules.** Every part sits behind an interface
   ([architecture.md](architecture.md)).

## Concepts

| Concept | Meaning |
| --- | --- |
| **Project** | One body of work: one journal, one set of notes, one LayerFS project. |
| **Journal** | The project's one append-only log of events, shared live by every window ([journal.md](journal.md)). |
| **Event** | One immutable record: an input, a tool call, a result, a send, a note revision. |
| **Target** | What an event touches: a conversation, a file path, a note, an issue. |
| **Window** | One context window: a model run over a prompt. Disposable; owns nothing ([windows.md](windows.md)). |
| **Task** | A unit of input to dispatch: a batch of outside events, a scheduled firing, or a system task ([dispatch.md](dispatch.md)). |
| **Board** | The host's live view of which windows are running and what they touch ([coordination.md](coordination.md)). |
| **Note** | Shared, versioned long-term memory; one copy per project ([memory.md](memory.md)). |
| **Workspace** | A LayerFS branch a window writes files in ([workspaces.md](workspaces.md)). |
| **Effect** | An action on the outside world, such as a send. |
| **Judge** | The module that answers the host's decisions - dispatch, notices, the active set. Jev by default. |
| **Host** | The process that runs windows, dispatches tasks and owns the rules. |

## Principles

1. **The journal is the only truth.** Everything is recorded once, never
   edited, never deleted, and visible to every window as soon as it is
   written. There is no branch of records and no merge of records.
2. **A window is a view, not a container.** It starts fresh from a standard,
   cacheable prefix, works, and ends. What it did stays in the journal; the
   next window reads it on demand.
3. **Share by reference.** Whatever crosses windows - a notice, a handoff, a
   publish message - is short text that carries refs, and every ref resolves
   to the full events behind it.
4. **Check only where it shows.** Windows run in parallel without locks.
   Inconsistency only does harm when it leaves the system - a send, a note
   write, a file publish - so those are checked against what the window has
   seen.
5. **The host does the hard operations.** Merging files, choosing notes,
   dispatching and rotating are the host's. When one needs a model - a file
   conflict - the host makes it a task with instructions. A note conflict is
   resolved by the model writing the note, when it writes.

## Routes considered

| Route | Why not |
| --- | --- |
| git-style branches with a trunk for records, notes and files | the model manages merges and conflicts; information is shared only after a merge, so replies wait |
| a resident router session dispatching to workers | a single point every input passes through, and one more model call per input |
| one resident window per conversation or issue | a busy conversation is still one serial line |
| contexts forked from a running window | a forked transcript is used once, so its prefix rarely pays off in the cache, and the fork inherits the parent's usage |

## What carries over from the QQ project

The design generalizes mechanisms built and run in
[qqnt-gui-driver](https://github.com/4fuu/qqnt-gui-driver) (temporary link,
removed once arbor is built), which ran one window at a time for many
sources:

| QQ project | arbor |
| --- | --- |
| one append-only event log | one journal per project, shared by concurrent windows |
| rotating windows with a frozen prefix | disposable windows with a standard prefix |
| usage reminders, the handoff, hard-limit continuation | the same, per window ([windows.md](windows.md)) |
| active and archived notes, summaries, revisions, anchors, links | the same ([memory.md](memory.md)) |
| one reference format and the link graph | the same, with a project prefix ([journal.md](journal.md#refs)) |
| debounce, protection period, steering a batch into a running turn | task sources and insertion timing ([dispatch.md](dispatch.md)) |
| Jev with rule bounds and fallbacks | the `Judge` interface, Jev by default |
| one action queue for every send | one effect queue for every effect |
| direct tools plus modules through `code_exec` | the same ([tools.md](tools.md)) |
| errors name the next action; guard rules live in the refusal | unchanged |

What is new: many windows at once, dispatch by a judge, the board and
notices between windows, consistency checks at sends and writes, and files on
LayerFS.
