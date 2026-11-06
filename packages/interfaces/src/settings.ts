/**
 * Settings: identity and general rules, judge modes, thresholds, model tiers
 * and the limits the framework does enforce (docs/environment.md,
 * docs/dispatch.md, docs/windows.md).
 *
 * The model may change all of it except the value of a secret. A setting names
 * a secret and never holds its value.
 */

import type { JudgeDecisionKind, JudgeMode } from "./judge.ts";

export interface Settings {
  /** `<identity>`; omitted when empty, with no default sentence. */
  identity?: string;
  /** `<agent>`: the general rules, one per line. */
  generalRules?: readonly string[];

  judge?: {
    /** Each decision is `on` by default; each can be `off` or `shadow`. */
    modes?: Partial<Record<JudgeDecisionKind, JudgeMode>>;
    /** The bounded share of the active-set score the judge may add. */
    activeSetJudgeShare?: number;
    /** How many candidate windows the route decision may score. At most 8. */
    maxCandidates?: number;
    /**
     * What each configured tier is for, as the `model tier` question reads it:
     * one line of text per tier name (docs/dispatch.md#model-tiers). A tier
     * named here with no text falls back to the judge's own description of it.
     */
    tierCriteria?: Record<string, string>;
  };

  /** Each tier maps to a model from the backend's catalog. */
  modelTiers?: Record<string, string>;
  /** The tier a new window gets when the judge does not decide. */
  defaultTier?: string;

  window?: {
    /** How long an ended run stays open for a related input. 300 s. */
    idleSeconds?: number;
    /** The context window's token budget. */
    contextTokens?: number;
    /** Tokens held back from the model. */
    reserveTokens?: number;
    /** How long a window protects the target it started on. 60 s. */
    protectionSeconds?: number;
  };

  snapshot?: {
    /** The system prompt and memory snapshot rebuild at most this often. 10 min. */
    minIntervalMs?: number;
  };

  notes?: {
    /** How many notes the active set may hold. */
    activeCount?: number;
    /** The active set's token budget, which bounds every prefix. */
    activeTokenBudget?: number;
  };

  schedule?: {
    /** Spread colliding repeating tasks apart, and their jitter. Off by default. */
    spreadColliding?: boolean;
    jitterMs?: number;
  };

  workspaces?: {
    /** How long a chain's directory is kept after its last window ended, before the host reclaims it. */
    retentionMs?: number;
    /**
     * The shared folder every window works in, for the ovnfs workspace: it can
     * hold several projects and repositories, and it is read-only by convention.
     * Absent leaves the plain-directory workspace's own root in place.
     */
    shared?: string;
    /** The ovnfs daemon's paths, under the host's data directory by default. */
    ovnfs?: {
      /** Where the daemon keeps its state. */
      state?: string;
      /** Where checkouts appear. */
      mount?: string;
      /** The ovnfs binary to run; `ovnfs` on PATH by default. */
      bin?: string;
    };
  };

  /** The names of the secrets a configuration may use. Never their values. */
  secrets?: readonly string[];
}
