/**
 * Whether this machine can run LayerFS at all, and how far.
 *
 * LayerFS needs three separate things, and a deployment has them or it does
 * not: the JavaScript packages and their native addon, a Store on a local
 * filesystem that carries SQLite locks between kernels (ext4, xfs or btrfs -
 * LayerFS's own allowlist), and, for a mount, `/dev/fuse` plus a Docker Engine
 * and the image a Sandbox runs. Tests that need one of them skip when it is
 * missing, so a host without FUSE still runs everything else.
 *
 * The Engine check is a live one: LayerFS's own client negotiates the Engine
 * API version once and refuses an older daemon before it sends a request, so a
 * socket that only looks like Docker is not enough. Podman's compatibility
 * API answers every call this package shapes but stops at API 1.44, four
 * minors below the floor, and is reported unavailable with that as the reason.
 */

import { existsSync, statSync, statfsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { request as httpRequest } from "node:http";
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
  /**
   * Why `docker` is false: the rule that refused it, in words a host can act
   * on. Null exactly when `docker` is true.
   */
  dockerReason: string | null;
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

/** The image a Sandbox runs, when the deployment names one. */
function sandboxImageOf(deployment: LayerfsDeployment | undefined): string {
  return deployment?.image ?? process.env.LAYERFS_IMAGE ?? "";
}

/** Whether `image` is the exact digest shape LayerFS mounts with. */
function isDigest(image: string): boolean {
  return image.startsWith("sha256:") && image.length === 71;
}

/**
 * The oldest Docker Engine API minor version a Sandbox runs on: 1.48, Docker
 * Engine 28.0. LayerFS's client reads the daemon's version once and refuses an
 * older one before it sends a request, so a socket that only answers like
 * Docker is not enough - Podman's compatibility API stops at 1.44.
 */
export const DOCKER_API_FLOOR = 48;

/** How long the Engine's version read may take before its socket counts as dead. */
const VERSION_TIMEOUT_MS = 2_000;

/** The `ApiVersion` an Engine's `GET /version` reports, as its minor number. */
function apiMinorOf(body: string): number | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    return null;
  }
  const version = (parsed as { ApiVersion?: unknown } | null)?.ApiVersion;
  if (typeof version !== "string") return null;
  const match = /^1\.(\d+)$/.exec(version);
  return match === null ? null : Number(match[1]);
}

/** One read over the Engine's socket, or null when it does not answer readably. */
function engineRead(socket: string, path: string): Promise<string | null> {
  return new Promise((resolve) => {
    const pending = httpRequest({ socketPath: socket, method: "GET", path }, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        resolve(null);
        return;
      }
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        body += chunk;
      });
      response.on("end", () => resolve(body));
      response.on("error", () => resolve(null));
    });
    pending.setTimeout(VERSION_TIMEOUT_MS, () => {
      pending.destroy();
      resolve(null);
    });
    pending.on("error", () => resolve(null));
    pending.end();
  });
}

/**
 * One unversioned `GET /version` over the Engine's socket: the same read
 * LayerFS's client negotiates with. Null when the socket does not answer it
 * readably - a dead or non-Docker socket cannot run a mount either way.
 */
function engineApiMinor(socket: string): Promise<number | null> {
  return engineRead(socket, "/version").then((body) => (body === null ? null : apiMinorOf(body)));
}

/**
 * Whether the Engine is rootless, from the `GET /info` its daemon answers, or
 * null when it does not answer readably.
 */
function engineRootless(socket: string): Promise<boolean | null> {
  return engineRead(socket, "/info").then((body) => {
    if (body === null) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(body) as unknown;
    } catch {
      return null;
    }
    const options = (parsed as { SecurityOptions?: unknown } | null)?.SecurityOptions;
    if (!Array.isArray(options)) return null;
    // Docker reports each option as `name=<key>`, with a `,profile=` suffix on
    // some: the rootless one is `name=rootless`.
    return options.some(
      (option) => option === "rootless" || (typeof option === "string" && option.startsWith("name=rootless")),
    );
  });
}

/** The owner of the `/dev/fuse` a mount needs, or null when there is none. */
function deviceOwner(device?: { uid: number }): number | null {
  // A caller that cannot read the host's device - a test on a machine without
  // one - names the owner it wants checked.
  if (device !== undefined) return device.uid;
  if (!existsSync("/dev/fuse")) return null;
  return statSync("/dev/fuse").uid;
}

/**
 * Why this machine cannot run a mount, or null when it can: an Engine socket
 * that answers, an image named by exact digest, an Engine API at least the
 * floor LayerFS speaks, and - on a rootless Engine - a `/dev/fuse` the
 * Sandbox's daemon will own. Each reason names the rule that refused it.
 *
 * `device` names the `/dev/fuse` to check instead of the host's, for a caller
 * that cannot read it.
 */
export async function dockerAvailable(
  deployment: LayerfsDeployment | undefined,
  device?: { uid: number },
): Promise<string | null> {
  const socket = dockerSocketOf(deployment);
  if (!existsSync(socket)) return `no Docker Engine socket at ${socket}`;
  if (!isDigest(sandboxImageOf(deployment))) {
    return "LAYERFS_IMAGE is not an exact sha256: digest, so no Sandbox image is named";
  }
  const minor = await engineApiMinor(socket);
  if (minor === null) return `the Docker Engine at ${socket} did not answer GET /version`;
  if (minor < DOCKER_API_FLOOR) {
    return (
      `the Docker Engine at ${socket} answers API 1.${minor}, older than the ` +
      `1.${DOCKER_API_FLOOR} (Docker Engine 28.0) LayerFS requires`
    );
  }
  // A rootless Engine runs the Sandbox in a user namespace, so the host's
  // /dev/fuse reaches the container unmapped unless the device is owned by
  // the user the Engine runs as - and the daemon refuses a device it does
  // not own, rather than serving an unprotected mount.
  if ((await engineRootless(socket)) === true) {
    const uid = process.getuid?.();
    const owner = deviceOwner(device);
    if (uid !== undefined && owner !== null && owner !== uid) {
      return (
        `the Docker Engine at ${socket} is rootless, and /dev/fuse belongs to another user: ` +
        `the Sandbox's daemon runs in a user namespace and refuses a device it does not own`
      );
    }
  }
  return null;
}

function addonPathOf(options: LayerfsWorkspaceOptions): string | null {
  const explicit = options.deployment?.addon ?? process.env.LAYERFS_NATIVE;
  if (explicit !== undefined && explicit !== "") return explicit;
  const checkout = layerfsCheckout(options);
  if (checkout === null) return null;
  // The checkout is its `api` directory, so the engine - where
  // `.agents/setup` leaves the built addon - is one level up.
  return join(checkout, "..", "engine", "crates", "layerfs-node", "layerfs.node");
}

/** What this machine can run, without starting anything. */
export async function layerfsCapabilities(
  options: LayerfsWorkspaceOptions = {},
): Promise<LayerfsCapabilities> {
  const checkout = layerfsCheckout(options);
  const addon = addonPathOf(options);
  const dockerReason = await dockerAvailable(options.deployment);
  return {
    sdk: checkout !== null,
    addon: addon !== null && existsSync(addon),
    store: storeFilesystemSupported(storePathOf(options.deployment)),
    fuse: fuseAvailable(),
    docker: dockerReason === null,
    dockerReason,
    checkout,
  };
}

/** Whether the options name an absolute path a host can use. */
export function isConfiguredPath(path: string | undefined): path is string {
  return typeof path === "string" && isAbsolute(path);
}
