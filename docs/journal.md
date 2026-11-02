# Journal

The journal is the project's one record. Every window appends to it and reads
from it; an event is visible to every window as soon as it is written. It is
append-only: nothing is edited, nothing is deleted, nothing merges.

## Events

| Field | Meaning |
| --- | --- |
| `id` | the event's ref, `r902` |
| `window` | the window that wrote it, `c41`; empty for an outside event not yet dispatched |
| `time` | when it was written |
| `kind` | input, tool call, tool result, send, note revision, window start or end, ... |
| `targets` | what it touches (below) |
| `refs` | the refs it names: what it answers, cites, continues or quotes |
| `external` | the native id of an outside message, with a short channel prefix |
| `snapshot` | the workspace snapshot, for an event that changed files |

## Targets

A target is anything two windows can collide on:

| Target | Example |
| --- | --- |
| conversation | `qq:group:123`, `qq:private:456` |
| file | `file:src/cart.ts` |
| note | `n012` |
| outside item | `gh:issue:42`, `gh:pr:57` |

The host fills `targets` from the event itself - the conversation of an input,
the target of a send, the paths a tool read or wrote, the note it changed. The
model never fills it in.

Targets serve three things with one index: dispatch candidates
([dispatch.md](dispatch.md)), notices between windows and consistency checks
([coordination.md](coordination.md)).

## Watermarks

For every target a window has touched, the host keeps the newest event on
that target the window has seen - in its prompt, in a tool result, or by
writing it. A target with events newer than the window's watermark is one the
window is behind on. This is what the consistency checks compare.

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
| `qq:12345` | an outside message, by its native id |

A ref may carry a project prefix, `shop/r42`; inside the current project it
is left out.

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
