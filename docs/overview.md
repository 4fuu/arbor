# Overview

## Goals

1. **Throughput.** Many pieces of work progress at the same time, each on its
   own branch, without waiting for one long session to finish.
2. **Coherent context.** A branch's model always knows where its work stands:
   across context resets, across branches, and across merges. Nothing done is
   lost; everything is queryable.
3. **Low load on the model.** The model decides what to do and, like a
   developer with git, operates its own branch. Scheduling, insertion timing,
   prefix caching and bookkeeping stay with the host.
4. **Replaceable modules.** Every part sits behind an interface
   ([architecture.md](architecture.md)).

## Concepts

| Concept | Meaning |
| --- | --- |
| **Project** | One source tree and its history: one LayerFS project and Store. |
| **Event** | One immutable record - an input, a tool call, a result, a send, a note revision. Each names its parent; events form a DAG. |
| **Branch** | A line of work: a chain of events plus a LayerFS branch for its files. It takes tasks and holds unmerged changes. |
| **Context** | The live view of a branch: the prompt the model reads now. A branch has a sequence of contexts over its life. |
| **Trunk** | The merge points of all branches, backed by LayerFS `main`. It runs no model. |
| **Task** | A piece of outside work with an **ownership key** (a conversation, an issue, a repository path). |
| **Branch message** | A message one live branch sends to another. |
| **Note** | Shared, versioned memory, stored as files in the project and edited through note tools. |
| **Effect** | An action on the outside world (sending a message, calling an external API). |
| **Host** | The framework process that runs branches, schedules tasks and owns the rules. |

A branch and a context are deliberately separate: rotating a context does not
merge a branch, and merging a branch does not end its context
([branches.md](branches.md#operations)).

## What carries over from the QQ project

The design generalizes mechanisms built and run in
[qqnt-gui-driver](https://github.com/4fuu/qqnt-gui-driver) (temporary link,
removed once arbor is built):

| QQ project | arbor |
| --- | --- |
| one append-only event log | an event DAG per project |
| rotating windows with a frozen prefix | contexts of a branch, rotated by token budget |
| usage reminders at fixed tiers, the handoff, hard-limit continuation | the same, per context ([context.md](context.md)) |
| active and archived notes, summaries, revisions, anchors | the same, stored as files on LayerFS |
| one reference format (`n012@3`, `r42`, `msg:…`, `w7`) and the link graph | the same, prefixed by project and branch |
| debounce, queue order, protection period, steering a batch into a running turn | task assignment and insertion timing ([scheduling.md](scheduling.md)) |
| one action queue for every send | one effect queue for every effect |
| direct tools plus modules reached through code_exec | direct tools plus the `arbor` CLI reached through bash ([cli.md](cli.md)) |
| errors name the next action; guard rules live in the refusal | unchanged |

What is new: many branches at once, many projects, files under LayerFS, and
branches that read and message each other.
