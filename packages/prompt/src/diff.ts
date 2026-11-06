/**
 * The line diff a prompt-section delta is built from
 * (docs/prompting.md#plugin-sections-that-change).
 *
 * A plugin's prompt section can change while a window runs. The window learns
 * the change the way it learns an environment change - as a delta at the next
 * tool-call boundary - and the delta carries only the lines that changed, so
 * unchanged text is never repeated and the whole system prompt is never
 * rebuilt. The diff is by longest common subsequence: a line both texts hold is
 * left out, and a line that moved is reported where it now stands.
 */

/** One line that changed between two texts. */
export interface LineChange {
  /** `+` for a line the new text has and the old one did not, `-` for one it lost. */
  change: "+" | "-";
  line: string;
}

/** The lines one text carries. A blank line carries nothing a diff can say. */
function linesOf(text: string): readonly string[] {
  return text.split("\n").filter((line) => line !== "");
}

/**
 * The index pairs the two texts share, longest first: the lines that are in
 * both, in order. The table is filled from the end, so one pass walks it from
 * the start and prefers the side that keeps more lines in common.
 */
function commonLines(before: readonly string[], after: readonly string[]): readonly [number, number][] {
  const rows = before.length;
  const columns = after.length;
  const table: number[][] = Array.from({ length: rows + 1 }, () => new Array<number>(columns + 1).fill(0));
  for (let row = rows - 1; row >= 0; row -= 1) {
    const current = table[row];
    if (current === undefined) continue;
    for (let column = columns - 1; column >= 0; column -= 1) {
      const down = table[row + 1]?.[column] ?? 0;
      const right = current[column + 1] ?? 0;
      const diagonal = table[row + 1]?.[column + 1] ?? 0;
      current[column] = before[row] === after[column] ? diagonal + 1 : Math.max(down, right);
    }
  }
  const pairs: [number, number][] = [];
  let row = 0;
  let column = 0;
  while (row < rows && column < columns) {
    if (before[row] === after[column]) {
      pairs.push([row, column]);
      row += 1;
      column += 1;
      continue;
    }
    if ((table[row + 1]?.[column] ?? 0) >= (table[row]?.[column + 1] ?? 0)) row += 1;
    else column += 1;
  }
  return pairs;
}

/**
 * The lines that changed between two texts, in the order the new text stands
 * in. Two texts with the same lines give nothing, so a section whose content
 * did not move emits no delta at all.
 */
export function changedLines(from: string, to: string): readonly LineChange[] {
  const before = linesOf(from);
  const after = linesOf(to);
  const changes: LineChange[] = [];
  let row = 0;
  let column = 0;
  for (const [sameRow, sameColumn] of commonLines(before, after)) {
    while (row < sameRow) {
      const line = before[row];
      if (line !== undefined) changes.push({ change: "-", line });
      row += 1;
    }
    while (column < sameColumn) {
      const line = after[column];
      if (line !== undefined) changes.push({ change: "+", line });
      column += 1;
    }
    row = sameRow + 1;
    column = sameColumn + 1;
  }
  while (row < before.length) {
    const line = before[row];
    if (line !== undefined) changes.push({ change: "-", line });
    row += 1;
  }
  while (column < after.length) {
    const line = after[column];
    if (line !== undefined) changes.push({ change: "+", line });
    column += 1;
  }
  return changes;
}
