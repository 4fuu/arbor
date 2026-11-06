/**
 * @4fu/arbor-supervisor-process - the default `Supervisor`: one host process per
 * service, restarted with backoff after a crash, with logs, state changes and
 * quotas (docs/environment.md#services).
 */

export { ProcessSupervisor, type ProcessSupervisorOptions } from "./process-supervisor.ts";
