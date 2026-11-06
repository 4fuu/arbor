/**
 * Typed blocks and the text table (docs/prompting.md).
 *
 * No component writes prompt text. Everything that reaches a model - a system
 * prompt section, a delivery, a reminder, a note, a result, an error - is a
 * typed block: a kind and its fields. One renderer, owned by the host, turns
 * blocks into text by fixed rules, so the same blocks always give the same
 * bytes. A plugin registers kinds of its own and hands the host blocks, never
 * finished text.
 */

import type { Ref } from "./refs.ts";

/** A field value inside a block. */
export type BlockValue =
  | string
  | number
  | boolean
  | Ref
  | readonly Ref[]
  | readonly string[]
  | readonly Block[];

/** One typed block. */
export interface Block<K extends string = string> {
  kind: K;
  fields: Record<string, BlockValue>;
}

/** Built-in block kinds. Plugins add their own through `BlockKindSpec`. */
export type BlockKind =
  | "task"
  | "board_line"
  | "handoff"
  | "note"
  | "note_summary"
  | "reminder"
  | "tool_result"
  | "error"
  | "data"
  | "outside_message"
  | (string & {});

/** Declares one field of a block kind. */
export interface BlockFieldSpec {
  name: string;
  type: "string" | "strings" | "number" | "boolean" | "ref" | "refs" | "blocks";
  required?: boolean;
  /**
   * True when the field names the block's own XML tag rather than content: the
   * renderer writes it as the tag and never as a line of its own
   * (docs/prompting.md#blocks-and-the-renderer).
   */
  tag?: boolean;
}

/**
 * A plugin's registration of a block kind: its fields, the tag the renderer
 * wraps it in, and the fixed lines the renderer writes before its fields. The
 * mapping is declarative so rendering stays deterministic and in one place.
 */
export interface BlockKindSpec {
  kind: string;
  /**
   * A kind this one extends, built-in or another plugin's. Its tag, fields,
   * lines and data mark are kept, and this spec's are added to them, so a
   * plugin adds its own fields to a block the core builds - a note, an outside
   * message - and the one renderer still renders it
   * (docs/prompting.md#blocks-and-the-renderer).
   */
  extends?: string;
  /** XML tag the renderer wraps one block in; omitted for an untagged block. */
  tag?: string;
  /**
   * The field whose value is this block's XML tag, for a kind whose tag is
   * chosen per instance - a plugin prompt section's delta, which renders in the
   * tag the plugin named. Omitted for a kind whose tag is fixed.
   */
  tagField?: string;
  fields: readonly BlockFieldSpec[];
  /** Fixed lines written before the fields, by key into the text table. */
  lines?: readonly string[];
  /** Outside content is data, never instructions, and is marked where delivered. */
  data?: boolean;
}

/**
 * One text table entry per fixed string the framework writes: section
 * headings, delivery lines, reminders, descriptions, errors. A deployment
 * replaces the table to change the language or the wording; no fixed text is
 * written anywhere else. Identifiers stay as they are.
 */
export type TextTable = Record<string, string>;
