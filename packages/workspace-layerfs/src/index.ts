/**
 * @arbor/workspace-layerfs - the default `Workspace` on LayerFS
 * (docs/workspaces.md).
 *
 * A directory per window, forks for continuations that copy no files, a
 * snapshot after every write and every bash call, and read-only mounts of
 * another workspace's snapshots by ref. No LayerFS id crosses the interface:
 * this package keeps the mapping from arbor's refs to LayerFS's Branches and
 * Commits in its own registry.
 */

export { LayerfsWorkspace } from "./layerfs-workspace.ts";
export type { LayerfsWorkspaceOptions, LayerfsDeployment, ResolvedOptions } from "./options.ts";
export { DEFAULT_RETENTION_MS, DEFAULT_QUOTA_BYTES } from "./options.ts";
export {
  layerfsCapabilities,
  storeFilesystemSupported,
  fuseAvailable,
  dockerAvailable,
  unavailableReason,
} from "./capabilities.ts";
export type { LayerfsCapabilities } from "./capabilities.ts";
export { layerfsCheckout, loadLayerfsBackend, loadLayerfsSdk } from "./layerfs-sdk.ts";
export type {
  LayerfsBackendClient,
  LayerfsClient,
  LayerfsProcess,
  LayerfsSdk,
  LayerfsStartedProcess,
} from "./layerfs-sdk.ts";
export { Registry } from "./registry.ts";
export type { WorkspaceRecord, SnapshotRecord } from "./registry.ts";
export { parseRef, viewBranchNameOf, workspaceRefOf, workspaceNumberOf } from "./refs.ts";
export type { ParsedRef } from "./refs.ts";
