/**
 * Jev, the default `Judge` (docs/dispatch.md#judge-decisions).
 *
 * Jev is TypeSafe AI's System One classifier: `POST {base}/systemone` with one
 * JSON state and several typed questions about it, and one answer per question,
 * each with its score or probability. It answers the host's decisions - filter,
 * route, model tier, notice, broadcast, active set - one request per decision
 * with its questions batched, and it decides whether, where and when. It never
 * writes text; the model owns content.
 *
 * This wrapper owns four things and nothing else:
 *
 *  1. **One request per decision.** `decide` builds the decision's questions
 *     and its state (questions.ts), scrubs both (scrub.ts), posts them once
 *     (wire.ts) and reads the answers back into the core's own shapes.
 *  2. **Scrubbing on the way out.** Every string of the state and of the
 *     questions goes through `scrub` before it leaves the host, and the decision
 *     log records the scrubbed form, so a secret value reaches neither Jev nor
 *     the log (docs/dispatch.md#judge-decisions).
 *  3. **Every answer with its scores.** `onDecision` is called once per decision
 *     with the state the judge saw, the questions, every answer with its score
 *     or probability, the token usage and how long it took, so the host logs
 *     them and tunes its thresholds from real decisions.
 *  4. **Refusing, not guessing.** A missing key, a transport failure or an
 *     answer of the wrong shape raises the core's `unavailable` error naming the
 *     rule and the next action. It never fabricates an answer: the rule bounds
 *     and the fallbacks live in the service layer, so an unreachable judge
 *     changes nothing about the rules (packages/interfaces/src/judge.ts).
 *
 * What it does not own: the rule bounds and the fallbacks around a decision.
 * The judge answers what it is asked, in `shadow` exactly as in `on`, and the
 * mode rides on the decision log. A decision that is `off` asks nothing at all
 * and is answered with that decision's own documented default
 * (docs/dispatch.md#judge-decisions), so it costs no request.
 */

import { arborError } from "@arbor/errors";
import type {
  ActiveSetRequest,
  BroadcastRequest,
  FilterRequest,
  Judge,
  JudgeAnswer,
  JudgeRequest,
  ModelTierRequest,
  NoticeRequest,
  RouteRequest,
} from "@arbor/interfaces";

import type { JudgeAnswerValue, JudgeQuestion, JevOptions, ResolvedJevOptions } from "./options.ts";
import { resolveJevOptions } from "./options.ts";
import {
  activeSetAnswer,
  broadcastAnswer,
  filterAnswer,
  modelTierAnswer,
  noticeAnswer,
  prepareActiveSet,
  prepareBroadcast,
  prepareFilter,
  prepareModelTier,
  prepareNotice,
  prepareRoute,
  routeAnswer,
  type PreparedDecision,
} from "./questions.ts";
import { scrubJson, scrubQuestions } from "./scrub.ts";
import { fromWireAnswer, toWireQuestion, type WireRequest, type WireResponse } from "./wire.ts";

/** The rule every refusal of this package names. */
const UNAVAILABLE_RULE = "judge.jev.unreachable";

/** The next action every refusal of this package names. */
const UNAVAILABLE_ACTION =
  "the service layer applies this decision's rule fallback (docs/dispatch.md#judge-decisions)";

/** What one posted decision came back with, for the decision log. */
interface Outcome {
  answers: Record<string, JudgeAnswerValue> | null;
  ok: boolean;
  error?: string;
  usage?: { input: number; output: number };
  skipped?: string;
}

/** One decision as the host logs it: the outcome, what was sent and how long it took. */
interface DecisionRecord extends Outcome {
  state: Record<string, unknown>;
  questions: Record<string, JudgeQuestion>;
  durationMs: number;
}

/** What one decision came back with: its answers, and the items they belong to. */
interface Answered {
  answers: Record<string, JudgeAnswerValue>;
  /** The items the questions were asked about; empty when nothing was. */
  asked: readonly string[];
}

export class Jev implements Judge {
  readonly name = "jev";

  private readonly options: ResolvedJevOptions;

  constructor(options: JevOptions = {}) {
    this.options = resolveJevOptions(options);
  }

  /** Answer one decision. One request, with that decision's questions batched. */
  async decide(request: JudgeRequest): Promise<JudgeAnswer> {
    switch (request.decision) {
      case "filter":
        return this.filter(request);
      case "route":
        return this.route(request);
      case "model_tier":
        return this.modelTier(request);
      case "notice":
        return this.notice(request);
      case "broadcast":
        return this.broadcast(request);
      case "active_set":
        return this.activeSet(request);
    }
  }

  private async filter(request: FilterRequest): Promise<JudgeAnswer> {
    const { answers } = await this.run(request, prepareFilter(request.state, request.criteria ?? []));
    return filterAnswer(answers, this.options.thresholds.filter);
  }

  private async route(request: RouteRequest): Promise<JudgeAnswer> {
    const prepared = prepareRoute(request.state, this.options.maxItems, request.criteria ?? []);
    const { answers, asked } = await this.run(request, prepared);
    return routeAnswer(answers, asked, request.state.candidates);
  }

  private async modelTier(request: ModelTierRequest): Promise<JudgeAnswer> {
    const prepared = prepareModelTier(request.state, request.criteria ?? [], this.options.tierCriteria);
    const { answers } = await this.run(request, prepared);
    return modelTierAnswer(answers, request.state.tiers);
  }

  private async notice(request: NoticeRequest): Promise<JudgeAnswer> {
    const prepared = prepareNotice(request.state, this.options.maxItems, request.criteria ?? []);
    const { answers, asked } = await this.run(request, prepared);
    return noticeAnswer(answers, request.state, asked, this.options.thresholds.notice);
  }

  private async broadcast(request: BroadcastRequest): Promise<JudgeAnswer> {
    const prepared = prepareBroadcast(request.state, this.options.maxItems, request.criteria ?? []);
    // An environment delta is never filtered (docs/dispatch.md#judge-decisions):
    // every window needs it, so there is nothing to ask about and no request is
    // made. The decision is still logged, with the state and why it was skipped.
    const unfiltered = request.state.unfiltered === true;
    const { answers, asked } = await this.run(
      request,
      unfiltered ? { ...prepared, questions: {} } : prepared,
      unfiltered ? "unfiltered" : "no_items",
    );
    return broadcastAnswer(answers, request.state, asked, this.options.thresholds.broadcast);
  }

  private async activeSet(request: ActiveSetRequest): Promise<JudgeAnswer> {
    const prepared = prepareActiveSet(request.state, this.options.maxItems, request.criteria ?? []);
    const { answers, asked } = await this.run(request, prepared);
    return activeSetAnswer(answers, request.state, asked, this.options.thresholds.activeSet);
  }

  /**
   * Posts one decision and reads its answers back. The state and the questions
   * are scrubbed once, here, on the way out, and the scrubbed forms are what the
   * decision log records.
   */
  private async run(
    request: JudgeRequest,
    prepared: PreparedDecision,
    skipped: "off" | "no_items" | "unfiltered" = "no_items",
  ): Promise<Answered> {
    const scrub = this.options.scrub;
    const state =
      scrub === undefined ? prepared.state : (scrubJson(prepared.state, scrub) as Record<string, unknown>);
    const questions = scrub === undefined ? prepared.questions : scrubQuestions(prepared.questions, scrub);
    const started = this.options.now();
    const finish = (outcome: Outcome, asked: readonly string[]): Answered => {
      this.log(request, { state, questions, ...outcome, durationMs: this.options.now() - started });
      if (!outcome.ok || outcome.answers === null) {
        throw arborError({
          code: "unavailable",
          rule: UNAVAILABLE_RULE,
          message: outcome.error ?? "Jev did not answer",
          nextAction: UNAVAILABLE_ACTION,
        });
      }
      return { answers: outcome.answers, asked };
    };

    // `off`: the decision acts on nothing, so nothing is asked and no request is
    // made. Every answer below falls back to its own default, which is the same
    // default the service layer applies (docs/dispatch.md#judge-decisions).
    if (request.mode === "off") {
      return finish({ answers: {}, ok: true, skipped: "off" }, []);
    }

    // Nothing to ask about: an unfiltered broadcast, no candidates, or no
    // configured tiers. The decision is logged as skipped and every answer
    // falls back to its own default.
    if (Object.keys(questions).length === 0) {
      return finish({ answers: {}, ok: true, skipped }, []);
    }

    try {
      const response = await this.post({ model: this.options.modelId, state, questions });
      const answers: Record<string, JudgeAnswerValue> = {};
      for (const [id, question] of Object.entries(questions)) {
        const answer = response.answers[id];
        if (answer === undefined) continue;
        answers[id] = fromWireAnswer(id, question, answer);
      }
      const outcome: Outcome = {
        answers,
        ok: true,
        ...(response.usage === undefined ? {} : { usage: response.usage }),
      };
      return finish(outcome, prepared.items);
    } catch (error) {
      return finish(
        {
          answers: null,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        },
        [],
      );
    }
  }

  /** One System One request, with the bearer key read per call. */
  private async post(body: WireRequest): Promise<WireResponse> {
    const apiKey = this.options.getApiKey();
    if (apiKey === undefined || apiKey === "") {
      throw arborError({
        code: "unavailable",
        rule: UNAVAILABLE_RULE,
        message: `the Jev API key is not configured: set ${this.options.apiKeyEnv}`,
        nextAction: UNAVAILABLE_ACTION,
      });
    }
    const wire = {
      model: body.model,
      state: body.state,
      questions: Object.fromEntries(
        Object.entries(body.questions).map(([id, question]) => [id, toWireQuestion(question)]),
      ),
    };
    const response = await this.options.fetchImpl(`${this.options.baseUrl.replace(/\/+$/u, "")}/systemone`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify(wire),
      signal: AbortSignal.timeout(this.options.timeoutMs),
    });
    if (!response.ok) {
      throw arborError({
        code: "unavailable",
        rule: UNAVAILABLE_RULE,
        message: `Jev returned ${response.status}`,
        nextAction: UNAVAILABLE_ACTION,
        details: { status: response.status },
      });
    }
    const parsed = parseWireResponse(await response.json());
    if (parsed === undefined) {
      throw arborError({
        code: "unavailable",
        rule: UNAVAILABLE_RULE,
        message: "Jev returned a response this package cannot read",
        nextAction: UNAVAILABLE_ACTION,
      });
    }
    return parsed;
  }

  /** The decision log record, handed to the host for its own journal. */
  private log(request: JudgeRequest, record: DecisionRecord): void {
    this.options.onDecision?.({ decision: request.decision, mode: request.mode, ...record });
  }
}

/** True when an error is a refusal of this package: the judge could not answer. */
export function isJevUnavailable(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { code?: unknown; rule?: unknown };
  return (
    candidate.code === "unavailable" &&
    typeof candidate.rule === "string" &&
    candidate.rule.startsWith("judge.jev.")
  );
}

/** The response body, or undefined when it is not one this package can read. */
function parseWireResponse(json: unknown): WireResponse | undefined {
  if (typeof json !== "object" || json === null) return undefined;
  const answers = (json as { answers?: unknown }).answers;
  if (typeof answers !== "object" || answers === null) return undefined;
  const usage = (json as { usage?: unknown }).usage;
  const tokens =
    typeof usage === "object" && usage !== null
      ? {
          input: numberOr((usage as { input_tokens?: unknown }).input_tokens),
          output: numberOr((usage as { output_tokens?: unknown }).output_tokens),
        }
      : undefined;
  return { answers: answers as WireResponse["answers"], ...(tokens === undefined ? {} : { usage: tokens }) };
}

function numberOr(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
