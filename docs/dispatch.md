# Dispatch

Dispatch decides, for every task, whether a live window takes it or a new
window opens. There is no main line and no router session: rules decide what
they can, and the `Judge` decides the rest
([architecture.md](architecture.md#interfaces)).

## Tasks

A task is one unit of input:

- a **batch** of outside events from a `TaskSource`. Batching is the source's
  business; a chat source debounces per conversation, so several messages
  sent in a row become one task;
- a **scheduled** firing ([below](#scheduled-tasks));
- a **system** task the host makes for a hard operation
  ([below](#system-tasks)).

A task carries its targets, a reason, a time and its content, rendered as an
input block.

## Routing

1. **Filter.** The judge decides whether the batch needs handling at all.
   Explicit requests always pass.
2. **Hard rule.** A batch that replies to or quotes something a live window
   produced, or matches a window's exact expectation
   ([coordination.md](coordination.md#expectations)), goes to that window.
3. **Judge.** Candidates are the live windows that share a target with the
   task, describe an expectation, or worked recently, at most 8. The judge
   scores each, against one more option: a new window.
4. **Act.** The best candidate above the threshold takes the task as an
   inserted input; otherwise a new window opens, and its first input lists the
   live windows related to the task.

A window that has had its final usage reminder, or is near its hard limit, is
not a candidate.

## Judge decisions

Every decision is one judge request with its questions batched, inside rules
in code that never move, with a fallback when the judge is unreachable. The
default judge is Jev; every decision is on by default, and each can be set to
`off`, `shadow` (asked and logged, acts on nothing) or `on`.

| Decision | Question | Rule bound | Fallback |
| --- | --- | --- | --- |
| filter | does this batch need handling | explicit requests always pass | pass |
| route | how well does each candidate window fit this task | the hard rule first; at most 8 candidates | a new window |
| notice | does this window need to know about this new event ([coordination.md](coordination.md#notices)) | only windows that touched the event's target | no notice |
| active set | is this note still needed ([memory.md](memory.md#the-active-set)) | a bounded share of the score | the rule score alone |

- The judge decides whether, where and when. It never writes text; the model
  owns content.
- Every request is scrubbed of secrets on the way out, and every decision is
  logged with its scores and the state the judge saw.
- A window's profile for the judge is assembled by the host, with no extra
  model call: its tasks, the targets it touched, its board line with its
  expectations, its last inputs.

## Insertion timing

A running window receives inserted tasks, notices and window messages at a
tool-call boundary:

- **Protection period** (default 60 s, configurable, 0 inserts at once): when
  a window starts on a target, only inputs for that target enter during the
  period. Inputs for the same target do not restart it.
- **After the period:** an input for the current target that is still being
  batched goes in first; then the others, by priority and age.
- **No insertion after the final usage reminder.** Waiting inputs are
  dispatched again.
- **Paused:** nothing is inserted.

The model sees only input blocks; it never manages timing.

## Backpressure

There is no cap on windows. How many run at once is bounded by the backend:
when it reports rate limits, new windows wait in a queue ordered by priority
and age.

## Scheduled tasks

A scheduled task is a task source driven by time: a first time, a repeat rule,
optional daily skip periods, optional targets. Spreading colliding repeating
tasks apart and their jitter are settings, off by default.

## System tasks

When a hard operation needs a model, the host makes it a task with
instructions and dispatches it like any other:

| Task | Made when | Goes to |
| --- | --- | --- |
| resolve a file conflict | a publish conflicts ([workspaces.md](workspaces.md#conflicts)) | the window that published, if live; otherwise a new window with its ref |
| clean up a workspace | a workspace has been unpublished and unused for a set time | a new window with its ref |
