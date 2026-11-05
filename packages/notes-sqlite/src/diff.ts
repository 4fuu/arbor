/**
 * The difference between two bodies, for a note conflict (docs/memory.md).
 *
 * A refused write carries what changed since the revision it read: the
 * revisions in between, their windows and the differences. The differences are
 * a unified diff of the body the writer read against the body that is there
 * now, so the model merges them and writes again without reading the whole note
 * twice. A body too large to diff is reported as such; the revisions it has to
 * read are named in the same refusal.
 */

/** Lines of unchanged context each hunk keeps. */
const CONTEXT = 3;

/** Beyond this many cells the diff is dropped for a line that says so. */
const CELL_LIMIT = 4_000_000;

type Edit = { kind: "-" | "+" | " "; line: number | null; text: string };

/** The unified diff of `from` against `to`, or `null` when nothing changed. */
export function bodyDiff(from: string, to: string): string | null {
  const before = from === "" ? [] : from.split("\n");
  const after = to === "" ? [] : to.split("\n");
  if (before.length * after.length > CELL_LIMIT) {
    return "the body is too large to diff; read both revisions";
  }
  const edits = diffLines(before, after);
  if (edits.every((edit) => edit.kind === " ")) return null;
  return render(edits);
}

function diffLines(before: readonly string[], after: readonly string[]): Edit[] {
  const rows = before.length;
  const columns = after.length;
  // The longest common subsequence, from the end backwards.
  const table: number[][] = Array.from({ length: rows + 1 }, () =>
    new Array<number>(columns + 1).fill(0),
  );
  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = columns - 1; j >= 0; j -= 1) {
      const same = before[i] === after[j];
      const down = table[i + 1]?.[j] ?? 0;
      const right = table[i]?.[j + 1] ?? 0;
      table[i]![j] = same ? (table[i + 1]?.[j + 1] ?? 0) + 1 : Math.max(down, right);
    }
  }

  const edits: Edit[] = [];
  let i = 0;
  let j = 0;
  while (i < rows && j < columns) {
    if (before[i] === after[j]) {
      edits.push({ kind: " ", line: i + 1, text: before[i] as string });
      i += 1;
      j += 1;
    } else if ((table[i + 1]?.[j] ?? 0) >= (table[i]?.[j + 1] ?? 0)) {
      edits.push({ kind: "-", line: i + 1, text: before[i] as string });
      i += 1;
    } else {
      edits.push({ kind: "+", line: j + 1, text: after[j] as string });
      j += 1;
    }
  }
  while (i < rows) {
    edits.push({ kind: "-", line: i + 1, text: before[i] as string });
    i += 1;
  }
  while (j < columns) {
    edits.push({ kind: "+", line: j + 1, text: after[j] as string });
    j += 1;
  }
  return edits;
}

/** The edits worth showing: every change with its context, as unified hunks. */
function render(edits: readonly Edit[]): string {
  const keep = new Set<number>();
  edits.forEach((edit, index) => {
    if (edit.kind === " ") return;
    for (
      let near = Math.max(0, index - CONTEXT);
      near <= Math.min(edits.length - 1, index + CONTEXT);
      near += 1
    ) {
      keep.add(near);
    }
  });

  const lines: string[] = [];
  let index = 0;
  while (index < edits.length) {
    if (!keep.has(index)) {
      index += 1;
      continue;
    }
    let end = index;
    while (end < edits.length && keep.has(end)) end += 1;
    lines.push(...hunk(edits.slice(index, end)));
    index = end;
  }
  return lines.join("\n");
}

function hunk(edits: readonly Edit[]): string[] {
  const from = edits.filter((edit) => edit.kind !== "+");
  const to = edits.filter((edit) => edit.kind !== "-");
  // A hunk that only adds lines starts where the first added line is, one line
  // earlier on the side it was added to; a hunk that only removes lines the
  // same way the other way round.
  const firstFrom = (from[0] as Edit | undefined)?.line ?? ((to[0] as Edit).line ?? 1) - 1;
  const firstTo = (to[0] as Edit | undefined)?.line ?? ((from[0] as Edit).line ?? 1) - 1;
  const lines = [`@@ -${firstFrom},${from.length} +${firstTo},${to.length} @@`];
  for (const edit of edits) {
    lines.push(`${edit.kind}${edit.text}`);
  }
  return lines;
}
