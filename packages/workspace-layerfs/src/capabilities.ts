/**
 * Whether this machine can run LayerFS at all, and how far.
 *
 * LayerFS needs three separate things, and a deployment has them or it does
 * not: the JavaScript packages and their native addon, a Store on a local
 * filesystem that carries SQLite locks between kernels (ext4, xfs or btrfs -
 * LayerFS's own allowlist), and, for a mount, `/dev/fuse` plus a Docker Engine
 * and the image a Sandbox runs. Tests that need one of them skip when it is
 * missing, so a host without FUSE still runs everything else.
 */

import { existsSync, statfsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { LayerfsDeployment, LayerfsWorkspaceOptions } from "./options.ts";
import { layerfsCheckout } from "./layerfs-sdk.ts";

/** Filesystem magic numbers LayerFS's Store guard allows. */
const STORE_FILESYSTEMS: readonly number[] = [
  0xef53, // ext4
  0x58465342, // xfs
  0x9123683e, // btrfs
];

/** The default Docker Engine socket. */
export const DEFAULT_DOCKER_SOCKET = "/var/run/docker.sock";

export interface LayerfsCapabilities {
  /** The LayerFS JavaScript packages are installed. */
  sdk: boolean;
  /** The native addon is built. */
  addon: boolean;
  /** A Store path on ext4, xfs or btrfs. */
  store: boolean;
  /** `/dev/fuse`, which a mount needs. */
  fuse: boolean;
  /** A Docker Engine socket and the image a Sandbox runs. */
  docker: boolean;
  /** The checkout the SDK was found in, when there is one. */
  checkout: string | null;
}

function storePathOf(deployment: LayerfsDeployment | undefined): string {
  return deployment?.storePath ?? process.env.LAYERFS_STORE_PATH ?? "";
}

function storeDirectory(path: string): string {
  if (path === "") return "";
  const directory = path.slice(0, Math.max(0, path.lastIndexOf("/")));
  return directory === "" ? "/" : directory;
}

/** Whether `path` is on a filesystem that carries the Store's locks. */
export function storeFilesystemSupported(path: string): boolean {
  const directory = storeDirectory(path);
  if (directory === "" || !existsSync(directory)) return false;
  try {
    return STORE_FILESYSTEMS.includes(statfsSync(directory).type);
  } catch {
    return false;
  }
}

/** Whether this machine has `/dev/fuse`. */
export function fuseAvailable(): boolean {
  return existsSync("/dev/fuse");
}

function dockerSocketOf(deployment: LayerfsDeployment | undefined): string {
  return deployment?.docker ?? process.env.LAYERFS_DOCKER ?? DEFAULT_DOCKER_SOCKET;
}

/** Whether a Docker Engine socket is reachable and an image is named. */
export function dockerAvailable(deployment: LayerfsDeployment | undefined): boolean {
  const socket = dockerSocketOf(deployment);
  if (!existsSync(socket)) return false;
  const image = deployment?.image ?? process.env.LAYERFS_IMAGE ?? "";
  return image.startsWith("sha256:") && image.length === 71;
}

function addonPathOf(options: LayerfsWorkspaceOptions): string | null {
  const explicit = options.deployment?.addon ?? process.env.LAYERFS_NATIVE;
  if (explicit !== undefined && explicit !== "") return explicit;
  const checkout = layerfsCheckout(options);
  if (checkout === null) return null;
  return join(checkout, "..", "..", "engine", "crates", "layerfs-node", "layerfs.node");
}

/** What this machine can run, without starting anything. */
export function layerfsCapabilities(options: LayerfsWorkspaceOptions = {}): LayerfsCapabilities {
  const checkout = layerfsCheckout(options);
  const addon = addonPathOf(options);
  return {
    sdk: checkout !== null,
    addon: addon !== null && existsSync(addon),
    store: storeFilesystemSupported(storePathOf(options.deployment)),
    fuse: fuseAvailable(),
    docker: dockerAvailable(options.deployment),
    checkout,
  };
}

/** Whether the options name an absolute path a host can use. */
export function isConfiguredPath(path: string | undefined): path is string {
  return typeof path === "string" && isAbsolute(path);
}
