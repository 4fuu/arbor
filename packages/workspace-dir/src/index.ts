/**
 * @4fu/arbor-workspace-dir - the plain-directory `Workspace`.
 *
 * One directory per window, under one root, created on first use; a
 * continuation works in its predecessor's directory in place, under the same
 * ref. It is the only `Workspace` the framework ships, and it needs nothing a
 * host does not already have (docs/workspaces.md).
 */

export { DirectoryWorkspace, type DirectoryWorkspaceOptions } from "./directory-workspace.ts";
export { WorkspacePathGroup } from "./path-module.ts";
