# Context

A context is the live view of a branch: what the model reads now. A branch
has one context at a time and a sequence of them over its life. Contexts
rotate by token budget, never by turn counts.

## Prompt layout

```text
┌ system prompt ─────────── changes only on identity or tool-set edits ┐
│ identity, general rules, direct tools one per line, `arbor help`     │
├ context bootstrap ──────────────── frozen for the context's life ────┤
│ opening note, active-note snapshot, the branch's handoff,            │
│ summaries merged into the trunk since the branch last pulled         │
├ inputs ─────────────────────────────── append-only ──────────────────┤
│ task blocks, branch messages, tool calls and results, reminders      │
└──────────────────────────────────────────────────────────────────────┘
```

- The prefix of a context never changes while it is open, so the provider's
  prompt cache stays valid. Rendering is deterministic: no timestamps or
  counters in the system prompt or bootstrap.
- Anything that changes per input (its time, people or items seen for the
  first time) goes into the input itself.
- Contexts that start from the same trunk point with the same system prompt
  share a prefix, so the cache serves them all.

## Usage reminders

Host reminders are appended to an input, never to the prefix. The tiers carry
over from the QQ project: at 15, 30 and 50 % of the window, update notes; at
60, 70 and 80 %, also rotate; a final one at `window - 2 x reserve`. Each
carries the real numbers, its place in the series, the cost of ignoring it,
and the branch's merge state (unmerged changes, an unfinished pull). Only the
highest crossed tier is sent; the lower ones it jumped over are recorded as
sent with it.

## Rotation

- `rotate(handoff)` ends the context and opens the next one for the same
  branch. The handoff is required and short: current topics, progress,
  pending items, agreements. Details belong in notes.
- Below 60 % of the window the call is refused, with the usage named.
- The host pulls the trunk into the branch before building the next
  bootstrap, so the new context starts from the latest shared state. A pull
  conflict does not block the rotation: the new context opens in the merging
  state and its first input says so.
- Rotation does not merge. Unmerged changes stay on the branch.

## Hard limit

At `window - min(16k, window / 4)` the host rotates by itself. The run is
usually half-way through a task, so the next context continues it: its first
input is the open task blocks and the effects already made in this context,
preceded by one host line saying the context was reset mid-task and that the
steps already taken can be looked up in the history. Tool calls are not
replayed.

## Notes

Notes are the memory shared by every branch of a project. They are files on
LayerFS, written only through the note commands, so they merge and keep
history with the branch.

- **Fields:** id, title, a summary of at most 200 characters, body,
  visibility, revision, anchor. Lists show summaries; `note read` returns the
  body, paged.
- **Two tiers:** active notes go into every new bootstrap as a snapshot;
  archived notes are found by search. The model never manages activeness: at
  each rotation the host picks the active set by usage score - what the model
  cites, uses as evidence and reads, decayed by age - within a count and token
  budget. An optional `Judge` may adjust the score by a bounded share.
- **Quotas:** a cap on new notes per context, and a token budget on the active
  set that refuses growth and never tidying.
- **Anchors:** every write records where it happened (branch, context, event,
  evidence, range); the model never fills them in. `note context` restores
  the surroundings of a revision.
- **Revisions are append-only:** an anchor keeps working after the note is
  edited, archived or deleted.

## References and links

One reference format points at anything, in every tool argument and result:

| Ref | Points at |
| --- | --- |
| `n012@3` | note `n012`, revision 3 (`n012` alone means the latest) |
| `r4821` | an event |
| `c37` | a context |
| `t9` | a task |
| `m55` | a branch message |

A ref may carry a project and branch prefix, `shop:fix-cart/r42`; inside the
current project and branch the prefix is left out. The host records links
between refs (cite, evidence, range, origin, revision, handoff, message
reply), and every read appends one line of related items by weight with the
exact command that pages the rest. Credit for active-note choice flows
through links with depth 3, decaying 50/25/12.5 per hop, and a visited set so
a loop is walked once.
