/**
 * The one renderer: blocks in, text out, by fixed rules
 * (docs/prompting.md#blocks-and-the-renderer).
 *
 * - each kind maps to one shape, with its tag, its field order and its fixed
 *   lines taken from the text table;
 * - content inside a block is escaped, so outside text cannot close a tag or
 *   pose as host text;
 * - data blocks are marked as data;
 * - the output is deterministic, so the same blocks always give the same bytes.
 */

import type { Block, BlockFieldSpec, BlockKindSpec, BlockValue, TextTable } from "@4fu/arbor-interfaces";
import { BUILTIN_BLOCK_KINDS } from "./blocks.ts";
import { formatText, zhTextTable, type TextArgs } from "./text.ts";

/** Joins refs, which are identifiers. */
const REF_SEPARATOR = ", ";

/** Joins a list of words inside one sentence. */
const ITEM_SEPARATOR = "、";

/** Escape content so outside text cannot close a tag or pose as host text. */
export function escapeText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export interface RendererOptions {
  /** The fixed strings. Defaults to the framework's Chinese table. */
  table?: TextTable;
  /** Extra kinds, from a plugin (`Plugin.promptSection`). */
  kinds?: readonly BlockKindSpec[];
  /** Skip the built-in kinds. A deployment that restates them passes its own. */
  builtin?: boolean;
}

export class Renderer {
  /** The fixed strings this renderer writes. */
  readonly table: TextTable;
  private readonly kinds = new Map<string, BlockKindSpec>();

  constructor(options: RendererOptions = {}) {
    this.table = options.table ?? zhTextTable;
    for (const spec of options.builtin === false ? [] : BUILTIN_BLOCK_KINDS) {
      this.kinds.set(spec.kind, spec);
    }
    for (const spec of options.kinds ?? []) this.register(spec);
  }

  /** Register a plugin's kind. Its mapping is declarative, like a built-in one. */
  register(spec: BlockKindSpec): void {
    this.kinds.set(spec.kind, this.merge(spec));
  }

  /**
   * A plugin's fixed strings, merged into this renderer's table. A deployment
   * that replaces the table passes its own object, so a plugin's entries never
   * reach another host's.
   */
  extend(entries: TextTable): void {
    Object.assign(this.table as Record<string, string>, entries);
  }

  /**
   * One spec against the kind it extends: the extended kind's tag, fields,
   * lines and data mark are kept, and this spec's are added. A field named
   * twice keeps this spec's declaration, so a plugin may restate one.
   */
  private merge(spec: BlockKindSpec): BlockKindSpec {
    const base = spec.extends === undefined ? undefined : this.kinds.get(spec.extends);
    if (base === undefined) return spec;
    const fields = [...base.fields];
    for (const field of spec.fields) {
      const at = fields.findIndex((one) => one.name === field.name);
      if (at === -1) fields.push(field);
      else fields[at] = field;
    }
    const tag = spec.tag ?? base.tag;
    const data = spec.data ?? base.data;
    const lines = [...(base.lines ?? []), ...(spec.lines ?? [])];
    return {
      kind: spec.kind,
      ...(tag === undefined ? {} : { tag }),
      fields,
      ...(spec.lines === undefined && base.lines === undefined ? {} : { lines }),
      ...(data === undefined ? {} : { data }),
    };
  }

  /** The kinds this renderer knows, in registration order. */
  knownKinds(): readonly string[] {
    return [...this.kinds.keys()];
  }

  /** One block kind's spec, when the renderer knows it. */
  specOf(kind: string): BlockKindSpec | undefined {
    return this.kinds.get(kind);
  }

  /** Blocks to text. Top-level blocks are separated by a blank line. */
  render(blocks: readonly Block[]): string {
    return blocks
      .map((block) => this.renderBlock(block, false))
      .filter((text) => text !== "")
      .join("\n\n");
  }

  /**
   * Blocks nested inside a data block. The outer mark already says they are
   * data, so a nested block is not wrapped again.
   */
  private renderInside(blocks: readonly Block[]): string {
    return blocks
      .map((block) => this.renderBlock(block, true))
      .filter((text) => text !== "")
      .join("\n\n");
  }

  /** One block to text, in its kind's shape. */
  renderBlock(block: Block, insideData = false): string {
    const spec = this.kinds.get(block.kind);
    const args = this.argsOf(block, spec?.fields ?? []);
    const lines: string[] = [];
    if (spec === undefined) {
      lines.push(...this.fallbackLines(block, args));
    } else {
      const carried = new Set<string>();
      for (const key of spec.lines ?? []) {
        const line = this.lineOf(key, args, carried);
        if (line !== undefined) lines.push(line);
      }
      for (const field of spec.fields) {
        if (carried.has(field.name)) continue;
        const value = block.fields[field.name];
        if (value === undefined) continue;
        if (field.type === "blocks") {
          if (!Array.isArray(value)) continue;
          const nested = this.renderInside(value as readonly Block[]);
          if (nested !== "") lines.push(nested);
          continue;
        }
        const text = renderValue(value, field.type);
        if (text !== "") lines.push(text);
      }
    }
    const tag = spec?.tag;
    const body = tag === undefined ? lines : [`<${tag}>`, ...lines, `</${tag}>`];
    const isData = spec === undefined || spec.data === true;
    if (!isData || insideData) return body.join("\n");
    const mark = this.lineOf("data.mark", args, new Set());
    return ["<data>", ...(mark === undefined ? [] : [mark]), ...body, "</data>"].join("\n");
  }

  /**
   * One fixed line: its key may name a field (`reminder.tier.{tier}`), and a
   * line whose placeholders have no value is dropped rather than rendered
   * half-empty. `carried` collects the field names the line already states, so
   * the fields are not repeated after it.
   */
  private lineOf(key: string, args: TextArgs, carried: Set<string>): string | undefined {
    const resolved = formatText(key, args);
    const template = this.table[resolved];
    if (template === undefined) return undefined;
    for (const [, name] of `${key} ${template}`.matchAll(/\{(\w+)\}/g)) {
      if (name === undefined) continue;
      if (args[name] === undefined || args[name] === "") return undefined;
      carried.add(name);
    }
    const filled = formatText(template, args);
    if (filled.includes("{") || filled.trim() === "") return undefined;
    return filled;
  }

  /** The placeholder values one block carries, escaped and joined. */
  private argsOf(block: Block, fields: readonly BlockFieldSpec[]): TextArgs {
    const args: TextArgs = {};
    for (const field of fields) {
      const value = block.fields[field.name];
      if (value === undefined) continue;
      args[field.name] = renderValue(value, field.type);
    }
    for (const [name, value] of Object.entries(block.fields)) {
      if (args[name] !== undefined) continue;
      args[name] = renderValue(value, guessType(value));
    }
    return args;
  }

  /** A kind nobody declared still renders, as data, so nothing is lost. */
  private fallbackLines(block: Block, args: TextArgs): string[] {
    const lines: string[] = [];
    for (const [name, value] of Object.entries(block.fields)) {
      if (Array.isArray(value) && value.every((item) => typeof item === "object")) continue;
      const text = args[name] ?? escapeText(String(value));
      if (text !== "") lines.push(`${name}: ${text}`);
    }
    return lines;
  }
}

function guessType(value: BlockValue): BlockFieldSpec["type"] {
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  if (Array.isArray(value)) {
    const first = (value as readonly unknown[])[0];
    return first !== undefined && typeof first === "object" ? "blocks" : "strings";
  }
  return "string";
}

function renderValue(value: BlockValue, type: string): string {
  switch (type) {
    case "number":
    case "boolean":
      return String(value);
    case "refs":
      return Array.isArray(value) ? (value as readonly string[]).join(REF_SEPARATOR) : String(value);
    case "strings":
      return Array.isArray(value)
        ? escapeText((value as readonly string[]).join(ITEM_SEPARATOR))
        : escapeText(String(value));
    case "blocks":
      return "";
    default:
      return escapeText(String(value));
  }
}
