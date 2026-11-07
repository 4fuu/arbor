# @4fu/arbor-search-zvec

The optional semantic search channel: text embedded and searched by
meaning, with [zvec](https://github.com/alibaba/zvec), an embedded vector
database.

`@4fu/arbor-journal-sqlite` and `@4fu/arbor-notes-sqlite` take this package as
an optional peer. Installed, each indexes the text it searches and fuses what it
finds by meaning with its lexical indexes. Absent - or when zvec's prebuilt
binary does not load on the platform, or when no embedding model is available -
search is exactly what it is without it, and nothing else changes.

## Installing it

```bash
npm install @4fu/arbor-search-zvec
```

zvec is a Node-API addon published per platform as optional dependencies
(`@zvec/bindings-linux-x64`, `@zvec/bindings-darwin-arm64`, ...), so installing
it needs no compiler and no build step. Linux (x86_64, arm64), macOS (x86_64,
arm64) and Windows (x86_64, arm64) are supported. Its collection lives in a
directory of its own beside the journal's database - `<journal>.vectors` - and
persists through a write-ahead log exactly as the database does.

**One host per data directory.** zvec holds a `LOCK` in the collection
directory and refuses a second open, so one host owns one journal directory. A
collection another process holds is reported as no channel at all: the journal
warns once and searches lexically.

## The default embedding model

The default embedder runs a small bilingual retrieval model in-process through
[transformers.js](https://github.com/huggingface/transformers.js), which is an
optional peer of this package:

```bash
npm install @4fu/arbor-search-zvec @huggingface/transformers
```

The model is `Xenova/bge-small-zh-v1.5` (512 dimensions, 24 MB quantized). It
runs locally and needs no key. Its files are fetched from the Hugging Face Hub
on first use and cached from then on; **nothing a host holds leaves it** - only
the text being embedded is handed to the model, and the fetch is of the model,
never of the text.

The fetch never blocks anything. It happens in the background on the first
append or search; until the model arrives the channel answers `ready()` with
`false`, an empty `search`, and holds the text it was given so it can be indexed
once the model is there. A fetch that fails - `huggingface.co` is unreachable
from mainland China, for instance - degrades to lexical search with one warning
naming what is missing, and is retried later rather than on every call.

### Pointing the model somewhere else

Both settings are process-global, because transformers.js keeps them on its
`env` singleton. There is no environment variable for either.

| Option | transformers.js setting | Default |
| --- | --- | --- |
| `endpoint` | `env.remoteHost` | `https://huggingface.co/` |
| `cacheDir` | `env.cacheDir` | the library's own `.cache` |

A mirror, for a network where `huggingface.co` is blocked:

```ts
createZvecIndex({ path: "/var/lib/arbor/journal.db.vectors", endpoint: "https://hf-mirror.com" });
```

An offline install, where the model files are already on disk, names the
directory that holds them. transformers.js reads a model id or a local path the
same way, so nothing else changes:

```ts
createZvecIndex({ path: "/var/lib/arbor/journal.db.vectors", model: "/opt/models/bge-small-zh-v1.5" });
```

`dtype` (default `q8`) and `pooling` (default `cls`) choose the build and the
pooling. `retryAfterMs` (default 300000) is how long a failed fetch waits before
it is tried again, and `warn` (default `console.warn`) is where the one warning
goes.

## Bringing your own embedder

A deployment replaces the model by implementing `Embedder` and passing it. This
is also the only way text reaches anything outside the host, so it is opt-in by
construction:

```ts
import { createZvecIndex } from "@4fu/arbor-search-zvec";
import type { Embedder } from "@4fu/arbor-interfaces";

const embed: Embedder = {
  dimension: 1024,
  async embed(texts) {
    // A remote model, a different local one, anything at all.
    return callMyModel(texts);
  },
};

const index = createZvecIndex({ path: "/var/lib/arbor/journal.db.vectors", embed });
```

With `embed` given, no model is fetched and transformers.js is never loaded.

## What a store does with it

- the journal indexes each event's text when the event is appended, and the note
  store indexes each note's title, summary and body as one text when its
  revision is written;
- `catchUpSemantic()` on either store indexes what the channel does not hold -
  after a restart over an existing database, after the model arrives, and after
  an indexing attempt that failed;
- a redaction erases the event's vector with its content, and a note's vector is
  erased when the note is deleted and replaced when its revision is replaced;
- the channel's results merge with the lexical ones through the shared
  `mergeHits`: exact substring hits first, then word hits, then the hits only
  the semantic channel found. A hit no lexical index found is reported with
  `match: "semantic"`. Each store applies its own filters to what the channel
  returns, so a channel that filters less than the store does still answers the
  read it was asked.

See [docs/journal.md#search](../../docs/journal.md#search) and
[docs/memory.md#search](../../docs/memory.md#search).

## Tests

```bash
pnpm --filter @4fu/arbor-search-zvec test
```

The tests that need zvec's prebuilt binary, and the ones that need the default
embedding model, skip with a message naming what is missing. Running them all
needs `@huggingface/transformers` installed and network access to the model's
host; the rest need only the platform binding.
