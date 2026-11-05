/**
 * The `NoteStore` interface: notes are the long-term memory, one copy shared by
 * every window, written only through the note tools (docs/memory.md).
 */

import type { EventRef, NoteId, NoteRef, Ref, Target, WindowRef } from "./refs.ts";
import type { Page } from "./events.ts";

/** Deployments may add values; `shared` is the default. */
export type NoteVisibility = "shared" | "private" | (string & {});

export type NoteStatus = "active" | "archived";

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

  context(ref: NoteRef): Promise<NoteContext | null>;
}
