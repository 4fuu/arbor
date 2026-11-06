/**
 * Note refs (docs/journal.md#refs).
 *
 * A note is `n012`; one of its revisions is `n012@3`. A bare `n012` means the
 * latest revision. Everything else in the store reads refs through here, so a
 * malformed one is refused in the core's error shape instead of reaching
 * storage.
 */

import type { EventRef, NoteId, NoteRef, Ref, WindowRef } from "@4fu/arbor-interfaces";

export function noteIdOf(id: number): NoteId {
  return `n${id}`;
}

export function noteRefOf(id: number, revision: number): NoteRef {
  return `n${id}@${revision}`;
}

/** The note id a ref names, with or without a revision, or `null`. */
export function parseNoteId(ref: string): number | null {
  const match = /^n(\d+)(?:@(\d+))?$/.exec(ref);
  if (match === null) return null;
  return Number(match[1]);
}

/** The note id and the revision a ref names; a bare id means the latest. */
export function parseNoteRef(ref: string): { id: number; revision: number | null } | null {
  const match = /^n(\d+)(?:@(\d+))?$/.exec(ref);
  if (match === null) return null;
  return { id: Number(match[1]), revision: match[2] === undefined ? null : Number(match[2]) };
}

/** The forms one note ref is looked up under: the revision, then the bare id. */
export function noteRefForms(ref: Ref): Ref[] {
  const match = /^(n\d+)@(\d+)$/.exec(ref);
  return match === null ? [ref] : [ref, match[1] as Ref];
}

/** A window ref read back out of storage. */
export function storedWindowRef(value: string | null): WindowRef | null {
  if (value === null) return null;
  if (!/^c\d+$/.test(value)) throw new Error(`stored window ref ${value} is not a ref`);
  return value as WindowRef;
}

/** An event ref read back out of storage. */
export function storedEventRef(value: string | null): EventRef | null {
  if (value === null) return null;
  if (!/^r\d+$/.test(value)) throw new Error(`stored event ref ${value} is not a ref`);
  return value as EventRef;
}
