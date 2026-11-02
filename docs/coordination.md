# Coordination

Windows run in parallel without locks. They work together through three
things - the board, notices and window messages - and stay consistent through
checks at the moments their work becomes visible.

## The board

The host keeps one line per live window, from the journal:

| Field | Source |
| --- | --- |
| window | its ref, `c41` |
| doing | its first task's title, until the model sets a line with `board.set` |
| targets | the targets it has touched |
| state | running or idle, and its usage |

A new window's first input carries the board lines related to its task.
`board.list` shows the rest.

## Notices

When an event touches a target, every other live window that touched the same
target is a candidate for a notice. The judge decides which ones need it
([dispatch.md](dispatch.md#judge-decisions)); each of those gets one input
block with the event's opening words and its ref. The host writes no summary;
the ref leads to the full event.

## Window messages

- `windows.send(to, text, reply_to?)` sends a message to another live window.
  A message to an ended window is refused with the next action named: read its
  history, or address a live one.
- `windows.yield(to, note?)` hands the current task to another live window,
  for example one already doing the same thing. The task enters that window
  under the insertion rules.
- A reply is routed back as an input block; a sender never blocks waiting for
  one.
- The send and the delivery are events, linked to each other.
- A chain of replies has a hop limit, and each window has a send rate limit;
  both refusals name the reason and the next action.

## Consistency checks

| Moment | Check | When it fails |
| --- | --- | --- |
| a send to a conversation | no event on that conversation is newer than the window's watermark | refused with the newer events' refs; read them, then send again |
| a note write | the revision is the one the window read | refused with the current revision; read it, then write again |
| a file publish | LayerFS three-way merge into `main` | the host makes a conflict task ([workspaces.md](workspaces.md#conflicts)) |

Reading the refs a refusal names moves the window's watermark, so the next
attempt passes unless something newer arrived meanwhile. Everything else runs
unchecked.

## Effects

An effect takes place when it is made and cannot be rolled back. So:

- Every effect goes through one effect queue per host, which paces effects
  and executes each exactly once, in the order made. Effects on one target are
  serial.
- Each effect is recorded as an event; continuations and restarts never
  repeat it.
- A send that answers an outside message names it in `reply_to`, so a
  conversation with several windows in it stays readable.
