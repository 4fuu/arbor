/**
 * The `Workspace` a host runs with (docs/workspaces.md).
 *
 * LayerFS is the default: a workspace is one of its Branches, a snapshot one of
 * its Commits, and `bash` runs in the Sandbox it mounts the Branch in. It needs
 * a Linux machine with `/dev/fuse`, a Docker Engine speaking the API version
 * LayerFS requires and the image a Sandbox runs, so a host that has all of that
 * gets LayerFS and a host that does not gets a plain directory instead: the
 * same interface, with forks and snapshots as copies.
 *
 * A host that cannot run LayerFS logs the reason the capability check gives and
 * keeps working. The work environment degrades - forks and snapshots cost a
 * copy - and the framework does not fail, because the fallback implements the
 * same interface. A deployment that never works with files passes no workspace
 * at all (docs/workspaces.md#lifecycle).
 */

import { join } from "node:path";
import type { Workspace } from "@arbor/interfaces";
import { DirectoryWorkspace } from "@arbor/workspace-dir";
import { LayerfsWorkspace, type LayerfsWorkspaceOptions } from "@arbor/workspace-layerfs";

export interface OpenWorkspaceOptions {
  /**
   * LayerFS's own settings: the project, the base Branch, how long snapshots
   * are kept, the disk quota and the deployment. Every one is read from the
   * environment by its `LAYERFS_` name when it is omitted.
   */
  layerfs?: LayerfsWorkspaceOptions;
  /**
   * Where the plain-directory fallback keeps every window's directory. Beside
   * the LayerFS home by default, so a host that has a LayerFS home keeps its
   * fallback directories in one place.
   */
  root?: string;
}

export interface WorkspaceChoice {
  /** The workspace a host hands `Arbor`. */
  workspace: Workspace;
  /** Why LayerFS was not used, or null when it was. */
  reason: string | null;
}

/**
 * The workspace this host runs with: LayerFS where the machine can mount it, a
 * plain directory where it cannot. The check starts nothing - it reads the
 * checkout, the addon, the Store's filesystem, `/dev/fuse` and the Engine - so
 * a host pays for it once, when it composes its stack.
 */
export async function openWorkspace(options: OpenWorkspaceOptions = {}): Promise<WorkspaceChoice> {
  const layerfs = new LayerfsWorkspace(options.layerfs ?? {});
  const capabilities = await layerfs.capabilities();
  if (capabilities.reason === null) return { workspace: layerfs, reason: null };
  // The LayerFS workspace opened its own registry to answer the check; a host
  // that falls back never touches it again.
  await layerfs.close();
  const root = options.root ?? fallbackRoot();
  console.warn(`workspace: LayerFS is unavailable (${capabilities.reason}); using the plain directory ${root}`);
  return { workspace: new DirectoryWorkspace({ root }), reason: capabilities.reason };
}

/** Where the fallback keeps every window's directory when a host names nowhere. */
function fallbackRoot(): string {
  const home = process.env.LAYERFS_HOME ?? process.env.TMPDIR ?? "/tmp";
  return join(home, "arbor", "workspaces");
}
