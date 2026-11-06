/**
 * The default `Supervisor`: one host process per service, restarted with backoff
 * after a crash, with logs and state changes reported to the host
 * (docs/environment.md#services).
 *
 * The services under test are the smallest ones that show the guarantees: one
 * that answers its health check, and one that dies. Neither reaches the network
 * - the health check is a request on the loopback interface to the service's own
 * port.
 */

import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { Ref, ServiceSpec, ServiceStatus } from "@4fu/arbor-interfaces";
import { ProcessSupervisor } from "./process-supervisor.ts";

/** A service that answers its health check and then keeps running. */
const HEALTHY = `
const http = require("node:http");
const server = http.createServer((request, response) => {
  response.writeHead(200, { "content-type": "text/plain" });
  response.end("ok");
});
server.listen(Number(process.argv[2]), "127.0.0.1", () => process.stdout.write("listening\\n"));
`;

/** A service that exits immediately, the way a broken one does. */
const CRASHING = `process.stdout.write("starting\\n"); process.exit(3);`;

/** A service that answers its health check and reports the environment it got. */
const REPORTING = `
const http = require("node:http");
const server = http.createServer((request, response) => {
  response.writeHead(200, { "content-type": "text/plain" });
  response.end("ok");
});
server.listen(Number(process.argv[2]), "127.0.0.1", () => process.stdout.write(JSON.stringify(process.env) + "\\n"));
`;

/** A port nothing else is using, so a test's health check has something to hit. */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

interface Harness {
  supervisor: ProcessSupervisor;
  root: string;
  /** The services this host started, in the order it reported them. */
  changes: ServiceStatus[];
  spec(service: "healthy" | "crashing" | "reporting", port: number): ServiceSpec;
}

async function harness(options: { secretOf?: (name: string) => string | undefined } = {}): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "arbor-svc-"));
  const changes: ServiceStatus[] = [];
  const supervisor = new ProcessSupervisor({
    root,
    now: () => 1700000000000,
    record: async () => `r${changes.length + 1}` as Ref,
    ...(options.secretOf === undefined ? {} : { secretOf: options.secretOf }),
  });
  supervisor.onStateChange((status) => {
    changes.push(status);
  });
  const script = async (name: string, source: string): Promise<string> => {
    const path = join(root, `${name}.js`);
    await writeFile(path, source, "utf8");
    return path;
  };
  const healthy = await script("healthy", HEALTHY);
  const reporting = await script("reporting", REPORTING);
  const crashing = await script("crashing", CRASHING);
  return {
    supervisor,
    root,
    changes,
    spec(service, port) {
      return {
        name: service,
        command: process.execPath,
        args: [
          service === "healthy" ? healthy : service === "reporting" ? reporting : crashing,
          String(port),
        ],
        ports: [port],
        dir: root,
        healthCheck: { path: "/healthz", port, intervalMs: 20, timeoutMs: 5000 },
        restart: { maxRetries: 2, backoffMs: 5 },
      };
    },
  };
}

describe("the supervisor", () => {
  it("starts a service, waits for its health check and reports the state change", async () => {
    const host = await harness();
    const port = await freePort();
    const handle = await host.supervisor.start(host.spec("healthy", port));
    assert.equal(handle.name, "healthy");
    assert.equal(handle.state, "running");

    const status = await host.supervisor.status("healthy");
    assert.equal(status.state, "running");
    assert.equal(status.restarts, 0);
    assert.deepEqual(status.ports, [port]);
    // Every state change is recorded, so the host can append an event for it.
    assert.equal(host.changes.length, 1);
    assert.equal(host.changes[0]?.state, "running");
    assert.deepEqual(status.refs, ["r1"]);

    await host.supervisor.stop("healthy");
    assert.equal((await host.supervisor.status("healthy")).state, "stopped");
  });

  it("keeps a service's own output as its log", async () => {
    const host = await harness();
    const port = await freePort();
    await host.supervisor.start(host.spec("healthy", port));
    await new Promise((resolve) => setTimeout(resolve, 50));
    const page = await host.supervisor.logs("healthy", { tail: 10 });
    assert.equal(page.name, "healthy");
    assert.ok(page.items.includes("listening"), `the log holds the service's own output: ${page.items.join("|")}`);
    assert.ok(page.total >= 1);
    await host.supervisor.stop("healthy");
  });

  it("gives a service the host environment, its own env and the secrets it names", async () => {
    const host = await harness({
      secretOf: (name) => (name === "ARBOR_TEST_SECRET" ? "sk-svc-test" : undefined),
    });
    // A variable the host carries and no configuration named.
    process.env.ARBOR_TEST_HOST_ONLY = "host-only";
    const port = await freePort();
    try {
      const spec = {
        ...host.spec("reporting", port),
        env: { SERVICE_MODE: "gray" },
        secrets: ["ARBOR_TEST_SECRET"],
      };
      await host.supervisor.start(spec);
      const page = await host.supervisor.logs("reporting", { tail: 5 });
      const line = page.items.find((one) => one.startsWith("{"));
      const reported = JSON.parse(line ?? "{}") as Record<string, string>;
      // The host's environment, and the directory it works in.
      assert.ok(reported.PATH !== undefined, "a service can find programs");
      assert.ok(reported.HOME !== undefined);
      assert.equal(reported.ARBOR_WORKSPACE, host.root, "the workspace is the service's own directory");
      // What the service's own configuration adds, and the secret it names.
      assert.equal(reported.SERVICE_MODE, "gray");
      assert.equal(reported.ARBOR_TEST_SECRET, "sk-svc-test");
      // The host's own environment is inherited; the scrub, not the
      // environment, keeps a secret value from the model.
      assert.equal(reported.ARBOR_TEST_HOST_ONLY, "host-only", "the host's own environment is inherited");
      await host.supervisor.stop("reporting");
    } finally {
      delete process.env.ARBOR_TEST_HOST_ONLY;
    }
  });

  it("restarts a crash with backoff, then leaves it failed", async () => {
    const host = await harness();
    const port = await freePort();
    await assert.rejects(() => host.supervisor.start(host.spec("crashing", port)), (error: { rule?: string }) => {
      assert.equal(error.rule, "service.health_check");
      return true;
    });
    const status = await host.supervisor.status("crashing");
    assert.equal(status.state, "failed");
    // The restart policy was exhausted, and every restart was reported.
    assert.equal(status.restarts, 2);
    assert.ok(host.changes.some((change) => change.state === "failed"));
    // The refusal `reload` answers with names the health check that never passed.
    assert.equal(status.lastError?.rule, "service.health_check");
    assert.match(status.lastError?.message ?? "", /健康检查/);
  });

  it("refuses the status of a service it does not run", async () => {
    const host = await harness();
    await assert.rejects(() => host.supervisor.status("nothing"), (error: { rule?: string }) => {
      assert.equal(error.rule, "service.notfound");
      return true;
    });
  });

  it("starts a service again after a stop, from the same specification", async () => {
    const host = await harness();
    const port = await freePort();
    const spec = host.spec("healthy", port);
    await host.supervisor.start(spec);
    await host.supervisor.stop("healthy");
    const handle = await host.supervisor.restart("healthy");
    assert.equal(handle.state, "running");
    assert.equal((await host.supervisor.status("healthy")).state, "running");
    await host.supervisor.stop("healthy");
  });
});
