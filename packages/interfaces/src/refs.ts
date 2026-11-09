/**
 * Refs: one reference format points at anything, in every tool argument and
 * result (docs/journal.md#refs). A ref is a string; the prefixes below are the
 * whole vocabulary. Nothing else in arbor is addressed by an opaque id.
 */

/** An event: `r902`. Its number is the event's place in the one global order. */
export type EventRef = `r${number}`;

/** A window: `c41`. */
export type WindowRef = `c${number}`;

/** A note: `n012`, or one of its revisions: `n012@3`. Bare `n012` means latest. */
export type NoteId = `n${number}`;
export type NoteRef = NoteId | `${NoteId}@${number}`;

/** A task: `t9`. */
export type TaskRef = `t${number}`;

/** A message between windows: `m55`. */
export type MessageRef = `m${number}`;

/** A workspace: `ws3`. */
export type WorkspaceRef = `ws${number}`;

/** An environment revision: `e7`. */
export type EnvRef = `e${number}`;

/** A skill, MCP server, service or the settings, at a revision: `sk:deploy@4`, `set:settings@2`. */
export type EnvItemRef = `${"sk" | "mcp" | "svc" | "set"}:${string}@${number}`;

/**
 * An item named without its revision, as `reload({ remove })` takes it:
 * `skill:deploy`, `mcp:weather`, `service:crawler`, `set:settings`.
 */
export type EnvItemName = `${"skill" | "sk" | "mcp" | "service" | "svc" | "settings" | "set"}:${string}`;

/** Media and files stored once by content beside the journal: `b7`. */
export type BlobRef = `b${number}`;

/** An outside message by its native id, with a short channel prefix: `qq:12345`. */
export type ExternalRef = `${string}:${string}`;

export type Ref =
  | EventRef
  | WindowRef
  | NoteRef
  | TaskRef
  | MessageRef
  | WorkspaceRef
  | EnvRef
  | EnvItemRef
  | EnvItemName
  | BlobRef
  | ExternalRef;

/**
 * A target is anything two windows can collide on: a conversation
 * (`qq:group:123`), a file path (`file:src/cart.ts`), a note (`n012`), an
 * outside item (`gh:issue:42`) or a service (`svc:crawler`). The host fills
 * targets in; the model never does.
 */
export type Target = string;

/** Event kinds the core defines. Later stages and plugins add their own. */
export type EventKind =
  | "input"
  | "tool_call"
  | "tool_result"
  | "send"
  | "effect_result"
  | "note_revision"
  | "window_start"
  | "window_end"
  /** The end of one model run, with what it cost (docs/journal.md#events). */
  | "run_ended"
  /** One usage report a run made: used, limit and reserve (docs/journal.md#events). */
  | "usage"
  | "delivery"
  | "environment_revision"
  | "service_state"
  | "redaction"
  | "schedule"
  | (string & {});

/** Link kinds between refs. The host records them; the model never declares one. */
export type LinkKind =
  | "cite"
  | "evidence"
  | "range"
  | "origin"
  | "revision"
  | "handoff"
  | "continuation"
  | "notice"
  | "reply"
  | (string & {});

/**
 * How a search hit matched: an exact substring, a word, or meaning alone. A hit
 * the semantic channel found and no lexical index did is `semantic`.
 */
export type MatchKind = "substring" | "word" | "semantic";

/** Page size default shared by every read that returns a page. */
export const DEFAULT_PAGE_LIMIT = 20;

/** Maximum page size any read returns. */
export const MAX_PAGE_LIMIT = 200;
