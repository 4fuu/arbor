import assert from "node:assert/strict";
import { statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { layerfsCapabilities } from "./capabilities.ts";
import type { LayerfsDeployment } from "./options.ts";

/**
 * The Engine check a host reads before it mounts: the socket, the image and
 * the Engine API version, each on both sides of its rule. The Engine is a
 * local server on a unix socket that answers `GET /version` the way Docker
 * does, so the floor is checked without one: LayerFS's own client reads the
 * same unversioned endpoint and refuses an older daemon before it sends a
 * request, and a socket that only looks like Docker - Podman's compatibility
 * API stops at 1.44 - must be reported unavailable, with the version as the
 * reason, instead of a false green.
 */

/** The exact image digest shape a Sandbox mounts with. */
const IMAGE = `sha256:${"a".repeat(64)}`;

/** One fake Engine on a unix socket, and how to shut it down. */
async function fakeEngine(answers: boolean, apiVersion: string | null, securityOptions: string[] = []) {
  const directory = await mkdtemp(join(tmpdir(), "arbor-engine-"));
  const socket = join(directory, "engine.sock");
  const server: Server = createServer((request, response) => {
    if (!answers || apiVersion === null) {
      response.writeHead(500);
      response.end("{}");
      return;
    }
    if (request.url === "/version") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ApiVersion: apiVersion, Version: "29.9.2" }));
      return;
    }
    if (request.url === "/info") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ SecurityOptions: securityOptions }));
      return;
    }
    response.writeHead(500);
    response.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  return {
    socket,
    async close(): Promise<void> {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

/** The deployment a capability read uses: this socket, and an image. */
function deploymentOf(socket: string, image: string): { deployment: LayerfsDeployment } {
  return { deployment: { docker: socket, image } };
}

const started: { close(): Promise<void> }[] = [];

afterEach(async () => {
  while (started.length > 0) {
    const engine = started.pop();
    if (engine !== undefined) await engine.close();
  }
});

describe("the Docker Engine check", () => {
  it("accepts an Engine at the API floor LayerFS speaks", async () => {
    const engine = await fakeEngine(true, "1.48");
    started.push(engine);
    const capabilities = await layerfsCapabilities(deploymentOf(engine.socket, IMAGE));
    assert.equal(capabilities.docker, true);
    assert.equal(capabilities.dockerReason, null);
  });

  it("accepts an Engine above the floor", async () => {
    const engine = await fakeEngine(true, "1.52");
    started.push(engine);
    const capabilities = await layerfsCapabilities(deploymentOf(engine.socket, IMAGE));
    assert.equal(capabilities.docker, true);
    assert.equal(capabilities.dockerReason, null);
  });

  it("refuses an Engine one minor below the floor and names both versions", async () => {
    const engine = await fakeEngine(true, "1.47");
    started.push(engine);
    const capabilities = await layerfsCapabilities(deploymentOf(engine.socket, IMAGE));
    assert.equal(capabilities.docker, false);
    assert.match(capabilities.dockerReason ?? "", /1\.47/);
    assert.match(capabilities.dockerReason ?? "", /1\.48/);
  });

  it("reports Podman's socket unavailable with its version as the reason", async () => {
    // Podman answers every call LayerFS shapes but reports API 1.44, so the
    // capability must not report a mount as possible.
    const engine = await fakeEngine(true, "1.44");
    started.push(engine);
    const capabilities = await layerfsCapabilities(deploymentOf(engine.socket, IMAGE));
    assert.equal(capabilities.docker, false);
    assert.match(capabilities.dockerReason ?? "", /1\.44/);
    assert.match(capabilities.dockerReason ?? "", /1\.48/);
  });

  it("reports a socket that does not answer its version unavailable", async () => {
    const engine = await fakeEngine(false, null);
    started.push(engine);
    const capabilities = await layerfsCapabilities(deploymentOf(engine.socket, IMAGE));
    assert.equal(capabilities.docker, false);
    assert.match(capabilities.dockerReason ?? "", /did not answer/);
  });

  it("refuses a missing socket and names its path", async () => {
    const missing = join(tmpdir(), "arbor-no-engine-here.sock");
    const capabilities = await layerfsCapabilities(deploymentOf(missing, IMAGE));
    assert.equal(capabilities.docker, false);
    assert.match(capabilities.dockerReason ?? "", new RegExp(missing.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });

  it("refuses an image that is not an exact digest", async () => {
    const engine = await fakeEngine(true, "1.52");
    started.push(engine);
    const capabilities = await layerfsCapabilities(deploymentOf(engine.socket, "arbor-sandbox:latest"));
    assert.equal(capabilities.docker, false);
    assert.match(capabilities.dockerReason ?? "", /LAYERFS_IMAGE/);
  });

  it("accepts a rootful Engine whose /dev/fuse belongs to root", async () => {
    // A rootful Engine runs the Sandbox as root, so the host's root-owned
    // device is the daemon's own: the ownership is not the Engine's.
    const engine = await fakeEngine(true, "1.52", ["name=seccomp,profile=builtin", "name=cgroupns"]);
    started.push(engine);
    const capabilities = await layerfsCapabilities(deploymentOf(engine.socket, IMAGE));
    assert.equal(capabilities.docker, true);
    assert.equal(capabilities.dockerReason, null);
  });

  it("reports a rootless Engine unavailable unless /dev/fuse is this user's", async () => {
    // A rootless Engine runs the Sandbox in a user namespace, so a /dev/fuse
    // owned by anyone else reaches the container unmapped and the daemon
    // refuses it. A machine whose own user owns the device is the exception.
    const engine = await fakeEngine(true, "1.52", ["name=rootless", "name=cgroupns"]);
    started.push(engine);
    const capabilities = await layerfsCapabilities(deploymentOf(engine.socket, IMAGE));
    const uid = process.getuid?.();
    if (uid !== undefined && statSync("/dev/fuse").uid === uid) {
      assert.equal(capabilities.docker, true);
      assert.equal(capabilities.dockerReason, null);
      return;
    }
    assert.equal(capabilities.docker, false);
    assert.match(capabilities.dockerReason ?? "", /rootless/);
    assert.match(capabilities.dockerReason ?? "", /\/dev\/fuse/);
  });
});

describe("a LayerFS checkout", () => {
  /**
   * The SDK and the addon a checkout holds, laid out the way `.agents/setup`
   * leaves them: the JavaScript packages under `api/`, and the built addon in
   * the engine beside it. The probe must find the addon there, because a
   * deployment that ran the setup has no other copy to name.
   */
  it("finds the SDK and the built addon in the checkout's own layout", async () => {
    const directory = await mkdtemp(join(tmpdir(), "arbor-checkout-"));
    started.push({
      close: () => rm(directory, { recursive: true, force: true }),
    });
    const api = join(directory, "api");
    await mkdir(join(api, "agent", "src"), { recursive: true });
    await writeFile(join(api, "agent", "src", "index.js"), "export const LayerFS = {};\n");
    const addon = join(directory, "engine", "crates", "layerfs-node");
    await mkdir(addon, { recursive: true });
    await writeFile(join(addon, "layerfs.node"), "not a real addon: only its path is read\n");

    const capabilities = await layerfsCapabilities({
      sdk: api,
      deployment: { docker: join(directory, "no-engine.sock"), image: IMAGE },
    });
    assert.equal(capabilities.checkout, api);
    assert.equal(capabilities.sdk, true);
    assert.equal(capabilities.addon, true);
  });
});
