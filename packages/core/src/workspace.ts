/**
 * The `Workspace` a host runs with (docs/workspaces.md).
 *
 * The default is a plain directory: one directory per window under one root,
 * created on first use, and a continuation works in its predecessor's directory
 * in place. It needs nothing a host does not already have, so it runs the same
 * way on Windows, Linux and macOS.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Workspace } from "@arbor/interfaces";
import { DirectoryWorkspace } from "@arbor/workspace-dir";

export interface OpenWorkspaceOptions {
  /** Where every window's directory lives. The system temporary directory by default. */
  root?: string;
}

/** The workspace this host runs with: one directory per window under one root. */
export async function openWorkspace(options: OpenWorkspaceOptions = {}): Promise<Workspace> {
  return new DirectoryWorkspace({ root: options.root ?? join(tmpdir(), "arbor", "workspaces") });
}
