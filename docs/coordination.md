# Coordination

Windows run in parallel without locks. They work together through the
board and through deliveries - window messages, notices and broadcasts - and
stay current because new events on their conversations are steered into
them.

## The board

The host keeps one line per live window, from the journal:

| Field | Source |
| --- | --- |
| window | its ref, `c41` |
| doing | its first task's title, until the model sets a line with `board.set` |
| targets | the targets it has touched |
| expects | what it expects to be routed to it, set by the model with `board.expect` ([below](#expectations)) |
| state | running or idle, and its usage |

A new window's first input carries the board lines related to its task.
`board.list` shows the rest.

## Expectations

A window can say what it expects to arrive, so the input reaches it instead
of a new window:

- **Exact:** a specific outside item, thread or whole conversation - the CI
  result of
  `gh:pr:57`, a reply from one person in `qq:group:123`, an issue. A matching
  input goes to this window by the hard rule
  ([dispatch.md](dispatch.md#routing)).
- **Described:** one sentence, such as "the user will send a screenshot of the
  checkout error". It is not a rule: it joins the window's profile for the
  judge, and the window is always a candidate.

Rules:

- Expectations end with the window; a continuation inherits them.
- When several windows expect the same item, the judge chooses among them.

## Deliveries

Every delivery is an input block that enters a window at a tool-call
boundary. The kinds differ only in who receives them:

| Kind | Receivers | Filtered by |
| --- | --- | --- |
| window message | one live window | nobody |
| conversation update | live windows that touched the conversation ([below](#staying-current)) | nobody |
| notice | live windows that touched the event's target | the judge |
| broadcast | every live window | the judge, except for environment deltas |
| environment delta, prompt delta, tools delta | every live window | nobody ([below](#broadcasts)) |

Outside traffic - a message from a channel, or the result of a send - keeps a
conversation current, so it reaches every live window that touched the target
and is behind on it, unfiltered and not held back by the protection period. Any
other event is news about a target, so every *other* live window that touched it
is a notice candidate and the judge decides which ones need it.

## Notices

When an event touches a target, every other live window that touched the same
target is a candidate for a notice. The judge decides which ones need it
([dispatch.md](dispatch.md#judge-decisions)); each of those gets one input
block with the event's opening words and its ref. The host writes no summary;
the ref leads to the full event.

## Broadcasts

- **Environment deltas** ([environment.md](environment.md#deltas-in-a-window))
  go to every live window, unfiltered and not held back by the protection
  period, because they change what a window can call. So does a **tools delta**
  - the direct tools a plugin or a backend declared that appeared or were
  removed while the host runs
  ([tools.md](tools.md#external-tools-that-change)) - and a plugin's prompt
  section that moved ([prompting.md](prompting.md#plugin-sections-that-change)).
- **Model broadcasts.** `windows.broadcast(text)` offers a message to every
  live window; the judge decides for each one whether it needs it
  ([dispatch.md](dispatch.md#judge-decisions)).
- A broadcast wakes no window. A running window gets it at its next tool-call
  boundary, an idle one when it next runs; an ended window gets nothing, and
  a new window gets the environment through its prefix or first input.
- Every broadcast block carries one fixed host line: it is a broadcast, it
  needs no reply, and when one is really needed it goes to the sender as a
  window message. A broadcast cannot be replied to as such, so it starts no
  chain of replies.

## Window messages

- `windows.send(to, text, reply_to?)` sends a message to another live window.
  A message to an ended window is refused with the next action named: read its
  history, or address a live one.
- A reply is routed back as an input block; a sender never blocks waiting for
  one. The block names the message's own ref, so a reply can name it in
  `reply_to`.
- The send and the delivery are events, linked to each other.
- A chain of replies has a hop limit (5), so two windows cannot answer each
  other forever; the refusal names the reason and the next action. The count
  rides on the `reply` link each message was sent with, so a limit costs no
  walk of the chain.

## Staying current

A window that has touched a conversation gets every new event on it as it
arrives: each is steered in at the next tool-call boundary, unfiltered and
not held back by the protection period. So a window rarely acts on stale
input, and nothing is refused for it. A window only hears about what it has not
seen: its watermark decides.

- A send goes out as made. If events on the conversation arrived after the
  window's watermark and have not reached it yet, the send's result says how
  many and that they come with the next turn; whether to add anything is the
  model's call.
- A note write is the one checked write: it names the revision it read, and
  a stale one is refused with the changes since
  ([memory.md](memory.md#conflicts)).

## Effects

An effect takes place when it is made and cannot be rolled back. So:

- Every effect goes through one effect queue per host, which paces effects
  and executes each exactly once, in the order made. Effects on one target are
  serial.
- Each effect is recorded as an event; continuations and restarts never
  repeat it.
- A send that answers an outside message names it in `reply_to`, so a
  conversation with several windows in it stays readable.
- Each effect's result is an event of its own, and it goes back out: the
  window that made the effect hears whether it was carried out, in the one
  line the text table holds - `result.effect.ok` or `result.effect.failed`,
  with the reason. A window's own effect result is the answer to what it
  sent, so the rule that keeps a window from hearing about its own events
  does not apply to it.
