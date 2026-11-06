/**
 * The `Workspace` a host runs with (docs/workspaces.md).
 *
 * The default is ovnfs when its binary is found and its daemon starts: one
 * shared folder every window reads, read-only by convention, with per-window
 * copy-on-write checkouts the model opens and applies back. When ovnfs is not
 * installed, or its daemon will not start, the host falls back to the plain
 * directory workspace - one directory per window, created on first use, a
 * continuation working in its predecessor's directory in place - which needs
 * nothing a host does not already have and runs the same way on Windows, Linux
 * and macOS.
 */

import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Journal, Workspace } from "@4fu/arbor-interfaces";
import { openOvnfs } from "@4fu/arbor-workspace-ovnfs";
import { DirectoryWorkspace } from "@4fu/arbor-workspace-dir";

/** Which backend `openWorkspace` settled on. */
export type WorkspaceBackend = "ovnfs" | "dir";

export interface OpenWorkspaceOptions {
  /** Where the plain-directory fallback keeps every window's directory. The system temporary directory by default. */
  root?: string;
  /** The shared folder the ovnfs workspace works in. Absent leaves the plain-directory fallback in place. */
  source?: string;
  /** Where the ovnfs daemon keeps its state. Under the data directory by default. */
  state?: string;
  /** Where ovnfs checkouts appear. Under the data directory by default. */
  mount?: string;
  /** The ovnfs binary to run; `ovnfs` on PATH by default. */
  bin?: string;
  /** The journal, for the events an ovnfs checkout records and for chain resolution. */
  journal?: Journal;
  /** Called with a non-fatal note, such as a version mismatch or a fallback. */
  warn?: (message: string) => void;
}

export interface OpenWorkspaceResult {
  workspace: Workspace;
  /** Which backend was chosen, so the host can report it at start. */
  backend: WorkspaceBackend;
}

/** The workspace this host runs with: ovnfs when it is there, else a plain directory. */
export async function openWorkspace(options: OpenWorkspaceOptions = {}): Promise<OpenWorkspaceResult> {
  const warn = options.warn ?? ((message: string) => console.warn(message));
  const root = options.root ?? join(tmpdir(), "arbor", "workspaces");

  // ovnfs is tried only when a shared folder is named: it is the one thing the
  // plain-directory fallback does not need, so a deployment that never names one
  // stays on the fallback whatever is installed.
  if (options.source !== undefined) {
    const data = dirname(root);
    const ovnfs = await openOvnfs({
      source: options.source,
      state: options.state ?? join(data, "ovnfs", "state"),
      mount: options.mount ?? join(data, "ovnfs", "checkouts"),
      ...(options.bin === undefined ? {} : { bin: options.bin }),
      ...(options.journal === undefined ? {} : { journal: options.journal }),
      warn,
    });
    if (ovnfs !== null) return { workspace: ovnfs, backend: "ovnfs" };
  }

  return { workspace: new DirectoryWorkspace({ root }), backend: "dir" };
}
