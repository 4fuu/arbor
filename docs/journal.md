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
| `kind` | input, tool call, tool result, send, note revision, window start or end, tool registration, ... |
| `targets` | what it touches (below) |
| `refs` | the refs it names: what it answers, cites, continues or quotes |
| `external` | the native id of an outside message, with a short channel prefix |

Events have one global order: the number in their id, assigned at append and
only growing. Watermarks and every comparison use it; `time` is for display
only.

Every window appends to the journal as it works, and so does the model inside
it: an assistant message that carries text is recorded as one `assistant` event
on the window. Nothing but `send` reaches the outside, so the record is the one
place a window's own words stand - `windows.show` replays them, and a
continuation reads what its predecessor said
([windows.md](windows.md#prompt-layout)).

The host writes events of its own with no window: an environment revision, a
service state change, and a `tool_registration` for every direct tool a plugin
or a backend declared that was not registered, which carries the source, the
tool and the rule that left it out - recorded on every refresh of that set, not
only the first one ([tools.md](tools.md#external-tools-that-change)).

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
| `ws3` | a workspace |
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
way through `@4fu/arbor-segmenter-jieba`, which `@4fu/arbor-lexical` takes as an
optional peer dependency. When that package is not installed, or its prebuilt
binary does not load on the platform, the word index falls back to segmenting
Chinese, Japanese and Korean text per character and per bigram and every other
script per word, which is what makes a two-character query find the phrase it
appears in without a dictionary. A deployment replaces either one by
implementing `Segmenter` and registering it with the journal.

### The semantic channel

A query whose meaning matches an event but whose words do not finds nothing
lexically. A deployment that wants that installs `@4fu/arbor-search-zvec`, which
`@4fu/arbor-journal-sqlite` takes as an optional peer: event text is embedded
and searched by meaning with zvec, an embedded vector database. The channel is
absent - and search is exactly what the paragraph above describes - when the
package is not installed, when zvec's prebuilt binary does not load on the
platform, when another host holds the vector store's `LOCK` (one host per data
directory), or when no embedding model is available.

The default embedder runs a small bilingual retrieval model locally through
transformers.js and needs no key. Its files are fetched from the Hugging Face
Hub on first use and cached; nothing a host holds leaves it. The fetch never
blocks opening a journal or a search: until the model arrives the channel
answers nothing and holds the text it was given, and events appended meanwhile
are indexed once it is. A fetch that fails degrades to lexical search with one
warning and is retried later. A deployment names a local model directory, a
mirror endpoint, or its own `Embedder` - the only way text reaches anything
outside the host - in the package's README.

Each event's text is indexed when the event is appended, and
`journal.catchUpSemantic()` indexes what the channel does not hold: after a
restart over an existing database, once the model arrives, and after an indexing
attempt that failed. A redaction erases the event's vector with its content.

The channels merge through `@4fu/arbor-lexical`'s `mergeHits`, each keeping the
order it arrives in: exact substring hits first, then word hits, then the hits
only the semantic channel found, which carry `match: "semantic"`. The filters a
read applies - window, kinds, targets, the sequence range - are applied by the
journal as well as by the channel, so a channel that filters less than the
journal does still answers the read it was asked.

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
