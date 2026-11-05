# Journal

The journal is the one record. Every window appends to it and reads
from it; an event is visible to every window as soon as it is written. It is
append-only: nothing is edited, nothing is deleted, nothing merges.

## Events

| Field | Meaning |
| --- | --- |
| `id` | the event's ref, `r902`; its number is the event's place in the one global order |
| `window` | the window that wrote it, `c41`; empty for an outside event not yet dispatched |
| `time` | when it was written |
| `kind` | input, tool call, tool result, send, note revision, window start or end, ... |
| `targets` | what it touches (below) |
| `refs` | the refs it names: what it answers, cites, continues or quotes |
| `external` | the native id of an outside message, with a short channel prefix |
| `snapshot` | the workspace snapshot, for an event that changed files |

Events have one global order: the number in their id, assigned at append and
only growing. Watermarks and every comparison use it; `time` is for display
only.

## Targets

A target is anything two windows can collide on:

| Target | Example |
| --- | --- |
| conversation | `qq:group:123`, `qq:private:456` |
| file | `file:src/cart.ts` |
| note | `n012` |
| outside item | `gh:issue:42`, `gh:pr:57` |
| service | `svc:crawler` |

The host fills `targets` from the event itself - the conversation of an input,
the target of a send, the paths a tool read or wrote, the note it changed. The
model never fills it in.

Targets serve three things with one index: dispatch candidates
([dispatch.md](dispatch.md)), steering new events into the windows in a
conversation, and notices between windows
([coordination.md](coordination.md)).

## Watermarks

For every target a window has touched, the host keeps the newest event on
that target the window has seen - in its prompt, in a tool result, or by
writing it. A target with events newer than the window's watermark is one the
window is behind on. Steering keeps a window's watermarks current, and a
send's result says when it is still behind
([coordination.md](coordination.md#staying-current)).

## External ids

- An outside message keeps its native id, with a short channel prefix:
  `qq:12345`. No second id is made up for it.
- The id has a unique index, so a redelivered message is stored once.
- The ref works anywhere a ref is taken, and keeps working after its channel
  is unplugged.
- A `Channel` answers lookups by native id. When the channel is offline, the
  lookup returns the stored copy and says the channel is offline. A channel
  plugged back in matches the same ids.

## Refs

One reference format points at anything, in every tool argument and result:

| Ref | Points at |
| --- | --- |
| `r902` | an event |
| `c41` | a window |
| `n012@3` | note `n012`, revision 3 (`n012` alone means the latest) |
| `t9` | a task |
| `m55` | a message between windows |
| `ws3`, `ws3@r902` | a workspace, or its snapshot at an event |
| `e7` | an environment revision |
| `b7` | an image or file stored once by content beside the journal |
| `sk:deploy@4`, `mcp:weather@2`, `svc:crawler@3` | a skill, an MCP server or a service, at a revision |
| `qq:12345` | an outside message, by its native id |

## Links and tracing

The host records links between refs - cite, evidence, range, origin,
revision, handoff, continuation, notice, reply - and never asks the
model to declare one. Every read appends one line of related items by weight,
with the exact call that pages the rest.

`journal.trace(ref)` walks the links back from any ref to where it came from:
the window and events behind a conclusion, the window that one continued, down
to the original outside message. `windows.show(c41)` replays a window's
transcript exactly as the model saw it.

## Search

All text search is lexical and built for Chinese and mixed text: a word index
by jieba segmentation with BM25, a trigram index for exact substrings, and a
fallback for one- or two-character queries. Results are merged, exact
substring hits first, and each carries its ref and window.

The word index segments with jieba's dictionary, cut in search mode: a long
word is also indexed as the words inside it, and punctuation and spaces are not
words, so a query that carries them still matches. The default segments this
way through `@arbor/segmenter-jieba`, which `@arbor/journal-sqlite` takes as an
optional peer dependency. When that package is not installed, or its prebuilt
binary does not load on the platform, the word index falls back to segmenting
Chinese, Japanese and Korean text per character and per bigram and every other
script per word, which is what makes a two-character query find the phrase it
appears in without a dictionary. A deployment replaces either one by
implementing `Segmenter` and registering it with the journal.

## Media

Images and files that arrive or are produced are stored once by content
beside the journal; events hold their refs. Only models that take images are
offered, so an image always reaches the model as itself.

## Redaction and archiving

The journal is never edited, with one exception for data that must not
stay, such as a secret or personal data recorded by mistake. Redacting
appends an event that names the event it covers; the original content is
erased from storage, and every ref to it keeps working and shows that it was
redacted, and by which event.

Old events can move to an archive store. Refs into the archive still
resolve, more slowly.
