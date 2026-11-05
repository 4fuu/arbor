/**
 * The one time format every block carries (docs/prompting.md#deliveries).
 *
 * A block's time is the instant it was written, formatted once here so no
 * component writes its own. The format is fixed and UTC, so the same block
 * always renders to the same bytes.
 */

const PAD = 2;

function two(value: number): string {
  return String(value).padStart(PAD, "0");
}

/** `2026-11-05 07:42:35`, always UTC. */
export function formatTime(time: number): string {
  const date = new Date(time);
  return (
    `${date.getUTCFullYear()}-${two(date.getUTCMonth() + 1)}-${two(date.getUTCDate())} ` +
    `${two(date.getUTCHours())}:${two(date.getUTCMinutes())}:${two(date.getUTCSeconds())}`
  );
}
