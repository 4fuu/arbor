/**
 * The prompt section the ovnfs workspace contributes (docs/workspaces.md).
 *
 * It renders in a `<workspace>` tag, one short line per point of the method,
 * each line a fixed string in this implementation's own text table. It is not
 * marked as data: it is a standing instruction, not something a window read.
 * `{source}` is the shared folder the host named, filled in per epoch.
 */

import type { Block, BlockKindSpec, PromptSection } from "@4fu/arbor-interfaces";
import { ovnfsText } from "./text.ts";

/** The method's points, one text-table key per line, in order. */
const METHOD_LINES = [
  "workspace.method.shared",
  "workspace.method.readonly",
  "workspace.method.open",
  "workspace.method.work",
  "workspace.method.apply",
  "workspace.method.frozen",
  "workspace.method.git",
  "workspace.method.classes",
  "workspace.method.cli",
] as const;

/** The one block kind the section renders: its lines, no tag, not data. */
export const WORKSPACE_METHOD_BLOCK: BlockKindSpec = {
  kind: "workspace_method",
  data: false,
  fields: [{ name: "source", type: "string", required: true }],
  lines: [...METHOD_LINES],
};

/** The section, with the shared folder filled into its first line. */
export function ovnfsSection(source: string): PromptSection {
  const block: Block = { kind: "workspace_method", fields: { source } };
  return {
    tag: "workspace",
    blocks: [WORKSPACE_METHOD_BLOCK],
    text: ovnfsText,
    content: (): readonly Block[] => [block],
  };
}
