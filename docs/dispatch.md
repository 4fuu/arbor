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
- a **service event**: a service's state change, or an event a service
  appended ([environment.md](environment.md#services)).

The host makes no tasks of its own for maintenance; work that needs judgment
is the agent's ([overview.md](overview.md#principles)).

A task carries its targets, a reason, a time and its content, rendered as an
input block. A batch that names the agent directly is `explicit`, and the
source is the one that knows. A task may also carry an opaque `label` naming
what it serves, which the host carries to the window, its continuations and the
journal and never interprets
([windows.md](windows.md#what-a-window-serves)).

The host records a task and the outside events it batches before anything
decides about them, so a ref names both from the start: the events as `input`
events and the task as a `task` event, linked to them. `Arbor.dispatch(task)`
routes one.

`Arbor.ingest(events)` is where outside events become tasks:

- A **task source claims the events of the source it names** - the
  `OutsideEvent.source` a channel or a service stamps on them, matching the
  source's own `id`. The host hands those events to that source's `toTasks` and
  dispatches what comes back, exactly as it stands. Batching and debouncing are
  the source's business and the host does none of its own for them, so a burst
  of messages becomes the one task the source says it is - one window, one
  interruption - instead of a task per message. A source that debounces keeps
  its own buffer and hands its batch over when it is ready.
- A **source with its own `subscribe`** is subscribed the way a channel's is,
  at `start`: what it pushes goes through `ingest`, and is then claimed by that
  same source.
- **What no source claims** keeps the host's own grouping: one task per target,
  which is the host's debouncing for a source that hands events over as they
  arrive.

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

Every dispatch answers with one result: the task's ref, the window that took it
or `null`, and how it got there - `filtered`, `hard_rule`, `judge`, `fallback`,
`waiting` while the backend's rate limits hold it, `redelivered` for a batch of
nothing but messages the journal already holds, or `refused` when a hook
stopped it. A refusal is not an error: the rule is recorded as a `dispatch`
event, the task goes nowhere, and the push source that handed the batch over
reads the result like any other
([architecture.md](architecture.md#hooks)).

## Judge decisions

Every decision is one judge request with its questions batched, inside rules
in code that never move, with a fallback when the judge is unreachable. The
default judge is Jev; every decision is on by default, and each can be set to
`off`, `shadow` (asked and logged, acts on nothing) or `on`.

| Decision | Question | Rule bound | Fallback |
| --- | --- | --- | --- |
| filter | does this batch need handling | explicit requests always pass | pass |
| route | how well does each candidate window fit this task | the hard rule first; at most 8 candidates | a new window |
| model tier | which tier of model does a new window need ([below](#model-tiers)) | only configured tiers | the default tier |
| notice | does this window need to know about this new event ([coordination.md](coordination.md#notices)) | only windows that touched the event's target | no notice |
| broadcast | does this window need this broadcast ([coordination.md](coordination.md#broadcasts)) | environment deltas are never filtered | deliver |
| active set | is this note still needed ([memory.md](memory.md#the-active-set)) | a bounded share of the score | the rule score alone |

- The judge decides whether, where and when. It never writes text; the model
  owns content.
- Every request is scrubbed of secrets on the way out, and every decision is
  logged with its scores and the state the judge saw.
- A window's profile for the judge is assembled by the host, with no extra
  model call: its tasks, the targets it touched, its board line with its
  expectations, its last inputs.

### Where the thresholds live

A judge answers with its own reading, and the threshold that turns a reading
into an action is the service layer's, in code that never moves
(`packages/core/src/dispatch.ts`): a batch passes at probability 0.5, a
candidate takes a task at "good fit" on the route scale's own 0 to 3 levels, a
notice and a broadcast at 0.5, and a note is still needed at the top level of
the active set's 0 to 2. The same answer therefore produces the same action
whatever judge is wired in, and a threshold is tuned from the decisions the
journal recorded rather than by swapping a module.

The answer types carry the reading alongside the boolean: `score` on
`FilterAnswer` and on each `WindowDecision`, and `scores` on `ActiveSetAnswer`.
Both are optional and additive, so a judge that answers with a bare boolean is
read as it stands; the service layer uses the reading when the answer carries
one.

### The default judge

Jev is TypeSafe AI's System One classifier, served by `@4fu/arbor-judge-jev`. It is
not a chat model and not a pi provider: one request posts one JSON state and
several typed questions about it to `POST /v1/systemone`, and every answer comes
back with its score or probability. A bool question is `yes`/`no`, a score
question is a level on the question's own scale, and a choice question names one
option - which is how `model tier` picks among the configured tiers. The
questions and their state follow [prompting.md](prompting.md#judge-questions).

- **Configuration.** `JEV_API_KEY` names the secret; the key is read per
  request, so one that appears later applies to the next decision. The model id
  is `jev-latest` and the service is `https://api.typesafe.ai/v1`; a deployment
  overrides either.
- **Modes.** The judge answers what it is asked in `shadow` exactly as in `on`,
  and the mode rides on the decision's log record. A decision that is `off` asks
  nothing at all and is answered with that decision's own default from the table
  above, so a decision that acts on nothing costs no request.
- **Unreachable.** A missing key, a transport failure or an answer of the wrong
  shape is refused in the core's error shape - code `unavailable`, rule
  `judge.jev.unreachable`, and the next action naming the rule fallback. The
  judge never fabricates an answer, so the fallback is the only thing that
  changes.
- **Logging.** Every decision is logged with the state the judge saw (after
  scrubbing), the questions, every answer with its score or probability, the
  token usage and how long it took, so a threshold is tuned from real
  decisions. The service layer records its own reading of the same decision -
  the decision, its mode, the state, the answer, and whether it was answered -
  as a `judge_decision` event, and the judge records its request as a
  `judge_request` event.
- **Wired in.** The judge is its own package and answers only; the service layer
  holds the rule bounds and the fallbacks around it, and the default judge is
  Jev (`ArborOptions.judge` replaces it).

## Insertion timing

A running window receives inserted tasks and deliveries
([coordination.md](coordination.md#deliveries)) at a tool-call boundary: once
every tool call of the current turn has finished, before the next model
request. The host inserts through the backend's own steering (pi's
`agent.steer`); the rules below only decide when it calls it. An input meant
for after the run goes in as a follow-up (`agent.followUp`).

The two calls are the whole contract a backend implements
(`WindowSession.steer` and `WindowSession.followUp` in
`@4fu/arbor-interfaces`): a steered delivery is one user-role input the model
reads with its next request, in order and exactly once, and it never ends the
turn; a follow-up is held out of the turn the window is in and becomes the input
of its next one. A window that is idle is continued by a steered input, because
that is what a related input wants.

### Context and input

Every delivery carries `role`, which says what it is to the turn it enters
(`Delivery` in `@4fu/arbor-interfaces`). The host marks every delivery it makes,
so a backend reads the mark instead of working it out from the kind:

| Role | Kinds | What a backend does |
| --- | --- | --- |
| context | environment delta, prompt delta, tools delta, broadcast | deliver it, and start no turn: the model reads it with its next request |
| input | inserted task, conversation update, notice, window message, reminder | deliver it, and continue an idle window, because that is what a related input wants |

A context delivery is what the window's own prompt or its surroundings now
hold. Steering one into a quiet window must leave the window quiet: a window
that ran a turn from a steered delta would act on a change to its own prompt
before anything asked it to, and a harness around the host would see a turn
start from a loop of its own. The block waits for the next turn that is already
coming, and is read with it. An input delivery is something for the window to
act on, so it is what continues an idle window - the same rule a reminder
follows, which the host steers while the window runs and queues as a follow-up
once the run has ended.

- **Protection period** (default 60 s, configurable, 0 inserts at once): when
  a window starts on a target, only inputs for that target enter during the
  period. Inputs for the same target do not restart it. Environment deltas,
  conversation updates, prompt deltas and tools deltas are not held back.
- **After the period:** an input for the current target that is still being
  batched goes in first; then the others, by priority and age. Currency and
  what a window can call - a conversation update, an environment delta - and a
  direct answer to it, a window message, outrank anything that only informs it;
  a broadcast, which needs no reply, goes last.
- **No insertion after the final usage reminder.** Waiting inputs are
  dispatched again: an inserted task is routed from the top, and a delivery
  nobody will take any more is dropped.
- **Paused:** nothing is inserted, and nothing is dispatched again either - the
  window is held, not finished with.

The model sees only input blocks; it never manages timing.

## Backpressure

There is no cap on windows. How many run at once is bounded by the backend:
when it reports rate limits (`AgentBackend.rateLimits`), new windows wait in a
queue ordered by priority and age, and the host asks again after the retry the
limit names. A backend that reports nothing is never limited.

## Model tiers

When a new window opens, the judge picks a tier for it - for example light
for chat, strong for code - and settings map each tier to a model from the
backend's catalog ([architecture.md](architecture.md#models)). A
continuation keeps its window's tier.

The choice question offers the configured tiers, and describes each one with
what `settings.judge.tierCriteria` says it is for: one line of text per tier
name. A tier the settings name no text for is described only generically, so a
deployment whose tiers are not the judge's own says what they are for instead
of leaving the judge to guess.

## Scheduled tasks

A scheduled task is a task source driven by time: a first time, a repeat rule,
optional daily skip periods, optional targets. Spreading colliding repeating
tasks apart and their jitter are settings, off by default. The model manages
them through the `schedule` module - `create`, `update`, `cancel` and `list`
([tools.md](tools.md#modules)) - and every change is one service call the host
records, so a restart restores a schedule that has not fired yet.

A repeat rule is one of three: a period in milliseconds, a clock time it fires
at daily, or days of the week - `0` for Sunday - with the clock time it fires at
on them. Any of them may carry two bounds: `times`, how many more times it
fires after the first, and `until`, the last moment it may fire at. The count of
firings rides on the schedule's record, so a restart neither repeats a firing
that already happened nor extends a rule that is spent.

Jitter comes from the scheduler's own random source, `Math.random` by default.
A deployment that wants a repeating task's timing to be the same across a
restart passes a seeded source to `RuleScheduler` and passes the same one again
after the restart.
