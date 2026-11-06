/**
 * What a deployment configures for Jev, the default `Judge`
 * (docs/dispatch.md#judge-decisions, docs/architecture.md#interfaces).
 *
 * Jev is TypeSafe AI's System One classifier: one request carries one state and
 * several typed questions about it, and every answer comes back with its score
 * or its probability (qqnt-gui-driver, docs/agent-design.md section 1 and
 * apps/bot/src/jev.ts, where the same wrapper was built first). It is not a
 * chat model and not a pi provider: it is reached over HTTP with a bearer key,
 * so this package holds no model catalog of its own and adds no dependency on
 * the agent backend.
 *
 * A setting here names a secret and never holds its value
 * (docs/architecture.md#data-placement): `apiKeyEnv` is the name of the
 * environment variable the key is read from, per request, so a key that
 * appears later applies to the next decision with no restart.
 *
 * What is *not* here: the rule bounds and the fallbacks. Those live in the
 * service layer, in code that never moves, so an unreachable judge changes
 * nothing about the rules (packages/interfaces/src/judge.ts). This package
 * answers what it is asked, in every mode, and raises the core's
 * `unavailable` error when it cannot.
 */

import type { JudgeDecisionKind, JudgeMode } from "@4fu/arbor-interfaces";

/** The classifier model, and the service that serves it. */
export const JEV_MODEL_ID = "jev-latest";

/** TypeSafe's System One endpoint, under the versioned base URL. */
export const JEV_BASE_URL = "https://api.typesafe.ai/v1";

/** The environment variable naming the Jev API key. Never its value. */
export const JEV_API_KEY_ENV = "JEV_API_KEY";

/** How long one request may take before it is abandoned. 8 s. */
export const DEFAULT_TIMEOUT_MS = 8_000;

/**
 * How many items one request may ask about: candidate windows for `route`,
 * `notice` and `broadcast`, notes for `active set`. The host's own bound is at
 * most 8 route candidates (docs/dispatch.md#routing); this one keeps a state
 * that ignored it inside Jev's context window.
 */
export const DEFAULT_MAX_ITEMS = 8;

/** Where a bool answer's probability, or a score answer's level, turns into a yes. */
export interface JevThresholds {
  filter?: number;
  notice?: number;
  broadcast?: number;
  activeSet?: number;
}

/** What a tier is for, as the `model tier` question reads it. */
export const DEFAULT_TIER_CRITERIA: Record<string, string> = {
  light:
    "A short, conversational or routine task - answering, looking something up, summarising, a small edit - where a fast and cheap model is enough.",
  strong:
    "A task that needs deep reasoning or long exact work - code, design, debugging, planning across many files - where a mistake is expensive.",
};

export interface JevOptions {
  /** The environment variable naming the API key. `JEV_API_KEY`. */
  apiKeyEnv?: string;
  /** Where the key comes from when not the environment: a secret store, a console field. */
  getApiKey?: () => string | undefined;
  /** The classifier model id. `jev-latest`. */
  modelId?: string;
  /** The service base URL. `https://api.typesafe.ai/v1`. */
  baseUrl?: string;
  /** How long one request may take. 8 s. */
  timeoutMs?: number;
  /** How many items one request may ask about. 8. */
  maxItems?: number;
  /**
   * Where each decision reads its own answer. 0.5 everywhere: the classifier's
   * own probability is the answer, and a deployment that wants a decision to
   * fire more or less rarely moves it. The service layer's rule bounds and its
   * fallback when the judge is unreachable still surround every decision.
   */
  thresholds?: JevThresholds;
  /**
   * What each configured tier is for, as the `model tier` question reads it.
   * These are this package's own descriptions of the tiers it knows; what the
   * host's `settings.judge.tierCriteria` says about a tier comes first, so a
   * deployment whose tiers are not these describes them itself.
   */
  tierCriteria?: Record<string, string>;
  /** Replaces `fetch`; tests pass a fake one, so no key and no network are needed. */
  fetchImpl?: typeof fetch;
  /**
   * Scrubs secret values out of every request on the way out. Every string of
   * the state and of the questions goes through it, and the decision log
   * records the scrubbed form, so a secret value never reaches Jev and never
   * reaches the log either.
   */
  scrub?: (text: string) => string;
  /** Every decision, with its scores and the state the judge saw, for the host to log. */
  onDecision?: (log: JevDecisionLog) => void;
  /** The clock. Tests pass a fixed one. */
  now?: () => number;
}

/** Every setting resolved to the value this package uses. */
export interface ResolvedJevOptions {
  apiKeyEnv: string;
  getApiKey: () => string | undefined;
  modelId: string;
  baseUrl: string;
  timeoutMs: number;
  maxItems: number;
  thresholds: Required<JevThresholds>;
  tierCriteria: Record<string, string>;
  fetchImpl: typeof fetch;
  scrub: ((text: string) => string) | undefined;
  onDecision: ((log: JevDecisionLog) => void) | undefined;
  now: () => number;
}

/**
 * One judge request as it was sent: the decision, the mode it was asked in, the
 * state and the questions after scrubbing, every answer with its score or
 * probability, and how long it took. The host logs this record, so a threshold
 * can be tuned from what the judge actually saw
 * (docs/dispatch.md#judge-decisions).
 */
export interface JevDecisionLog {
  decision: JudgeDecisionKind;
  mode: JudgeMode;
  /** The state the judge saw, scrubbed. */
  state: Record<string, unknown>;
  /** The questions asked, scrubbed. */
  questions: Record<string, JudgeQuestion>;
  /** Every answer with its score or probability; null when the request failed. */
  answers: Record<string, JudgeAnswerValue> | null;
  ok: boolean;
  error?: string;
  durationMs: number;
  /** Token usage the service reported, when it did. */
  usage?: { input: number; output: number };
  /** Why no request was made: `no_items` or `unfiltered`. */
  skipped?: string;
}

/** A bool question: yes and no, both described. */
export interface BoolQuestion {
  type: "bool";
  instructions: string;
  yes: string;
  no: string;
}

/** A score question: one criterion per level, weakest first. */
export interface ScoreQuestion {
  type: "score";
  instructions: string;
  levels: readonly string[];
}

/** A choice question: one criterion per option, keyed by the option's name. */
export interface ChoiceQuestion {
  type: "choice";
  instructions: string;
  options: Record<string, string>;
}

export type JudgeQuestion = BoolQuestion | ScoreQuestion | ChoiceQuestion;

export type JudgeAnswerValue =
  | { type: "bool"; probability: number }
  | { type: "score"; score: number }
  | { type: "choice"; choice: string };

export function resolveJevOptions(options: JevOptions = {}): ResolvedJevOptions {
  const thresholds = options.thresholds ?? {};
  return {
    apiKeyEnv: options.apiKeyEnv ?? JEV_API_KEY_ENV,
    getApiKey: options.getApiKey ?? (() => process.env[options.apiKeyEnv ?? JEV_API_KEY_ENV]),
    modelId: options.modelId ?? JEV_MODEL_ID,
    baseUrl: options.baseUrl ?? JEV_BASE_URL,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxItems: options.maxItems ?? DEFAULT_MAX_ITEMS,
    thresholds: {
      filter: thresholds.filter ?? 0.5,
      notice: thresholds.notice ?? 0.5,
      broadcast: thresholds.broadcast ?? 0.5,
      activeSet: thresholds.activeSet ?? 0.5,
    },
    tierCriteria: { ...DEFAULT_TIER_CRITERIA, ...(options.tierCriteria ?? {}) },
    fetchImpl: options.fetchImpl ?? globalThis.fetch,
    scrub: options.scrub,
    onDecision: options.onDecision,
    now: options.now ?? (() => Date.now()),
  };
}
