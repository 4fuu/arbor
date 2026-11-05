/**
 * What a deployment configures for the LayerFS `Workspace`.
 *
 * Two kinds of setting live here: arbor's own (the project, the base Branch a
 * new window's directory forks from, how long snapshots are kept, the disk
 * quota) and LayerFS's deployment settings, which the SDK reads from the
 * environment by its own `LAYERFS_` names and which this package maps from
 * `deployment` onto those names before it opens a client. A setting never
 * holds a secret: it names one (docs/architecture.md#data-placement).
 */

import { join } from "node:path";

/** LayerFS's own deployment settings, as the SDK reads them from the environment. */
export interface LayerfsDeployment {
  /** `LAYERFS_HOME`: the private directory holding project and Sandbox records. */
  home?: string;
  /** `LAYERFS_STORE_PATH`: the installed Store file, on ext4, xfs or btrfs. */
  storePath?: string;
  /** `LAYERFS_IMAGE`: the exact image digest a Sandbox runs. */
  image?: string;
  /** `LAYERFS_DAEMON`: the built `layerfs-daemon` executable. */
  daemon?: string;
  /** `LAYERFS_DOCKER`: the Docker Engine socket. */
  docker?: string;
  /** `LAYERFS_VOLUME`: the named volume holding the Store. */
  volume?: string;
  /** `LAYERFS_CONTAINER_PREFIX`: names every container this client starts. */
  containerPrefix?: string;
  /** `LAYERFS_DAEMON_HOST`: the host a daemon's published port is dialed on. */
  daemonHost?: string;
  /** `LAYERFS_NATIVE`: the built native addon. Defaults to the checkout's own. */
  addon?: string;
  /** The folder the project's first Init imports into the base Branch. */
  source?: string;
  /** Init's own timeout, in milliseconds. LayerFS defaults to 300 s. */
  initTimeoutMs?: number;
}

export interface LayerfsWorkspaceOptions {
  /** The LayerFS project every window's directory lives in. `arbor`. */
  project?: string;
  /** The Branch a new window's directory forks from. `main`. */
  baseBranch?: string;
  /**
   * How long snapshots are kept before the host reclaims them
   * (`settings.workspaces.retentionMs`). This package does not run a clock:
   * the host calls `reclaim` when the period is over.
   */
  retentionMs?: number;
  /**
   * The disk quota `quota` reports, in bytes. LayerFS has no quota of its own,
   * so this is the limit a deployment sets and `quota` measures against.
   */
  quotaBytes?: number;
  /** Where this package keeps its own registry of refs. Defaults inside the LayerFS home. */
  stateDir?: string;
  /** LayerFS's deployment settings. */
  deployment?: LayerfsDeployment;
  /** A directory holding the LayerFS JavaScript packages, when it is not the checkout `.agents/setup` makes. */
  sdk?: string;
  /** The clock. Tests pass a fixed one. */
  now?: () => number;
}

/** Every setting resolved to the value this package uses. */
export interface ResolvedOptions {
  project: string;
  baseBranch: string;
  retentionMs: number;
  quotaBytes: number;
  stateDir: string;
  deployment: LayerfsDeployment;
  sdk: string | undefined;
  now: () => number;
}

/** How long snapshots are kept when a deployment sets nothing. 30 days. */
export const DEFAULT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** No quota unless a deployment sets one. */
export const DEFAULT_QUOTA_BYTES = 0;

/** One page size for every LayerFS read this package makes. */
export const PAGE_SIZE = 1000;

export function resolveOptions(options: LayerfsWorkspaceOptions): ResolvedOptions {
  const deployment = { ...(options.deployment ?? {}) };
  const home = deployment.home ?? process.env.LAYERFS_HOME;
  const stateDir =
    options.stateDir ??
    (home === undefined || home === "" ? undefined : join(home, "arbor"));
  return {
    project: options.project ?? "arbor",
    baseBranch: options.baseBranch ?? "main",
    retentionMs: options.retentionMs ?? DEFAULT_RETENTION_MS,
    quotaBytes: options.quotaBytes ?? DEFAULT_QUOTA_BYTES,
    stateDir: stateDir ?? join(tempDirectory(), "arbor-workspace-layerfs"),
    deployment,
    sdk: options.sdk,
    now: options.now ?? (() => Date.now()),
  };
}

function tempDirectory(): string {
  return process.env.TMPDIR ?? "/tmp";
}

/** The registry file inside a state directory. */
export function registryPathOf(stateDir: string): string {
  return join(stateDir, "registry.sqlite");
}
