/**
 * Reading refs back out of storage.
 *
 * The journal stores refs as text. A ref that does not match the vocabulary in
 * docs/journal.md#refs means the database was written by something else, so
 * reading it fails in the core's error shape instead of handing a caller a
 * string that is not a ref.
 */

import { arborError } from "@arbor/errors";
import type { BlobRef, ExternalRef, Ref, SnapshotRef, WindowRef } from "@arbor/interfaces";

const PATTERNS: readonly RegExp[] = [
  /^r\d+$/, // an event
  /^c\d+$/, // a window
  /^n\d+(@\d+)?$/, // a note, or one of its revisions
  /^t\d+$/, // a task
  /^m\d+$/, // a message between windows
  /^ws\d+(@r\d+|@latest)?$/, // a workspace, or its snapshot at an event
  /^e\d+$/, // an environment revision
  /^(sk|mcp|svc):[^\s@]+@\d+$/, // a skill, an MCP server or a service
  /^b\d+$/, // media stored beside the journal
  /^[^\s:]+:[^\s]+$/, // an outside message, by its native id
];

function malformed(kind: string, value: string): never {
  throw arborError({
    code: "internal",
    rule: "journal.storage.ref",
    message: `journal: stored ${kind} ${value} is not a ref`,
    nextAction: "the journal database was written by another build; rebuild it",
    details: { kind, value },
  });
}

/** Any ref. */
export function storedRef(value: string): Ref {
  for (const pattern of PATTERNS) {
    if (pattern.test(value)) return value as Ref;
  }
  return malformed("ref", value);
}

export function storedWindowRef(value: string | null): WindowRef | null {
  if (value === null) return null;
  if (!/^c\d+$/.test(value)) return malformed("window ref", value);
  return value as WindowRef;
}

export function storedSnapshotRef(value: string | null): SnapshotRef | null {
  if (value === null) return null;
  if (!/^ws\d+(@r\d+|@latest)$/.test(value)) return malformed("snapshot ref", value);
  return value as SnapshotRef;
}

export function storedBlobRef(value: string): BlobRef {
  if (!/^b\d+$/.test(value)) return malformed("blob ref", value);
  return value as BlobRef;
}

export function storedExternalRef(value: string | null): ExternalRef | null {
  if (value === null) return null;
  if (!/^[^\s:]+:[^\s]+$/.test(value)) return malformed("external ref", value);
  return value as ExternalRef;
}
