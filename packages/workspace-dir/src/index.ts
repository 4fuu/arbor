/**
 * @4fu/arbor-workspace-dir - the plain-directory `Workspace`.
 *
 * One directory per window, under one root, created on first use; a
 * continuation works in its predecessor's directory in place, under the same
 * ref. Beside them, the persistent directories a window asks to keep, which
 * outlive the window, the retention period and a host restart. It needs nothing
 * a host does not already have (docs/workspaces.md).
 */

export { DirectoryWorkspace, type DirectoryWorkspaceOptions } from "./directory-workspace.ts";
export { WorkspaceDirGroup } from "./module.ts";
export { directorySection, directoryText, DIRECTORY_METHOD_BLOCK } from "./section.ts";
