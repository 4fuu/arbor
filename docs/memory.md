# Memory

Notes are the long-term memory. There is one copy, shared by every
window, written only through the note tools.

## Notes

- **Fields:** id, title, a summary of at most 200 characters, body,
  visibility, revision, anchor. Lists show summaries; `notes.read` returns the
  body, paged.
- **One copy, checked writes.** A write names the revision it read
  ([conflicts](#conflicts)).
- **Revisions are append-only.** An anchor keeps working after the note is
  edited, archived or deleted.
- **Budget:** a token budget on the active set, because the active set is
  part of every prefix. It refuses growth and never tidying. There is no cap
  on how many notes a window writes.

## Conflicts

A note conflict is resolved by the model that is writing, at the moment it
writes. Nothing is left for later and there is no tidying task.

- A write, replace or delete names the revision it read. When the note has a
  newer revision, the call is refused, and the refusal carries what changed
  since the revision it read: the revisions in between, their windows and
  the differences.
- The model merges those changes with its own and writes again against the
  current revision. If the two contradict each other, it decides which holds,
  reading the refs the revisions carry when it needs the evidence.
- A refused call changes nothing.

## The active set

Active notes go into the memory snapshot of every window
([windows.md](windows.md#prompt-layout)); archived notes are found by search.
The model never manages activeness. At each snapshot epoch the host picks the
active set by usage score - what windows cite, use as evidence and read,
decayed by age - within a count and token budget. The judge adds a bounded
share and never outweighs the model's own use.

Notes written since the snapshot reach later windows through their first
input, and live windows through notices.

## Anchors

Every write records where it happened - window, event, evidence, range - and
the model never fills it in. `notes.context(ref)` restores the surroundings
of a revision.

## Links and credit

Note revisions take part in the journal's links
([journal.md](journal.md#links-and-tracing)). Credit for the active set flows
through evidence and range links up to three hops, decaying 50/25/12.5, with
a visited set so a loop is walked once. A note gets its direct credit or its
linked share, whichever is larger.
