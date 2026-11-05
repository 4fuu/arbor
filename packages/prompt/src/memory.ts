/**
 * The memory snapshot: the active notes, by summary
 * (docs/prompting.md#layers, docs/windows.md#prompt-layout).
 *
 * It is part of the frozen prefix, so rendering is deterministic: notes sorted
 * by id, no timestamps and no counters. Lists show summaries, never bodies.
 */

import type { Block, NoteSummary } from "@arbor/interfaces";
import type { Renderer } from "./render.ts";

/** `n012` sorts by its number, so `n9` comes before `n10`. */
export function noteSortKey(ref: string): number {
  const match = /^n(\d+)/.exec(ref);
  return match === null ? Number.MAX_SAFE_INTEGER : Number(match[1]);
}

/** The active set as blocks, sorted by id. */
export function memoryBlocks(notes: readonly NoteSummary[]): Block[] {
  return [...notes]
    .sort((left, right) => noteSortKey(left.id) - noteSortKey(right.id))
    .map((note) => ({
      kind: "note_summary",
      fields: {
        ref: note.ref,
        title: note.title,
        summary: note.summary,
        revision: note.revision,
        status: note.status,
      },
    }));
}

/** The snapshot's text. Empty when the active set is empty. */
export function renderMemorySnapshot(notes: readonly NoteSummary[], renderer: Renderer): string {
  return renderer.render(memoryBlocks(notes));
}
