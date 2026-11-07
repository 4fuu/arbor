# Memory

Notes are the long-term memory. There is one copy, shared by every
window, written only through the note tools.

## Notes

- **Fields:** id, title, a summary of at most 200 characters, body,
  revision, anchor. A write and a replace may name `refs`, which the host
  records as the write's evidence. Lists show summaries; `notes.read` returns
  the body, paged.
- **One copy, checked writes.** A write names the revision it read
  ([conflicts](#conflicts)).
- **A replace that changes the body names a summary**, so a list never shows
  yesterday's line on today's note. A replace that names no summary keeps the
  one the note has; a new note takes the opening of its body as its summary.
- **Revisions are append-only.** An anchor keeps working after the note is
  edited, archived or deleted. A delete leaves every revision and every ref to
  them resolving, and no list, search or active set returns the note again.
- **Budget:** a token budget on the active set, because the active set is
  part of every prefix. The budget bounds the set and never tidies it: a note
  that does not fit waits for the next epoch. There is no cap on how many
  notes a window writes. Every note write's result reports where the budget
  stands, so a window hears how full it is.

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

### Snapshot epochs

The active set is frozen with an epoch. At most every `snapshot.minIntervalMs`
(default 10 minutes), and only when a note was written since the last epoch or
the budget changed, the host builds a new one. Every window opened in one epoch
has the same prefix; what changed since reaches it as a delta.

- `notes.snapshot()` returns the epoch's version, its time and the active notes
  by summary, with the summaries the epoch froze. A note revised during the
  epoch keeps its frozen summary; the current one is what a list shows.
- `notes.delta(epoch)` returns what changed since one: every note written after
  it, as `created`, `revised` or `deleted`.
- `notes.score()` returns the candidates with their usage scores, which is the
  state the judge's `active set` decision reads.
- `notes.recordUse` is how the host feeds the uses the store cannot see - an
  event that cited a note or held it as evidence. One event is recorded once.
  A `send` that cites notes is a use of them, so the host records each note ref
  it names; `note_write` and `note_replace` name the refs they carry in `refs`,
  which the host records as the write's evidence as well.

A note's score is its direct credit - what windows cite, use as evidence and
read, decayed by age - or the share that reached it through evidence links up
to three hops, whichever is larger. A deleted note earns nothing and passes
nothing on. A note with no use is not picked: freshness reaches a window
through the delta, not through the snapshot.

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

## Search

Note search is lexical and built for Chinese and mixed text, the same model the
journal searches with ([journal.md](journal.md#search)): a word index by jieba
segmentation with BM25, a trigram index for exact substrings, and a fallback for
one- or two-character queries. Results are merged, exact substring hits first,
and then by relevance, so a page is stable however it is paged.

The word index segments the title, the summary and the body, and BM25 ranks the
three fields against each other: a hit in the title counts ten times one in the
body and a hit in the summary four times, because the title names the note and
the summary is its one line. `@4fu/arbor-segmenter-jieba` is the default segmenter
and an optional peer of the store, exactly as it is of the journal; when it is
not installed, the per-character-and-bigram approximation answers instead.

A one- or two-character query has no trigram of its own, so the `LIKE` scan
answers it, in id order. Every write re-indexes the note it changed and a delete
takes the note out of both indexes, so a search sees the current title, summary
and body, and never a deleted note.

### The semantic channel

A query whose meaning matches a note but whose words do not finds nothing
lexically. A deployment that wants that installs `@4fu/arbor-search-zvec`, which
the store takes as an optional peer exactly as the journal does: note text is
embedded and searched by meaning with zvec, an embedded vector database. The
channel is absent - and search is exactly what the paragraphs above describe -
when the package is not installed, when zvec's prebuilt binary does not load on
the platform, when another host holds the vector store's `LOCK`, or when no
embedding model is available ([journal.md](journal.md#the-semantic-channel)).

The channel holds one vector per note, over the note's title, summary and body
as one text in the order the lexical index weights them: the title names the
note and the body is its content, and one vector cannot weigh a note's parts
against each other the way BM25 weighs the three columns. A note's vector is
replaced when its revision is replaced and erased when the note is deleted, and
`store.catchUpSemantic()` indexes the notes the channel does not hold: after a
restart over an existing database, once the model arrives, and after an indexing
attempt that failed.

The channel's hits merge with the lexical ones the same way: exact substring
hits first, then word hits, then the hits only the semantic channel found. The
filters a read applies are the store's own and are applied to what the channel
returns, because none of them is a field the channel can hold: a note's status
changes at every snapshot epoch without a revision, and `about` and `linked` are
bounds the journal resolved. A page is stable however it is paged.
