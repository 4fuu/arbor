# Windows

A window is one context window: a model run over one prompt. Windows are
disposable. Any number run at once, none of them owns a conversation, a file
or a task, and a window that ends loses nothing, because everything it did is
in the journal ([journal.md](journal.md)).

## Lifecycle

1. **Open.** The dispatcher opens a window for a task no live window should
   take ([dispatch.md](dispatch.md)), or the host opens one to continue a
   window that ended. The direct tools declared from outside the core are read
   again here, so the window opens with the set as it stands
   ([tools.md](tools.md#external-tools-that-change)).
2. **Run.** The model works and looks up what it needs. Related inputs enter
   at tool-call boundaries under the insertion rules, and so does a change to
   the tools the window may call.
3. **Idle.** When the model ends its run, the window stays open for a while
   (`window.idle_s`, default 300 s, matched to the provider's cache lifetime),
   so a related input can still be inserted into a warm prefix.
4. **Paused.** An operator holds insertion without ending the window; what
   waits for it goes in when it resumes
   ([dispatch.md](dispatch.md#insertion-timing)).
5. **End.** The idle time runs out, the model ends the window, or the window
   reaches its hard limit. An ended window is never reopened; work goes on in
   a new window. A `close()` is not an end of that kind: it stops the window and
   the next `start()` continues it ([restart](#restart)).

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
  most every `snapshot.minIntervalMs` (default 10 minutes), and only when notes,
  the environment ([environment.md](environment.md)) or the direct tools
  declared from outside the core ([tools.md](tools.md#external-tools-that-change))
  changed. Every window opened in one epoch has the same prefix. Changes since
  the epoch go into the first input.
- The prefix never changes while a window is open. Rendering is
  deterministic: no timestamps or counters in the system prompt or snapshot.
- **A plugin's prompt section can change under a running window.** It declares
  a revision, the host asks for it once per step, and a section that moved
  reaches the window as a delta of the changed lines at the next tool-call
  boundary - never by rebuilding its prefix
  ([prompting.md](prompting.md#plugin-sections-that-change)).
- Anything that changes per input - its time, people or items seen for the
  first time in this window - goes into the input itself.
- **The first input is the one thing a plugin may add to per window.**
  `beforeModelRequest` runs once, before the first turn, and the `inputs` it
  answers with are rendered into the first input
  ([architecture.md](architecture.md#hooks)). What the model writes in its own
  turn is recorded as an `assistant` event, so `windows.show` replays the
  window exactly as the model saw it ([journal.md](journal.md#events)).

## Streaming

A host surface can show a window's output while the model is still writing it.
The backend streams what the model writes, delta by delta, and the host hands
every delta to the `windowStream` hook and to whoever asked for that one window's
stream with `Arbor.stream(window, onEvent)` - the two ways code outside the core
sees them (docs/architecture.md#hooks):

- **`text_delta`** - assistant text, as it is written.
- **`tool_call_delta`** - one tool call's arguments, as they are written. What
  stands so far is what the delta carries, best-effort, because a call still
  being written is not valid JSON yet. What a window says to the outside is the
  `content` argument of the `send` direct tool (docs/tools.md#direct-tools), so
  this is what makes a window's answer readable before the call is complete.

The deltas of one window stay in order, and none of them is waited for: a
surface that shows them must never hold up the window's own events. Both ways
observe - they can neither change nor refuse anything.

**`Arbor.stream` is the per-window one.** An embedding host - the driver that
runs arbor inside another harness, a console, a chat bridge - takes the stream of
the window it drives and nothing else: no plugin to register, and no other
window's deltas to filter out. It answers with a function that lets the watcher
go again. A watcher taken after a delta was emitted does not receive it: streams
are best-effort and ephemeral, and the journal's durable events stay the only
record.

**Streams are best-effort and ephemeral.** They are not journaled, and the
journal's durable events stay the only record: a tool call is recorded once,
when it is complete, and a window that ends loses nothing. A backend that
cannot report deltas never emits them, and a hook that throws or is slow loses
its own deltas rather than the window.

## Usage reminders

Host reminders are appended to an input, never to the prefix. The series has
seven tiers, each with its own instruction: at 15 % write down what a later
window would need when there is no progress note yet; at 30 % change it when
something changed; at 50 % write up to what a continuation needs; at 60 % say
what the boundary is; at 70 % open no new large task; at 80 % rotate before new
work; a final one at `window - 2 x reserve` rotates now. Each carries the real
numbers, its place in the series, the window's open work named as the workspace
reports it ([workspaces.md](workspaces.md#open-work)) and, from 80 % on, the
cost of ignoring it. Only the highest crossed tier is sent; the lower ones it
jumped over are recorded as sent with it, so a window that crosses several
thresholds in one step hears every tier, in order.

## Ending and continuing

- `end(handoff?)` ends the run. With unfinished work it takes a handoff -
  current topics, progress, pending items, agreements, each with refs - and
  the host opens a continuation window whose first input carries the handoff
  and the previous window's ref. Details belong in notes and the journal.
  Unfinished work is what another window wrote on a target this one touched
  after it opened, and what the workspace reports as still open in this window
  ([workspaces.md](workspaces.md#open-work)) - the ovnfs workspace's unapplied
  checkouts, for instance. The task and the outside events the window was
  opened for, and the window's own `window_start`, are not open work, so a
  window that has done nothing ends cleanly. A refusal names what is open, so
  the handoff says what it has to carry.
- A continuation forks the previous window's workspace
  ([workspaces.md](workspaces.md)) and keeps its watermarks and its
  expectations ([coordination.md](coordination.md#expectations)). Its first
  input also names the work the chain left open, so the continuation picks it
  up by name.

## Hard limit

At `window - min(16k, window / 4)` the host ends the window by itself. The
run is usually half-way through a task, so the continuation's first input is
one host line saying the window was reset mid-task and that the steps already
taken can be looked up with `windows.show`, then the open tasks and the
effects already made. Tool calls are not replayed; nothing already sent is
sent again.

## Model failures

A model call that fails with a transient error - a rate limit, a 5xx, a
transport failure - is retried inside the backend, with the provider's own
classifier deciding what counts as transient. The retry sends the same bytes
in the same order, so the cached prefix still holds and nothing the model
already did is repeated.

A window whose run finally fails does not end its chain: the host opens a
continuation whose first input says the previous turn was cut short by a model
failure, that the steps already taken stand, and that what was already sent is
not sent again. The open tasks and the effects already made are listed with
it, exactly as they are after the hard limit. One interrupted continuation is
enough: a window that continues a failed one and fails again ends its chain,
because a model service that stays down must not chain windows for ever.

## Restart

The default backend keeps a run in memory and the journal is the only
persistent record. `close()` therefore only releases resources: it stops every
running window, lets the channels' push sources go and stops the services this
host started. It opens no continuation and starts no new turn, so a host that
closes changes nothing the journal does not already hold; each window it stopped
is recorded with the reason `host_restart`.

A host restart is a new host over the same journal. Its `start()` continues
every window that was still running and every window a `close` stopped, the way
the hard limit does; effects already made are not made again. A continued window
works in the directory its predecessor worked in, which the window chain in the
journal names ([workspaces.md](workspaces.md#what-the-framework-guarantees)); a
window that never touched files has none, and its continuation starts a fresh
one.
