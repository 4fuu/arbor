/**
 * @4fu/arbor-judge-jev - the default `Judge`.
 *
 * Jev is TypeSafe AI's System One classifier (qqnt-gui-driver,
 * docs/agent-design.md section 1 and apps/bot/src/jev.ts, where the same
 * wrapper was built first): one request carries one state and several typed
 * questions about it, and every answer comes back with its score or probability.
 * It answers the host's decisions - filter, route, model tier, notice,
 * broadcast, active set (docs/dispatch.md#judge-decisions) - one request per
 * decision, scrubbed of secrets on the way out, and every answer logged with
 * its scores.
 *
 * The configuration names the secret (`JEV_API_KEY`) and never holds its value,
 * and a fake `fetchImpl` is injected in tests, so the whole contract runs
 * without a key and without the network.
 */

export { Jev, isJevUnavailable } from "./jev.ts";

export {
  JEV_API_KEY_ENV,
  JEV_BASE_URL,
  JEV_MODEL_ID,
  DEFAULT_MAX_ITEMS,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_TIER_CRITERIA,
  resolveJevOptions,
} from "./options.ts";
export type {
  JevOptions,
  JevThresholds,
  JevDecisionLog,
  ResolvedJevOptions,
  BoolQuestion,
  ScoreQuestion,
  ChoiceQuestion,
  JudgeQuestion,
  JudgeAnswerValue,
} from "./options.ts";

export type { WireRequest, WireResponse } from "./wire.ts";

export { scrubJson } from "./scrub.ts";
