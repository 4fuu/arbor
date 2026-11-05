/**
 * @arbor/core - the service layer for one window (docs/architecture.md#layers).
 *
 * Every operation is implemented once: a direct tool and a code mode function
 * are thin wrappers of one service call, and the host API calls the same layer.
 * The window host owns the lifecycle a model cannot own for itself - the frozen
 * prefix, the reminder series, the hard limit, the continuation and the rebuild
 * after a restart - and records everything it did in the journal.
 */

export { Arbor, type ArborOptions, type Timer, type Timers, type WindowRecord } from "./host.ts";
export { Board, hostBody, readNumber, readString, type BoardEntry } from "./board.ts";
export { Coordinator, DELIVERY_PRIORITY, type CoordinationHost } from "./coordination.ts";
export {
  Dispatcher,
  ACTIVE_SET_THRESHOLD,
  BROADCAST_THRESHOLD,
  FILTER_THRESHOLD,
  MAX_CANDIDATES,
  MAX_REPLY_HOPS,
  NOTICE_THRESHOLD,
  ROUTE_THRESHOLD,
  type DecisionRecord,
  type DispatchHost,
  type DispatchResult,
  type DispatchRoute,
} from "./dispatch.ts";
export { EffectQueue, type EffectInput, type EffectOutcome } from "./effects.ts";
export { RefAllocator, eventRefOf, highestOf, type RefSeed } from "./refs.ts";
export { DEFAULT_RETRY_MS, RuleScheduler, type RuleSchedulerOptions } from "./scheduler.ts";
export {
  DEFAULT_MIN_INTERVAL_MS,
  SnapshotBuilder,
  type PromptEpoch,
  type SnapshotBuilderOptions,
} from "./snapshot.ts";
