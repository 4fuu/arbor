/**
 * The semantic channel over zvec (docs/journal.md#search): event text embedded
 * and searched by meaning, beside the journal's lexical indexes.
 *
 * zvec is an embedded vector database: a Node-API addon, published per platform
 * as optional dependencies, so installing it needs no compiler and no server.
 * A collection is a directory of its own beside the journal's database, written
 * through a write-ahead log, so it survives a restart exactly as the database
 * does. Three limits shape this file:
 *
 * - **One writer per collection.** zvec holds a `LOCK` in the collection
 *   directory and refuses a second open, so one host owns one data directory.
 *   A collection another process holds is reported as no channel at all, and
 *   search stays lexical.
 * - **The dimension is the store's, and it is fixed at creation.** The default
 *   model's dimension is only known once the model is loaded, so the collection
 *   is created on the first successful embed rather than at construction.
 * - **A filter needs the data it filters on.** `kind` and `window` are stored as
 *   scalar fields beside each vector, so a filtered search is answered by the
 *   store rather than by discarding candidates afterwards.
 */

import { statSync } from "node:fs";
import { ZVecCollectionSchema, ZVecCreateAndOpen, ZVecDataType, ZVecOpen } from "@zvec/zvec";
import type { ZVecCollection, ZVecDocInput } from "@zvec/zvec";
import type {
  Embedder,
  EventRef,
  SemanticFields,
  SemanticFilters,
  SemanticIndex,
} from "@4fu/arbor-interfaces";
import { localEmbedder, transformersInstalled } from "./embedder.ts";
import type { LocalEmbedderOptions } from "./embedder.ts";

/** The collection's name, which is also the directory zvec writes beside it. */
const COLLECTION = "events";

/** The one vector field, and the scalar fields a filter reads. */
const VECTOR_FIELD = "embedding";
const SEQ_FIELD = "seq";
const KIND_FIELD = "kind";
const WINDOW_FIELD = "window";

/** zvec refuses a write batch larger than this. */
const MAX_WRITE_BATCH = 1024;

/** How many texts one embedding call takes. */
const EMBED_BATCH = 32;

/** How long a failed model load waits before it is tried again. */
const RETRY_AFTER_MS = 300_000;

/** How many events wait in memory while the model loads. */
const MAX_PENDING = 5_000;

/** One event's text, held while the model loads. */
interface PendingText {
  text: string;
  fields: SemanticFields | undefined;
}

/** One value in a filter expression: a quoted string, or a bare number. */
function quote(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

/**
 * The filters a semantic search applies, as a zvec filter expression. Targets
 * and an external id are not fields of this collection, so the journal applies
 * those to what this returns.
 */
export function filterExpression(filters: SemanticFilters): string | undefined {
  const clauses: string[] = [];
  if (filters.afterSeq !== undefined) clauses.push(`${SEQ_FIELD} > ${filters.afterSeq}`);
  if (filters.beforeSeq !== undefined) clauses.push(`${SEQ_FIELD} < ${filters.beforeSeq}`);
  const kinds = filters.kinds ?? [];
  if (kinds.length === 1) {
    clauses.push(`${KIND_FIELD} = ${quote(kinds[0] as string)}`);
  } else if (kinds.length > 1) {
    clauses.push(`${KIND_FIELD} IN (${kinds.map(quote).join(", ")})`);
  }
  const window = filters.window;
  if (window !== undefined && window !== null) clauses.push(`${WINDOW_FIELD} = ${quote(window)}`);
  return clauses.length === 0 ? undefined : clauses.join(" AND ");
}

/** A directory that is already there. */
function exists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface ZvecIndexOptions extends LocalEmbedderOptions {
  /** Where the collection lives. A journal passes `<journal path>.vectors`. */
  path: string;
  /** The embedder. Omitted, the default local model is used. */
  embed?: Embedder;
  /** Where a warning goes. Defaults to `console.warn`. */
  warn?: (message: string) => void;
  /** How long a failed model load waits before it is tried again. */
  retryAfterMs?: number;
  /** The clock the retry window reads. Tests pass a fixed one. */
  now?: () => number;
}

/**
 * Open the semantic channel, or answer `null` when there is none: no embedding
 * model is available, or the collection is held by another host.
 *
 * Throws when zvec itself will not load on this platform, which is the caller's
 * signal that the channel is absent.
 */
export function createZvecIndex(options: ZvecIndexOptions): SemanticIndex | null {
  const embedder = options.embed ?? (transformersInstalled() ? localEmbedder(options) : null);
  if (embedder === null) return null;
  if (!exists(options.path)) return new ZvecSemanticIndex(options, embedder, null);
  try {
    return new ZvecSemanticIndex(options, embedder, ZVecOpen(options.path));
  } catch (error) {
    // One writer per collection: another host owns this data directory.
    options.warn?.(
      `zvec: the collection at ${options.path} is held by another host; search stays lexical (${messageOf(error)})`,
    );
    return null;
  }
}

class ZvecSemanticIndex implements SemanticIndex {
  private readonly path: string;
  private readonly embedder: Embedder;
  private readonly loadModel: (() => Promise<void>) | undefined;
  private readonly warn: (message: string) => void;
  private readonly retryAfterMs: number;
  private readonly now: () => number;

  private collection: ZVecCollection | null;
  private readonly pending = new Map<EventRef, PendingText>();
  private loading: Promise<void> | null = null;
  private loaded = false;
  private failedAt: number | null = null;
  private readonly warned = new Set<string>();

  constructor(options: ZvecIndexOptions, embedder: Embedder, collection: ZVecCollection | null) {
    this.path = options.path;
    this.embedder = embedder;
    this.loadModel = (embedder as Partial<{ load: () => Promise<void> }>).load;
    this.warn = options.warn ?? ((message) => console.warn(message));
    this.retryAfterMs = options.retryAfterMs ?? RETRY_AFTER_MS;
    this.now = options.now ?? (() => Date.now());
    this.collection = collection;
  }

  async add(ref: EventRef, text: string, fields?: SemanticFields): Promise<void> {
    this.kick();
    if (!this.loaded) {
      // The model has not arrived: the event stays lexical, and the text waits
      // here, bounded, until the channel is ready.
      if (this.pending.size < MAX_PENDING) this.pending.set(ref, { text, fields });
      return;
    }
    await this.guard("add", () => this.store([[ref, text, fields]]));
  }

  async remove(ref: EventRef): Promise<void> {
    this.pending.delete(ref);
    if (this.collection === null) return;
    await this.guard("remove", () => {
      this.collection?.deleteSync(ref);
    });
  }

  async search(query: string, limit: number, filters: SemanticFilters): Promise<readonly EventRef[]> {
    this.kick();
    if (!this.loaded || this.collection === null) return [];
    const [vector] = (await this.embed([query])) ?? [];
    if (vector === undefined || vector.length === 0) return [];
    const filter = filterExpression(filters);
    const hits = await this.guard("search", () =>
      this.collection?.querySync({
        fieldName: VECTOR_FIELD,
        vector,
        topk: Math.max(1, limit),
        includeVector: false,
        ...(filter === undefined ? {} : { filter }),
      }),
    );
    return (hits ?? []).map((hit) => hit.id as EventRef);
  }

  async ready(): Promise<boolean> {
    // A channel that is only asked about still loads its model: a host that
    // restarts over an existing store calls this before it searches.
    this.kick();
    return this.loaded;
  }

  async held(): Promise<ReadonlySet<EventRef>> {
    if (this.collection === null) return new Set();
    const held = new Set<EventRef>();
    for (const doc of this.collection.iterDocsSync({ outputFields: [], includeVector: false })) {
      held.add(doc.id as EventRef);
    }
    return held;
  }

  async close(): Promise<void> {
    this.pending.clear();
    const collection = this.collection;
    if (collection === null) return;
    this.collection = null;
    this.loaded = false;
    try {
      collection.closeSync();
    } catch (error) {
      this.warnOnce("close", `zvec: closing the collection at ${this.path} failed (${messageOf(error)})`);
    }
  }

  // --- internals ---------------------------------------------------------

  /** Embed texts, and turn a refusal into nothing rather than a failed search. */
  private async embed(texts: readonly string[]): Promise<readonly number[][] | undefined> {
    return this.guard("embed", () => this.embedder.embed(texts));
  }

  /** One warning per kind of failure, so a broken channel is not a log flood. */
  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.warn(message);
  }

  /** Run one step, and turn a refusal into the channel's own answer. */
  private async guard<T>(key: string, step: () => T): Promise<T | undefined> {
    try {
      return await step();
    } catch (error) {
      this.warnOnce(key, `zvec: the semantic channel refused (${messageOf(error)}); search stays lexical`);
      return undefined;
    }
  }

  /**
   * Start loading the model unless something already is, and unless a load that
   * failed is still inside its retry window. Never awaited by a caller, so a
   * fetch is never on the path of an append or a search.
   */
  private kick(): void {
    if (this.loaded || this.loading !== null) return;
    if (this.failedAt !== null && this.now() - this.failedAt < this.retryAfterMs) return;
    this.loading = this.load().finally(() => {
      this.loading = null;
    });
  }

  private async load(): Promise<void> {
    try {
      if (this.loadModel !== undefined) await this.loadModel();
      await this.open();
      // Index what arrived while the model was loading, and anything that
      // arrived while that was happening: `add` holds its text until the
      // channel is ready, so draining until nothing is left is exact.
      while (this.pending.size > 0) await this.flush();
      this.loaded = true;
    } catch (error) {
      this.loaded = false;
      this.failedAt = this.now();
      // One warning per attempt, and the attempt is not retried until the
      // window passes: an unreachable mirror costs one line, not one per call.
      this.warn(
        `zvec: the embedding model is not available (${messageOf(error)}); search stays lexical and the model is retried in ${Math.round(this.retryAfterMs / 1000)}s`,
      );
      // The text that arrived while the model was being fetched stays here: the
      // next attempt indexes it, and a catch-up indexes whatever the bound let
      // go of.
    }
  }

  /** Open an existing collection, or create one now that the dimension is known. */
  private async open(): Promise<void> {
    if (this.collection !== null) return;
    const dimension = this.embedder.dimension;
    if (dimension <= 0) throw new Error("the embedder reported no dimension");
    this.collection = ZVecCreateAndOpen(
      this.path,
      new ZVecCollectionSchema({
        name: COLLECTION,
        vectors: { name: VECTOR_FIELD, dataType: ZVecDataType.VECTOR_FP32, dimension },
        fields: [
          { name: SEQ_FIELD, dataType: ZVecDataType.INT64 },
          { name: KIND_FIELD, dataType: ZVecDataType.STRING },
          { name: WINDOW_FIELD, dataType: ZVecDataType.STRING },
        ],
      }),
    );
  }

  /** Index what arrived while the model was loading. */
  private async flush(): Promise<void> {
    if (this.pending.size === 0) return;
    const entries = [...this.pending.entries()].map(
      ([ref, held]): readonly [EventRef, string, SemanticFields | undefined] => [
        ref,
        held.text,
        held.fields,
      ],
    );
    this.pending.clear();
    try {
      await this.store(entries);
    } catch (error) {
      // The store refused: put the text back so a later flush, or a catch-up,
      // tries again.
      this.warnOnce("add", `zvec: the semantic channel refused (${messageOf(error)}); search stays lexical`);
      for (const [ref, text, fields] of entries) this.pending.set(ref, { text, fields });
    }
  }

  /** Embed and store entries, in the batches the model and zvec take. */
  private async store(
    entries: readonly (readonly [EventRef, string, SemanticFields | undefined])[],
  ): Promise<void> {
    if (entries.length === 0) return;
    for (let start = 0; start < entries.length; start += EMBED_BATCH) {
      const batch = entries.slice(start, start + EMBED_BATCH);
      const vectors = await this.embedder.embed(batch.map(([, text]) => text));
      const docs: ZVecDocInput[] = [];
      batch.forEach(([ref, , fields], index) => {
        const vector = vectors[index];
        if (vector === undefined || vector.length === 0) return;
        docs.push({
          id: ref,
          vectors: { [VECTOR_FIELD]: vector },
          fields: {
            [SEQ_FIELD]: Number(ref.slice(1)),
            [KIND_FIELD]: fields?.kind ?? "",
            [WINDOW_FIELD]: fields?.window ?? "",
          },
        });
      });
      for (let offset = 0; offset < docs.length; offset += MAX_WRITE_BATCH) {
        this.collection?.upsertSync(docs.slice(offset, offset + MAX_WRITE_BATCH));
      }
    }
  }
}
