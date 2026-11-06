/**
 * Bounded results (docs/prompting.md#information-density).
 *
 * Every read is bounded by one head-and-tail cut in the tool pipeline, with a
 * marker that says how much was cut and where the whole is kept in the
 * workspace. A limit that shapes a result without refusing is reported by the
 * result every time.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TextTable } from "@4fu/arbor-interfaces";
import { textOf } from "@4fu/arbor-prompt";

/** How much of one result the model reads, after the cut. */
export const RESULT_LIMIT = 20000;

/** How much of what is kept comes from the tail, so the end is not lost. */
const TAIL_SHARE = 0.25;

export interface Bound {
  text: string;
  /** True when the cut removed something. */
  truncated: boolean;
  /** The whole result's length, before the cut. */
  total: number;
  head: number;
  tail: number;
}

/** One head-and-tail cut. */
export function boundText(text: string, limit = RESULT_LIMIT): Bound {
  if (text.length <= limit) {
    return { text, truncated: false, total: text.length, head: text.length, tail: 0 };
  }
  const head = Math.floor(limit * (1 - TAIL_SHARE));
  const tail = limit - head;
  return {
    text: `${text.slice(0, head)}\n${text.slice(text.length - tail)}`,
    truncated: true,
    total: text.length,
    head,
    tail,
  };
}

/**
 * Bound one result and keep the whole of it in the workspace, so the marker can
 * name where. A window without a workspace gets the cut with no path.
 */
export async function boundResult(
  text: string,
  options: {
    limit?: number;
    workspace?: string;
    callId?: string;
    table?: TextTable;
  },
): Promise<string> {
  const bound = boundText(text, options.limit);
  if (!bound.truncated) return bound.text;
  const table = options.table ?? {};
  const marker = textOf(table, "result.bounded", {
    head: bound.head,
    tail: bound.tail,
    total: bound.total,
  });
  if (options.workspace === undefined || options.callId === undefined) return `${bound.text}\n${marker}`;
  const path = join(options.workspace, ".arbor", "outputs", `${options.callId}.txt`);
  await mkdir(join(options.workspace, ".arbor", "outputs"), { recursive: true });
  await writeFile(path, text, "utf8");
  return `${bound.text}\n${marker}\n${textOf(table, "result.bounded.path", { path })}`;
}

/** The exact call that pages the rest of a read (docs/prompting.md). */
export function nextCall(name: string, offset: number, limit: number): string {
  return `${name}({ offset: ${offset + limit}, limit: ${limit} })`;
}
