# Windows

A window is one context window: a model run over one prompt. Windows are
disposable. Any number run at once, none of them owns a conversation, a file
or a task, and a window that ends loses nothing, because everything it did is
in the journal ([journal.md](journal.md)).

## Host platforms

A window runs on the host that opened it, and its command tool is named for the
shell that host gives it. On POSIX the tool is `bash`, `bash_output` and
`bash_stop`, and a command runs as `/bin/sh -c`. On Windows the tool is `pwsh`,
`pwsh_output` and `pwsh_stop`, and a command runs in a fresh PowerShell process
(`pwsh` when it is installed, Windows PowerShell 5.1 otherwise) with UTF-8
output. The wait window, the background job, the result cut, the environment and
the secret scrub are the same on both hosts; what differs is the executable and
its argv, the tool names, the shell edition the tool's description states, and
how a stop ends the job.

The edition is on the description because the two are not one language: `&&` and
`||` exist only in PowerShell 7, so a window told "PowerShell" without the
edition writes syntax that Windows PowerShell 5.1 refuses. `shellFor` resolves
the executable first and the description names what it resolved - `PowerShell 7`
for `pwsh`/`pwsh.exe`, `Windows PowerShell 5.1` for `powershell.exe`. A POSIX
host has one shell, so its description names none.

## Background jobs and stop

A command that outlives the wait window keeps running as a background job, and
is followed with the output tool and ended with the stop tool. **A stop ends the
job and its descendants, not just the shell process.** That is what makes the
job close: a child the command started inherits the job's stdio pipes, so a stop
that ended only the shell would leave the child holding them, `close` would
never fire, and the job would read as running for ever.

- **POSIX** gives each command its own process group (`detached`), and a stop
  sends `SIGTERM` to that group, so everything the command started receives it
  too. A group that is already gone is not an error.
- **Windows** runs `taskkill /PID <pid> /T /F`, which ends `pwsh.exe` and every
  process below it. When `taskkill` cannot start at all, the stop falls back to
  ending the shell process itself.

A job that has already ended is never signalled: its pid may belong to another
process by then.

## Lifecycle

1. **Open.** The dispatcher opens a window for a task no live window should
   take ([dispatch.md](dispatch.md)), or the host opens one to continue a
   window that ended. The direct tools declared from outside the core are read
   again here, so the window opens with the set as it stands
   ([tools.md](tools.md#external-tools-that-change)). The window opens
   **idle**: opening it starts no run by itself, and a backend that opens a
   window before it can start a turn - an embedding's window continued before
   its session is resumed - leaves it idle until one starts.
2. **Run.** The model works and looks up what it needs. Related inputs enter
   at tool-call boundaries under the insertion rules, and so does a change to
   the tools the window may call. The window is **running** from the first
   event the backend reports of that run - a tool call or result, a stream
   delta, what the model writes - until the run ends. A usage report says what
   the run cost and is not by itself a sign the run is still going: it arrives
   when a message ends, which can be the last thing before the run's end. A
   window with no run in progress never says running.
3. **Idle.** When the model ends its run, the window returns to idle and stays
   open for a while (`window.idleSeconds`, default 300 s, matched to the
   provider's cache lifetime), so a related input can still be inserted into a
   warm prefix. A finished round does not end the window: the next related
   input continues here, with its context intact.
4. **Paused.** An operator holds insertion without ending the window; what
   waits for it goes in when it resumes
   ([dispatch.md](dispatch.md#insertion-timing)).
5. **End.** The idle time runs out, the model ends the window, or the window
   reaches its hard limit. An ended window is never reopened; work goes on in
   a new window. A `close()` is not an end of that kind: it stops the window,
   and a window that was mid-turn or had unfinished work is continued by the
   next `start()`, while one that was idle waits for the next input routed to
   its targets to open its continuation ([restart](#restart)).

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
  the epoch go into the first input. The one exception is a prompt section that
  declares itself per window, which is rendered for each window rather than
  frozen with the epoch, so that window's prefix is its own where that section is
  concerned ([prompting.md](prompting.md#plugin-sections-that-change)).
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

## What a window serves

A window owns nothing - not a conversation, not a file, not a task - so nothing
in the core names whose work a window is doing. An embedding that has units of
its own - a session in the harness arbor runs inside, a conversation handle, a
job - can name one on the task that opens the window, or once on the task source
that serves it:

- `TaskInput.label` is an opaque string the embedding attaches and arbor never
  interprets. `TaskSource.label` is the same, declared once and stamped on every
  task that source makes which names none of its own.
- The host carries it without reading it: on the window, on that window's
  continuations, and on the `window_start` event each of them records, so a
  restart rebuild hands it to the continuation it opens. A `task` event records
  the label the task carried too.
- A prompt section that declares itself `perWindow` is handed it as
  `content(window, label)`, so the section can say which session the window it
  is rendering for belongs to
  ([prompting.md](prompting.md#plugin-sections-that-change)).

Nothing else reads it: the label is not rendered into the prompt by the core, is
not a target, is not a ref, and changes nothing about routing. An embedding that
needs to map its own windows back to its own sessions reads the label from the
window it drives, from a continuation's request or from the journal - never from
a map it has to keep in step itself.

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
what the boundary is; at 70 % open no new large task; at 80 % hand over before
new work; a final one at `window - 2 x reserve` hands over now. Each carries
the real numbers - used, limit, the share used and what is left - the window's
open work named as the workspace reports it
([workspaces.md](workspaces.md#open-work)) and, from 80 % on, what happens at
the hard limit. There is no series count: the head line is every tier's first
line. Only the highest crossed tier is sent; the lower ones it jumped over are
recorded as sent with it, so a window that crosses several thresholds in one
step hears every tier, in order.

## Ending and continuing

- `end(handoff?)` ends the run. Without unfinished work it is the plain end:
  the window ends, and the next input for its targets opens a new one. With
  unfinished work it takes a handoff whose fields are exactly `topics`,
  `progress`, `pending` and `agreements`, each an array of strings, and
  optional `refs`, an array of refs. The host opens a continuation window whose
  first input carries the handoff and the previous window's ref. Details belong
  in notes and the journal.
  Unfinished work is what another window wrote on a target this one touched
  after it opened, and what the workspace reports as still open in this window
  ([workspaces.md](workspaces.md#open-work)) - the ovnfs workspace's unapplied
  checkouts, for instance. The task and the outside events the window was
  opened for, and the window's own `window_start`, are not open work, so a
  window that has done nothing ends cleanly. A refusal names what is open, so
  the handoff says what it has to carry.
- **A handoff has a floor.** With nothing unfinished and the window below
  `window.handoffFloor` (a fraction of the context window, 0.6 by default), an
  `end` carrying a handoff is refused, rule `end.handoff.early`. The refusal
  gives the share used and the floor, and says the next action is not to call
  `end` at all: the round can simply finish, and the window stays idle for the
  next input. With unfinished work a handoff is always accepted, because the
  work itself requires it, and an `end` without a handoff is never limited by
  the floor.
- **A handoff is never dropped.** A handoff in any other shape - a field
  named something else, a string where an array belongs, a required field
  left out - is refused in the core's error shape, rule
  `end.handoff.invalid`, with the next action naming the four fields. The
  window stays open, so the model can call `end` again with the right shape.
- A continuation forks the previous window's workspace
  ([workspaces.md](workspaces.md)) and keeps its watermarks and its
  expectations ([coordination.md](coordination.md#expectations)). Its first
  input also names the work the chain left open, so the continuation picks it
  up by name.

## Hard limit

At `window - min(16k, window / 4)` the host ends the window by itself. The
run is usually half-way through a task, so the continuation's first input is
one host line saying the window ended mid-task by the host and that the steps
already taken can be looked up with `windows.show`, then the open tasks and the
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

The host's own timers - a window's idle end, a chain's retention reclaim, a
held window's retry - do not keep the process alive: how long the process runs
is the embedder's to decide, through its channels or its own lifetime. A
process that ends without `close()` loses nothing the journal does not hold;
the next host's `start()` continues what was running and what had unfinished
work, and leaves an idle window for the next input that routes to it.

A host restart is a new host over the same journal. Its `start()` continues
only a window that was mid-turn or has unfinished work - an unmerged checkout,
a target with events the window has not seen - the way the hard limit does;
effects already made are not made again. A window that was idle when it was
stopped is not continued at `start`: its chain stays resumable, and the first
task the dispatcher routes to its targets opens the continuation then, as a
continuation of that window - the same `window_start` link, the same working
directory, and the reason a restart records. A resumable chain keeps its
directory for `workspaces.retentionMs` counted from its stop; resuming it
cancels that reclaim, and a reclaim that fires first ends its resumability, so
the next input opens a new chain. With no retention period set, nothing is
reclaimed and the chain stays resumable
([workspaces.md](workspaces.md#lifecycle)). A window another window's
`window_start` already names as the one it continues is not unfinished: only
the chain's live end is continued, so recovery opens at most one continuation
per chain end, however many restarts the chain has been through and whether
that continuation opens at `start` or with that first task. A continued window
works in the directory its predecessor worked in, which the window chain in the
journal names ([workspaces.md](workspaces.md#what-the-framework-guarantees)); a
window that never touched files has none, and its continuation starts a fresh
one.
