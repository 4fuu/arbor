/**
 * @4fu/arbor-workspace-ovnfs - the ovnfs `Workspace`.
 *
 * One shared folder every window reads and writes, read-only by convention; a
 * window that wants to change files opens its own copy-on-write checkout of the
 * project subfolder it needs, works there and merges back with `apply`. The
 * plain directory workspace stays the fallback when ovnfs is not installed
 * (docs/workspaces.md).
 */

import type { Journal } from "@4fu/arbor-interfaces";
import { OvnfsCli } from "./cli.ts";
import { OvnfsWorkspace } from "./ovnfs.ts";

export { OvnfsWorkspace, type OvnfsWorkspaceOptions } from "./ovnfs.ts";
export { OvnfsWorkspaceGroup } from "./groups.ts";
export { ovnfsSection, WORKSPACE_METHOD_BLOCK } from "./section.ts";
export { ovnfsText } from "./text.ts";
export type {
  OvnfsApplyReply,
  OvnfsChange,
  OvnfsCheckoutInfo,
  OvnfsConflict,
  OvnfsDiffReply,
  OvnfsLsReply,
  OvnfsNewReply,
  OvnfsStatus,
} from "./cli.ts";

/** The ovnfs release this package is built against. */
export const OVNFS_PIN = "v0.1.1";

export interface OpenOvnfsOptions {
  /** The shared folder every window works in. */
  source: string;
  /** Where the daemon keeps its state. */
  state: string;
  /** Where checkouts appear. */
  mount: string;
  /** The ovnfs binary to run; `ovnfs` on PATH by default. */
  bin?: string;
  /** The journal, for the events a checkout records and for chain resolution. */
  journal?: Journal;
  /** Called with a non-fatal note, such as a version mismatch. */
  warn?: (message: string) => void;
}

/**
 * Try to make ovnfs the workspace: find the binary, warn on a version other
 * than the pinned one (a mismatch is a warning, not a failure), and start the
 * daemon. `null` when the binary is not found or the daemon will not start, so
 * the host falls back to the plain directory workspace.
 */
export async function openOvnfs(options: OpenOvnfsOptions): Promise<OvnfsWorkspace | null> {
  const warn = options.warn ?? ((message: string) => console.warn(message));
  const cli = new OvnfsCli(options.bin ?? "ovnfs", options.state, options.mount);

  let version: string;
  try {
    version = await cli.version();
  } catch (error) {
    warn(`ovnfs: no runnable binary (${error instanceof Error ? error.message : String(error)}); falling back to the directory workspace.`);
    return null;
  }
  if (!version.includes(OVNFS_PIN.replace(/^v/, ""))) {
    warn(`ovnfs: expected ${OVNFS_PIN}, found "${version}".`);
  }

  try {
    await cli.start();
  } catch (error) {
    warn(`ovnfs: the daemon did not start (${error instanceof Error ? error.message : String(error)}); falling back to the directory workspace.`);
    return null;
  }

  return new OvnfsWorkspace({
    source: options.source,
    state: options.state,
    mount: options.mount,
    ...(options.bin === undefined ? {} : { bin: options.bin }),
    ...(options.journal === undefined ? {} : { journal: options.journal }),
  });
}
