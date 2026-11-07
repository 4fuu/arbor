/**
 * The `Journal` interface: the one append-only record, shared live by every
 * window (docs/journal.md).
 *
 * Rules an implementation must keep:
 *
 * - Append-only. Nothing is edited, nothing is deleted, nothing merges. The one
 *   exception is a redaction, which erases content and records that it did.
 * - One global order. `seq` is assigned at append and only grows; watermarks
 *   and every comparison use it. `time` is for display only.
 * - An outside message keeps its native id in `external`, with a unique index,
 *   so a redelivered message is stored once.
 * - Visible as soon as it is written.
 * - Every refusal is an `ArborError` in the core's shape.
 */

import type {
  AroundOptions,
  Event,
  EventInput,
  EventPage,
  LinkPage,
  LinksOptions,
  ListOptions,
  SearchOptions,
  SearchPage,
  TargetGap,
  TraceNode,
  TraceOptions,
} from "./events.ts";
import type { BlobRef, EventRef, Ref, Target, WindowRef } from "./refs.ts";

/** Content a blob store takes. */
export interface BlobInput {
  data: Uint8Array | string;
  mime?: string;
}

/** Content a blob store returns. */
export interface BlobContent {
  data: Uint8Array;
  mime?: string;
}

export interface BlobInfo {
  ref: BlobRef;
  size: number;
  mime?: string;
  time: number;
}

/**
 * Media and files are stored once by content beside the journal; events hold
 * their refs (docs/journal.md#media). The journal never keeps the bytes.
 */
export interface BlobStore {
  put(input: BlobInput): Promise<BlobRef>;
  get(ref: BlobRef): Promise<BlobContent | null>;
  has(ref: BlobRef): Promise<boolean>;
  stat(ref: BlobRef): Promise<BlobInfo | null>;
  delete(ref: BlobRef): Promise<void>;
}

/**
 * Word segmentation for the word index. The default is jieba's dictionary
 * segmentation when `@4fu/arbor-segmenter-jieba` is installed, and the
 * per-character-and-bigram approximation when it is not
 * (docs/journal.md#search); a deployment replaces either by implementing this
 * and registering it.
 */
export interface Segmenter {
  segment(text: string): string[];
}

/** The filters a semantic search applies, as the journal's own read applies them. */
export interface SemanticFilters {
  kinds?: readonly string[];
  window?: WindowRef | null;
  afterSeq?: number;
  beforeSeq?: number;
}

/** The scalar fields a semantic filter reads, beside an event's text. */
export interface SemanticFields {
  kind?: string;
  window?: WindowRef | null;
}

/**
 * Embedding text into vectors. The default is a small local model that needs no
 * key (docs/journal.md#search); a deployment replaces it with its own, which is
 * the only way text reaches anything outside the host.
 */
export interface Embedder {
  /** The dimension every vector this embedder returns has. */
  readonly dimension: number;
  /** Embed each text, in the order given. */
  embed(texts: readonly string[]): Promise<readonly number[][]>;
}

/**
 * The semantic channel: text search by meaning, beside the lexical indexes
 * (docs/journal.md#search, docs/memory.md#search).
 *
 * A store takes one as an optional peer, the way it takes a `Segmenter`.
 * When none is registered - the package is not installed, its vector store will
 * not open on the platform, or no embedding model is available - search is
 * lexical and nothing else changes. A channel that is registered but not ready
 * yet - the model is still downloading, or the download failed and is waiting to
 * be retried - answers `ready()` with `false`, an empty `search`, and keeps
 * what `add` handed it until it is.
 *
 * The ref is the store's own: an event ref for the journal, a note id for the
 * note store, which holds one vector per note and replaces it when the note is
 * revised. What the channel keeps beside a ref - the fields, and the order the
 * ref's number carries - is whatever that store's reads filter on.
 */
export interface SemanticIndex {
  /** Embed and store one item's text, replacing what is stored for it. */
  add(ref: Ref, text: string, fields?: SemanticFields): Promise<void>;
  /** Forget one item's text, as a redaction or a delete does. */
  remove(ref: Ref): Promise<void>;
  /** The refs nearest a query, best first, already filtered. Empty until ready. */
  search(query: string, limit: number, filters: SemanticFilters): Promise<readonly Ref[]>;
  /** Whether the channel can answer a query now. */
  ready(): Promise<boolean>;
  /** Every ref the channel holds, so a caller can index what it is missing. */
  held(): Promise<ReadonlySet<Ref>>;
  /** Release the underlying store. */
  close(): Promise<void>;
}

export interface Journal {
  /** Append one event. Assigns `ref` and `seq`; a redelivered `external` id is stored once. */
  append(input: EventInput): Promise<Event>;

  /** Read one event by its ref, or `null`. */
  get(ref: EventRef): Promise<Event | null>;

  /** Read several events by ref, in the order asked for. Missing refs are skipped. */
  getMany(refs: readonly EventRef[]): Promise<Event[]>;

  /** List events chronologically, filtered. */
  list(options?: ListOptions): Promise<EventPage>;

  /** The events around one, in the global order. */
  around(ref: EventRef, options?: AroundOptions): Promise<Event[]>;

  /**
   * Text search: exact substring hits first, then word hits and semantic hits
   * fused by reciprocal rank, each with its ref and window
   * (docs/journal.md#search).
   */
  search(query: string, options?: SearchOptions): Promise<SearchPage>;

  /** Related items by weight, with the call that pages the rest. */
  links(ref: Ref, options?: LinksOptions): Promise<LinkPage>;

  /** Walk the links back from any ref to where it came from. */
  trace(ref: Ref, options?: TraceOptions): Promise<TraceNode>;

  /** The newest event on a target a window has seen, or `null`. */
  watermark(window: WindowRef, target: Target): Promise<number | null>;

  /** Move a window's watermark forward. Never moves it back. */
  advanceWatermark(window: WindowRef, target: Target, seq: number): Promise<number>;

  /** The targets a window touched that have events it has not seen. */
  targetsBehind(window: WindowRef): Promise<TargetGap[]>;

  /**
   * Erase the content of one event and record that it was erased. Every ref to
   * it keeps working and shows the redaction and the event that made it.
   */
  redact(ref: EventRef, reason: string): Promise<Event>;

  /** Media and files stored beside the journal. */
  readonly blobs: BlobStore;

  /** Release the underlying store. */
  close(): Promise<void>;
}
