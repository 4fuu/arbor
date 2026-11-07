/**
 * Events and the shapes a `Journal` read returns (docs/journal.md).
 */

import type {
  BlobRef,
  EventKind,
  EventRef,
  ExternalRef,
  LinkKind,
  MatchKind,
  Ref,
  Target,
  WindowRef,
} from "./refs.ts";
import type { ArborErrorInfo } from "@4fu/arbor-errors";

/** What an append carries. The journal assigns `ref`, `seq` and, when omitted, `time`. */
export interface EventInput {
  kind: EventKind;
  /** The window that wrote it; empty for an outside event not yet dispatched. */
  window?: WindowRef | null;
  body?: string | null;
  targets?: readonly Target[];
  refs?: readonly Ref[];
  /** Links the host recorded. The new event is the `from` side of each. */
  links?: readonly LinkInput[];
  /** Native id of an outside message, with a short channel prefix: `qq:12345`. */
  external?: ExternalRef | null;
  blobs?: readonly BlobRef[];
  /** Assigned by the journal when omitted; the journal's clock is the only writer. */
  time?: number;
}

/** One link between refs. */
export interface Link {
  kind: LinkKind;
  from: Ref;
  to: Ref;
  /** Relative strength; a bare cite is weaker than a declared link. */
  weight: number;
  time: number;
}

/** A link an append declares. `from` is the event being appended. */
export interface LinkInput {
  kind: LinkKind;
  /**
   * The ref it names. A link goes from what names it to what it names, so a
   * trace walks `from` to `to` back to where something came from.
   */
  to: Ref;
  weight?: number;
}

/** A redaction, shown in place of the erased content. */
export interface Redaction {
  /** The event that redacted this one. */
  by: EventRef;
  reason: string;
  time: number;
}

/** One immutable record. */
export interface Event {
  ref: EventRef;
  /** The event's place in the one global order. Only grows. */
  seq: number;
  window: WindowRef | null;
  time: number;
  kind: EventKind;
  targets: Target[];
  refs: Ref[];
  links: Link[];
  external: ExternalRef | null;
  blobs: BlobRef[];
  body: string | null;
  redacted: Redaction | null;
}

/** Options for a chronological listing. */
export interface ListOptions {
  window?: WindowRef;
  kinds?: readonly EventKind[];
  targets?: readonly Target[];
  external?: string;
  /** Only events after this sequence number. */
  afterSeq?: number;
  beforeSeq?: number;
  limit?: number;
  offset?: number;
}

/** One page of a read. The bound is reported every time (docs/prompting.md). */
export interface Page<T> {
  items: T[];
  /** How many items match in total, before the page cut. */
  total: number;
  limit: number;
  /** The exact call that pages the rest. */
  nextCall: string;
}

export type EventPage = Page<Event>;

/** Options for `around`. */
export interface AroundOptions {
  before?: number;
  after?: number;
}

/** Options for `search`. */
export interface SearchOptions {
  kinds?: readonly EventKind[];
  targets?: readonly Target[];
  window?: WindowRef;
  /** Find the stored copy of an outside message by its native id. */
  external?: string;
  afterSeq?: number;
  beforeSeq?: number;
  limit?: number;
  offset?: number;
}

/** One search hit: its ref and window, plus what matched. */
export interface SearchHit {
  ref: EventRef;
  seq: number;
  window: WindowRef | null;
  kind: EventKind;
  time: number;
  match: MatchKind;
  /**
   * Relevance in 0..1 across the channels that found the hit; higher is better.
   * Fused with reciprocal rank fusion, so a hit two channels found outranks one
   * only one did.
   */
  score: number;
  /** The event's opening words, for a one-line result. */
  summary: string;
}

export type SearchPage = Page<SearchHit>;

/** Options for `links`. */
export interface LinksOptions {
  offset?: number;
  limit?: number;
}

/** One related item, by weight. */
export interface RelatedItem {
  ref: Ref;
  kind: LinkKind;
  weight: number;
  direction: "out" | "in";
  window: WindowRef | null;
  time: number;
  summary: string;
}

export type LinkPage = Page<RelatedItem>;

/** Options for `trace`. */
export interface TraceOptions {
  /** How many steps back from the traced ref. */
  maxHops?: number;
  /** How many nodes the walk may visit. */
  maxNodes?: number;
}

/** One node of a trace: where a ref came from, back to the original input. */
export interface TraceNode {
  ref: Ref;
  kind?: EventKind;
  window: WindowRef | null;
  time: number;
  summary: string;
  /** True at an outside message, or at a ref the walk stopped on. */
  origin: boolean;
  from: TraceNode[];
}

/** A target a window is behind on. */
export interface TargetGap {
  target: Target;
  /** The newest event on the target another window wrote after this one opened. */
  latest: number;
  /** The newest event on the target the window has seen. */
  watermark: number;
  /** How many events the window has not seen. */
  count: number;
}

/** One refusal a `Journal` returns, in the core's error shape. */
export type JournalError = ArborErrorInfo;
