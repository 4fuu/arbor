/**
 * The `NoteStore` interface: notes are the long-term memory, one copy shared by
 * every window, written only through the note tools (docs/memory.md).
 */

import type { EventRef, NoteId, NoteRef, Ref, Target, WindowRef } from "./refs.ts";
import type { Page } from "./events.ts";

/** Deployments may add values; `shared` is the default. */
export type NoteVisibility = "shared" | "private" | (string & {});

/**
 * A note is `active` in the current epoch's active set, `archived` when it is
 * not, and `deleted` once a delete wrote a tombstone: every revision and every
 * ref to them keep resolving, but no list, search or active set returns it.
 */
export type NoteStatus = "active" | "archived" | "deleted";

/** Where a revision happened. The host records it; the model never fills it in. */
export interface Anchor {
  window: WindowRef;
  event: EventRef;
  evidence?: readonly Ref[];
  range?: string;
}

/** What a write carries. A write, replace or delete names the revision it read. */
export interface NoteWriteInput {
  /** Omit for a new note. */
  id?: NoteId;
  title: string;
  /** At most 200 characters. */
  summary?: string;
  body: string;
  visibility?: NoteVisibility;
  /** The revision the writer read. A stale one is refused with what changed. */
  expectedRevision?: number;
  anchor?: Anchor;
  refs?: readonly Ref[];
  /** Replace the body, or delete the note. Both name the revision read. */
  replace?: boolean;
  delete?: boolean;
}

export interface Note {
  ref: NoteRef;
  id: NoteId;
  title: string;
  summary: string;
  body: string | null;
  visibility: NoteVisibility;
  status: NoteStatus;
  revision: number;
  anchor?: Anchor;
  time: number;
  window: WindowRef | null;
}

/** What a list shows: summaries, never bodies. */
export interface NoteSummary {
  ref: NoteRef;
  id: NoteId;
  title: string;
  summary: string;
  visibility: NoteVisibility;
  status: NoteStatus;
  revision: number;
  time: number;
}

/** A paged body. */
export interface NoteBody {
  ref: NoteRef;
  revision: number;
  body: string;
  /** The whole body's length in characters, before the page cut. */
  total: number;
  nextCall: string;
}

export interface NoteRevision {
  ref: NoteRef;
  revision: number;
  window: WindowRef | null;
  time: number;
  summary: string;
  anchor?: Anchor;
  refs: readonly Ref[];
}

/** What `notes.context(ref)` restores: the surroundings of a revision. */
export interface NoteContext {
  ref: NoteRef;
  revision: number;
  anchor?: Anchor;
  /** The events around the one the anchor names. */
  events: readonly string[];
  evidence: readonly Ref[];
}

export interface NoteQuery {
  query?: string;
  status?: NoteStatus;
  /** Notes about a target. */
  about?: Target;
  visibility?: NoteVisibility;
  linked?: Ref;
  limit?: number;
  offset?: number;
}

/** What a refused write carries: what changed since the revision it read. */
export interface NoteConflictInfo {
  read: number;
  current: number;
  revisions: readonly NoteRevision[];
}

/** The active set's budget: a count and a token estimate (docs/memory.md). */
export interface ActiveSetBudget {
  count: number;
  tokens: number;
}

/** One candidate for the active set, with its usage score. */
export interface ActiveCandidate {
  ref: NoteRef;
  id: NoteId;
  summary: string;
  score: number;
}

/**
 * What a use of a note carries. The host records it from the events it
 * appends; the model never declares one (docs/memory.md#the-active-set).
 */
export type NoteUseKind = "cite" | "evidence" | "read";

export interface NoteUseInput {
  ref: NoteRef;
  kind: NoteUseKind;
  /** The window that used it. */
  window?: WindowRef;
  /** The event that used it, so one event is recorded once. */
  event?: EventRef;
  /** The link's weight; a bare cite is weaker than a declared one. */
  weight?: number;
  time?: number;
}

/** What `snapshot` takes. */
export interface SnapshotOptions {
  /** Rebuild at most this often, in ms. 10 minutes. */
  minIntervalMs?: number;
  /** The active set's budget. */
  budget?: ActiveSetBudget;
  /**
   * The notes the judge keeps, within its bounded share. The share is
   * additive: the judge adds notes the rule score did not pick and never drops
   * one it did, because it never outweighs the model's own use.
   */
  judgeKeep?: readonly NoteRef[];
  /** The share of the budget the judge may add. */
  judgeShare?: number;
}

/**
 * One frozen memory snapshot: the active notes of one epoch, with the epoch's
 * version (docs/windows.md#prompt-layout). Every window opened in one epoch
 * freezes the same bytes; what changed since is `delta`.
 */
export interface NotesSnapshot {
  /** The epoch's version. */
  epoch: number;
  time: number;
  /** The active notes, by summary, sorted by id. */
  items: readonly NoteSummary[];
  total: number;
  limit: number;
  nextCall: string;
  budget: ActiveSetBudget;
}

/** What changed since an epoch: the notes written after it. */
export interface NoteDelta {
  /** The epoch asked about; `0` for every note. */
  since: number;
  /** The current epoch. */
  epoch: number;
  items: readonly NoteDeltaItem[];
  total: number;
  limit: number;
  nextCall: string;
}

export interface NoteDeltaItem {
  ref: NoteRef;
  id: NoteId;
  revision: number;
  title: string;
  summary: string;
  change: "created" | "revised" | "deleted";
  window: WindowRef | null;
  time: number;
}

export interface NoteStore {
  /** Create, replace or delete. Names the revision it read; a stale one is refused. */
  write(input: NoteWriteInput): Promise<Note>;

  /** The body, paged. `n012` alone means the latest revision. */
  read(ref: NoteRef, options?: { offset?: number; limit?: number }): Promise<NoteBody | null>;

  /** The note's revisions, oldest first. */
  revisions(ref: NoteRef): Promise<Page<NoteRevision>>;

  search(query?: NoteQuery): Promise<Page<NoteSummary>>;

  /** The active set, by summary: the memory snapshot of every window. */
  active(): Promise<Page<NoteSummary>>;

  /**
   * The memory snapshot of one epoch, with the epoch's version
   * (docs/windows.md#prompt-layout). A new epoch is built at most every
   * `minIntervalMs`, and only when a note was written since the last one or the
   * budget changed, so every window opened in one epoch freezes the same bytes.
   */
  snapshot(options?: SnapshotOptions): Promise<NotesSnapshot>;

  /** What changed since an epoch: the notes written after it. */
  delta(since: number, options?: { limit?: number; offset?: number }): Promise<NoteDelta>;

  /** The active-set candidates with their usage scores, strongest first. */
  score(options?: { limit?: number; offset?: number }): Promise<Page<ActiveCandidate>>;

  /** Record that a window used a note: cited it, used it as evidence or read it. */
  recordUse(input: NoteUseInput): Promise<void>;

  /** Release the underlying store. */
  close(): Promise<void>;

  context(ref: NoteRef): Promise<NoteContext | null>;
}
