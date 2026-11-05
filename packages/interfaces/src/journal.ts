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
 * Word segmentation for the word index. The default segments Chinese text per
 * character and per bigram and Latin text per word; a deployment that wants
 * jieba's dictionary segmentation implements this and registers it.
 */
export interface Segmenter {
  segment(text: string): string[];
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

  /** Lexical search: exact substring hits first, then word hits, each with its ref and window. */
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
