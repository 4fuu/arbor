# Windows

A window is one context window: a model run over one prompt. Windows are
disposable. Any number run at once, none of them owns a conversation, a file
or a task, and a window that ends loses nothing, because everything it did is
in the journal ([journal.md](journal.md)).

## Lifecycle

1. **Open.** The dispatcher opens a window for a task no live window should
   take ([dispatch.md](dispatch.md)), or the host opens one to continue a
   window that ended.
2. **Run.** The model works and looks up what it needs. Related inputs enter
   at tool-call boundaries under the insertion rules.
3. **Idle.** When the model ends its run, the window stays open for a while
   (`window.idle_s`, default 300 s, matched to the provider's cache lifetime),
   so a related input can still be inserted into a warm prefix.
4. **End.** The idle time runs out, the model ends the window, or the window
   reaches its hard limit. An ended window is never reopened; work goes on in
   a new window.

## Prompt layout

```text
┌ system prompt ────────────────────── the same within one epoch ───┐
│ identity, general rules, direct tools one per line, modules one   │
│ per line, skills and MCP servers one per line                     │
├ memory snapshot ────────────────── the same within one epoch ─────┤
│ the active notes, by summary                                       │
├ first input ──────────────────────────── this window's own ───────┤
│ the task; the board lines related to it; for a continuation, the  │
│ previous window's ref and handoff; notes and environment changed  │
│ since the epoch                                                    │
├ inputs ───────────────────────────────────── append-only ─────────┤
│ inserted tasks, deliveries (messages, notices, broadcasts and     │
│ environment deltas), tool calls and results, reminders             │
└───────────────────────────────────────────────────────────────────┘
```

- Windows do not inherit another window's transcript. A transcript is used
  once, so its prefix rarely pays off in the cache; a standard prefix is
  shared by every window and stays cached.
- **Snapshot epochs.** The system prompt and memory snapshot are rebuilt at
  most every `snapshot.min_interval` (default 10 minutes), and only when notes
  or the environment ([environment.md](environment.md)) changed. Every window
  opened in one epoch has the same prefix. Changes since the epoch go into
  the first input.
- The prefix never changes while a window is open. Rendering is
  deterministic: no timestamps or counters in the system prompt or snapshot.
- Anything that changes per input - its time, people or items seen for the
  first time in this window - goes into the input itself.

## Usage reminders

Host reminders are appended to an input, never to the prefix: at 15, 30 and
50 % of the window, write down what a later window would need; at 60, 70 and
80 %, also end the window with a handoff; a final one at
`window - 2 x reserve`. Each carries the real numbers, its place in the
series and the cost of ignoring it. Only the highest crossed tier is sent; the
lower ones it jumped over are recorded as sent with it.

## Ending and continuing

- `end(handoff?)` ends the run. With unfinished work it takes a handoff -
  current topics, progress, pending items, agreements, each with refs - and
  the host opens a continuation window whose first input carries the handoff
  and the previous window's ref. Details belong in notes and the journal.
- Ending with unfinished work below 60 % of the window is refused, with the
  usage named.
- A continuation forks the previous window's workspace
  ([workspaces.md](workspaces.md)) and keeps its watermarks and its
  expectations ([coordination.md](coordination.md#expectations)).

## Hard limit

At `window - min(16k, window / 4)` the host ends the window by itself. The
run is usually half-way through a task, so the continuation's first input is
one host line saying the window was reset mid-task and that the steps already
taken can be looked up with `windows.show`, then the open tasks and the
effects already made. Tool calls are not replayed; nothing already sent is
sent again.

## Restart

A host restart ends every running window the way the hard limit does and
opens their continuations from the journal.
