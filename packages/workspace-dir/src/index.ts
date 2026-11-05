/**
 * @arbor/workspace-dir - the plain-directory `Workspace`.
 *
 * One directory per window, with forks and snapshots as simple copies. The
 * default `Workspace` is LayerFS, which is pinned behind the interface; this
 * implementation is what a deployment that never works with files, or one that
 * runs where LayerFS cannot, uses instead (docs/workspaces.md).
 */

export { DirectoryWorkspace, type DirectoryWorkspaceOptions } from "./directory-workspace.ts";
