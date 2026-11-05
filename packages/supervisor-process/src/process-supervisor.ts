/**
 * The default `Supervisor`: one host process per service, restarted with backoff
 * after a crash, with logs and state changes reported to the host
 * (docs/environment.md#services).
 *
 * ```text
 * <root>/logs/<name>.log    the service's own output, appended as it comes
 * ```
 *
 * A service is started with its own directory as its working directory, and its
 * secrets are injected by name: the configuration names them, the host resolves
 * their values, and neither is written down here. What a service does to the
 * outside world directly is outside the effect queue; an action that should be
 * recorded and guaranteed goes through the host API.
 *
 * Quotas are the one approximation: a memory quota is applied with `ulimit -v`,
 * which bounds address space rather than resident memory, and CPU shares are
 * not applied, because cgroups need privileges a host process does not have.
 */

import { spawn } from "node:child_process";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { get } from "node:http";
import { join } from "node:path";
import { arborError, type ArborErrorInfo } from "@arbor/errors";
import type {
  LogOptions,
  LogPage,
  Ref,
  ServiceHandle,
  ServiceSpec,
  ServiceState,
  ServiceStatus,
  Supervisor,
} from "@arbor/interfaces";
import { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT } from "@arbor/interfaces";

/** How many lines one service keeps in memory for `services.logs`. */
const LOG_MEMORY_LINES = 2000;

/** How often the health check runs. */
const DEFAULT_INTERVAL_MS = 500;

/** How long a health check may take before the start is refused. */
const DEFAULT_TIMEOUT_MS = 30000;

/** How many times a service is restarted before it is left failed. */
const DEFAULT_MAX_RETRIES = 5;

/** How long to wait between restarts. */
const DEFAULT_BACKOFF_MS = 1000;

export interface ProcessSupervisorOptions {
  /** The directory the logs live in. */
  root: string;
  /** Where a secret's value comes from. A configuration names one, never holds it. */
  secretOf?: (name: string) => string | undefined;
  /** The clock. Tests pass a fixed one. */
  now?: () => number;
  /** Records one state change and answers with its event ref. */
  record?: (status: ServiceStatus) => Promise<Ref | undefined>;
}

/** One service as this supervisor runs it. */
interface Running {
  spec: ServiceSpec;
  revision: number;
  state: ServiceState;
  restarts: number;
  since: number;
  child?: ReturnType<typeof spawn>;
  lines: string[];
  lastError?: ArborErrorInfo;
  /** The events that recorded its state changes. */
  refs: Ref[];
  /** Set when a stop was asked for, so an exit is not a crash. */
  stopping: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

export class ProcessSupervisor implements Supervisor {
  private readonly root: string;
  private readonly secretOf: ((name: string) => string | undefined) | undefined;
  private readonly clock: () => number;
  private readonly record: ((status: ServiceStatus) => Promise<Ref | undefined>) | undefined;
  private readonly running = new Map<string, Running>();
  private handler: ((status: ServiceStatus) => void | Promise<void>) | undefined;
  private logRoot: Promise<void> | undefined;

  constructor(options: ProcessSupervisorOptions) {
    this.root = options.root;
    this.secretOf = options.secretOf;
    this.clock = options.now ?? (() => Date.now());
    this.record = options.record;
  }

  /**
   * Start a service and wait for its health check. An upgrade is another start:
   * the running revision is stopped first, so the swap is the item's, not the
   * process's.
   */
  async start(spec: ServiceSpec): Promise<ServiceHandle> {
    const existing = this.running.get(spec.name);
    if (existing !== undefined) await this.kill(existing);
    const service: Running = {
      spec,
      revision: (existing?.revision ?? 0) + 1,
      state: "starting",
      restarts: existing?.restarts ?? 0,
      since: this.clock(),
      lines: [],
      refs: [],
      stopping: false,
    };
    this.running.set(spec.name, service);
    await this.spawn(service);
    await this.healthy(service);
    return { name: spec.name, revision: service.revision, state: service.state };
  }

  async status(name: string): Promise<ServiceStatus> {
    const service = this.running.get(name);
    if (service === undefined) {
      throw arborError({
        code: "not_found",
        rule: "service.notfound",
        message: `服务：没有服务 ${name}`,
        nextAction: "用 services.list 查看当前的服务。",
        details: { name },
      });
    }
    return this.statusOf(service);
  }

  async stop(name: string): Promise<void> {
    const service = this.running.get(name);
    if (service === undefined) return;
    service.stopping = true;
    await this.kill(service);
    await this.move(service, "stopped");
  }

  async restart(name: string): Promise<ServiceHandle> {
    const service = this.running.get(name);
    if (service === undefined) {
      throw arborError({
        code: "not_found",
        rule: "service.notfound",
        message: `服务：没有服务 ${name}`,
        nextAction: "用 services.list 查看当前的服务。",
        details: { name },
      });
    }
    service.stopping = false;
    service.restarts = 0;
    await this.kill(service);
    await this.spawn(service);
    await this.healthy(service);
    return { name, revision: service.revision, state: service.state };
  }

  async logs(name: string, options?: LogOptions): Promise<LogPage> {
    const service = this.running.get(name);
    const limit = clamp(options?.limit ?? options?.tail ?? DEFAULT_PAGE_LIMIT);
    const lines = service === undefined ? await this.readLog(name) : [...service.lines];
    const tail = options?.tail === undefined ? lines : lines.slice(-options.tail);
    const items = tail.slice(-limit);
    return {
      items,
      total: lines.length,
      limit,
      name,
      nextCall: `services.logs({ name: ${JSON.stringify(name)}, tail: ${limit} })`,
    };
  }

  /** Report every state change to the host, so it records one and runs its hooks. */
  onStateChange(handler: (status: ServiceStatus) => void | Promise<void>): void {
    this.handler = handler;
  }

  /** The services this supervisor runs, for `services.list`. */
  async list(): Promise<readonly ServiceStatus[]> {
    return [...this.running.values()].map((service) => this.statusOf(service));
  }

  private statusOf(service: Running): ServiceStatus {
    return {
      name: service.spec.name,
      revision: service.revision,
      state: service.state,
      restarts: service.restarts,
      since: service.since,
      ports: [...(service.spec.ports ?? [])],
      ...(service.lastError === undefined ? {} : { lastError: service.lastError }),
      refs: [...service.refs],
    };
  }

  /** Start the process, or record that it never came up. */
  private async spawn(service: Running): Promise<void> {
    const spec = service.spec;
    const secrets: Record<string, string> = {};
    for (const name of spec.secrets ?? []) {
      const value = this.secretOf?.(name);
      if (value !== undefined && value !== "") secrets[name] = value;
    }
    if (this.logRoot === undefined) {
      this.logRoot = mkdir(join(this.root, "logs"), { recursive: true }).then(() => undefined);
    }
    await this.logRoot;
    const command = quotaCommand(spec);
    const child = spawn(command.bin, command.args, {
      ...(spec.dir === undefined ? {} : { cwd: spec.dir }),
      env: { ...process.env, ...(spec.env ?? {}), ...secrets },
      stdio: ["ignore", "pipe", "pipe"],
    });
    service.child = child;
    const note = (chunk: Buffer): void => {
      const text = chunk.toString("utf8");
      for (const line of text.split("\n")) {
        if (line === "") continue;
        service.lines.push(line);
        if (service.lines.length > LOG_MEMORY_LINES) service.lines.shift();
        void appendFile(this.logPath(spec.name), `${line}\n`, "utf8").catch(() => {});
      }
    };
    child.stdout?.on("data", note);
    child.stderr?.on("data", note);
    child.on("error", (error: Error) => {
      service.lastError = {
        code: "unavailable",
        rule: "service.spawn.failed",
        message: `服务 ${spec.name} 启动失败：${error.message}`,
        nextAction: "检查 command 和 args 是否可在主机上运行。",
      };
    });
    child.on("exit", (code, signal) => {
      service.child = undefined;
      if (service.stopping) return;
      const max = spec.restart?.maxRetries ?? DEFAULT_MAX_RETRIES;
      service.lastError = {
        code: "unavailable",
        rule: "service.crashed",
        message: `服务 ${spec.name} 退出（code ${code ?? "null"}${signal === null ? "" : `, signal ${signal}`}）`,
        nextAction: "用 services.logs 查看输出，修好后用 reload 重新安装。",
      };
      if (service.restarts >= max) {
        void this.move(service, "failed");
        return;
      }
      service.restarts += 1;
      const backoff = spec.restart?.backoffMs ?? DEFAULT_BACKOFF_MS;
      service.timer = setTimeout(() => {
        // A restart that fails is reported through `status`, not through a
        // rejection nobody is waiting for.
        void this.spawn(service)
          .then(() => this.healthy(service))
          .catch(() => {});
      }, backoff);
      service.timer.unref();
    });
  }

  /**
   * Wait for the health check. A service that never becomes healthy is stopped
   * and left failed, so `reload` refuses the install.
   */
  private async healthy(service: Running): Promise<void> {
    const check = service.spec.healthCheck;
    const timeout = check?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const interval = check?.intervalMs ?? DEFAULT_INTERVAL_MS;
    const deadline = Date.now() + timeout;
    for (;;) {
      const ok = check === undefined || check.port === undefined ? this.alive(service) : await this.reachable(check.port, check.path ?? "/");
      if (ok) {
        await this.move(service, "running");
        return;
      }
      if (Date.now() >= deadline || service.state === "failed") {
        service.lastError = {
          code: "unavailable",
          rule: "service.health_check",
          message: `服务 ${service.spec.name} 没有在 ${timeout} ms 内通过健康检查`,
          nextAction: "用 services.logs 查看输出，修好后用 reload 重新安装。",
        };
        await this.kill(service);
        await this.move(service, "failed");
        throw arborError({
          code: "unavailable",
          rule: "service.health_check",
          message: `服务 ${service.spec.name} 没有通过健康检查`,
          nextAction: "用 services.logs 查看服务的输出，修好后重新调用 reload。",
          details: { name: service.spec.name },
        });
      }
      await sleep(interval);
    }
  }

  /** True when the process is up. */
  private alive(service: Running): boolean {
    return service.child !== undefined && service.child.exitCode === null;
  }

  /** One health check: a 2xx on the service's own port, on the loopback interface. */
  private reachable(port: number, path: string): Promise<boolean> {
    return new Promise((resolve) => {
      const request = get({ host: "127.0.0.1", port, path }, (response) => {
        response.resume();
        resolve((response.statusCode ?? 500) >= 200 && (response.statusCode ?? 500) < 300);
      });
      request.on("error", () => resolve(false));
      request.setTimeout(2000, () => {
        request.destroy();
        resolve(false);
      });
    });
  }

  private async kill(service: Running): Promise<void> {
    if (service.timer !== undefined) {
      clearTimeout(service.timer);
      service.timer = undefined;
    }
    const child = service.child;
    service.child = undefined;
    if (child === undefined) return;
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve();
        return;
      }
      const timer = setTimeout(() => child.kill("SIGKILL"), 2000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /** One state change: recorded by the host, then reported to it. */
  private async move(service: Running, state: ServiceState): Promise<void> {
    if (service.state === state) return;
    service.state = state;
    service.since = this.clock();
    const status = this.statusOf(service);
    const ref = this.record === undefined ? undefined : await this.record(status).catch(() => undefined);
    if (ref !== undefined) service.refs.push(ref);
    await this.handler?.(status);
  }

  private logPath(name: string): string {
    return join(this.root, "logs", `${name}.log`);
  }

  /** The log of a service this host no longer runs, for a restart. */
  private async readLog(name: string): Promise<string[]> {
    const text = await readFile(this.logPath(name), "utf8").catch(() => "");
    return text.split("\n").filter((line) => line !== "");
  }
}

/** A memory quota is applied with `ulimit`, so the command is wrapped in a shell. */
function quotaCommand(spec: ServiceSpec): { bin: string; args: string[] } {
  const args = [...(spec.args ?? [])];
  const memory = spec.quota?.memoryBytes;
  if (memory === undefined || memory <= 0) return { bin: spec.command, args };
  const kilobytes = Math.max(1, Math.floor(memory / 1024));
  return {
    bin: "/bin/sh",
    args: ["-c", `ulimit -v ${kilobytes}; exec "$@"`, "arbor-service", spec.command, ...args],
  };
}

function clamp(limit: number): number {
  if (!Number.isFinite(limit)) return DEFAULT_PAGE_LIMIT;
  return Math.min(Math.max(1, Math.floor(limit)), MAX_PAGE_LIMIT);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
