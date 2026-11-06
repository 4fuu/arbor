/**
 * The `Supervisor` interface: run services - start, health checks, restart with
 * backoff, logs, quotas (docs/architecture.md#interfaces,
 * docs/environment.md#services).
 *
 * A service is an application that keeps running after the window that set it
 * up has ended. The framework gives supervision, a directory of its own, logs
 * and secrets injected by name; the agent writes the application and
 * `svc.json`, and decides when to stop or remove it.
 */

import type { Ref } from "./refs.ts";
import type { Page } from "./events.ts";
import type { ArborErrorInfo } from "@4fu/arbor-errors";

export type ServiceState =
  | "starting"
  | "running"
  | "unhealthy"
  | "stopped"
  | "failed";

/** One service's configuration, from its `svc.json`. */
export interface ServiceSpec {
  name: string;
  command: string;
  args?: readonly string[];
  ports?: readonly number[];
  /** The health check `reload` waits for before the item is installed. */
  healthCheck?: { path?: string; port?: number; intervalMs?: number; timeoutMs?: number };
  /** The names of the secrets it uses; values are injected by name. */
  secrets?: readonly string[];
  restart?: { maxRetries?: number; backoffMs?: number };
  /** Resource quotas the supervisor applies. */
  quota?: { memoryBytes?: number; cpuShares?: number };
  env?: Record<string, string>;
  /**
   * The directory the service owns, which the command runs in and which no
   * window ends or reclaims. The environment forks it from the draft.
   */
  dir?: string;
}

export interface ServiceHandle {
  name: string;
  revision: number;
  state: ServiceState;
}

export interface ServiceStatus {
  name: string;
  revision: number;
  state: ServiceState;
  restarts: number;
  since: number;
  ports: readonly number[];
  lastError?: ArborErrorInfo;
  /** The events that recorded its state changes. */
  refs: readonly Ref[];
}

export interface LogOptions {
  /** Follow the log's tail. */
  tail?: number;
  since?: number;
  limit?: number;
}

export interface LogPage extends Page<string> {
  name: string;
}

export interface Supervisor {
  /** Start a service and wait for its health check. */
  start(spec: ServiceSpec): Promise<ServiceHandle>;

  status(name: string): Promise<ServiceStatus>;

  stop(name: string): Promise<void>;

  restart(name: string): Promise<ServiceHandle>;

  logs(name: string, options?: LogOptions): Promise<LogPage>;

  /**
   * Report every state change, so the host records it in the journal and runs
   * its hooks (docs/environment.md#services). Optional: an implementation that
   * reports no changes leaves service failures to `status`.
   */
  onStateChange?(handler: (status: ServiceStatus) => void | Promise<void>): void;
}
