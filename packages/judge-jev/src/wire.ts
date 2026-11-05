/**
 * The System One wire protocol, and the question builders on top of it.
 *
 * Jev is TypeSafe AI's System One classifier. One request posts one JSON state
 * and several typed questions about it to `POST {base}/systemone`, with a
 * bearer key, and the response carries one answer per question, each with its
 * score or probability. The protocol has two forms of a bool question: the
 * public one is `bool` with `criteria: { true, false }`, and the wire form -
 * the only one the service accepts - is `noul` with the same criteria and a
 * `noul` probability in the answer. This module holds that mapping, so nothing
 * else in the package knows the wire exists.
 *
 * The question builders follow docs/prompting.md, "Judge questions": the
 * instruction names the state path it judges and does not restate the state,
 * and the criteria describe every outcome. Extra criteria a plugin registered
 * (packages/interfaces/src/judge.ts, `JudgeCriteria`) are appended to every
 * criterion as an owner rule, the way qqnt-gui-driver's Jev wrapper does it:
 * they steer the wording, and never enter the state.
 */

import type {
  BoolQuestion,
  ChoiceQuestion,
  JudgeAnswerValue,
  JudgeQuestion,
  ScoreQuestion,
} from "./options.ts";

/** One question as it goes on the wire. */
export type WireQuestion =
  | { type: "noul"; instructions: string; criteria: { true: string; false: string } }
  | { type: "score"; instructions: string; criteria: readonly string[] }
  | { type: "choice"; instructions: string; criteria: Record<string, string> };

/** One request body, in this package's own question shapes. */
export interface WireRequest {
  model: string;
  state: unknown;
  questions: Record<string, JudgeQuestion>;
}

/** One answer as it comes off the wire. */
export type WireAnswer =
  | { type: "noul"; noul: number }
  | { type: "score"; score: number; confidence?: number }
  | { type: "choice"; choice: string; probabilities?: Record<string, number>; confidence?: number };

/** One response body, read into this package's own shapes. */
export interface WireResponse {
  answers: Record<string, WireAnswer>;
  /** Token usage the service reported, when it did. */
  usage?: { input: number; output: number };
}

/** A bool question, built from both of its outcomes. */
export function boolQuestion(
  instructions: string,
  yes: string,
  no: string,
  criteria: readonly string[] = [],
): BoolQuestion {
  const extra = criteria.map((entry) => `Extra criterion: ${entry}`).join(" ");
  return {
    type: "bool",
    instructions,
    yes: extra.length === 0 ? yes : `${yes} ${extra}`,
    no: extra.length === 0 ? no : `${no} ${extra}`,
  };
}

/** A score question, built from its levels, weakest first. */
export function scoreQuestion(
  instructions: string,
  levels: readonly string[],
  criteria: readonly string[] = [],
): ScoreQuestion {
  const extra = criteria.map((entry) => `Extra criterion: ${entry}`).join(" ");
  if (extra.length === 0) return { type: "score", instructions, levels };
  return {
    type: "score",
    instructions,
    levels: levels.map((level) => `${level} ${extra}`),
  };
}

/** A choice question, built from one criterion per option. */
export function choiceQuestion(
  instructions: string,
  options: Record<string, string>,
  criteria: readonly string[] = [],
): ChoiceQuestion {
  const extra = criteria.map((entry) => `Extra criterion: ${entry}`).join(" ");
  const out: Record<string, string> = {};
  for (const [name, criterion] of Object.entries(options)) {
    out[name] = extra.length === 0 ? criterion : `${criterion} ${extra}`;
  }
  return { type: "choice", instructions, options: out };
}

/** One question as the service reads it. */
export function toWireQuestion(question: JudgeQuestion): WireQuestion {
  switch (question.type) {
    case "bool":
      return {
        type: "noul",
        instructions: question.instructions,
        criteria: { true: question.yes, false: question.no },
      };
    case "score":
      return { type: "score", instructions: question.instructions, criteria: [...question.levels] };
    case "choice":
      return { type: "choice", instructions: question.instructions, criteria: { ...question.options } };
  }
}

/**
 * One answer, read in the question's own terms. A question the service
 * answered with another type is a protocol error: the caller treats the whole
 * decision as unanswered, and the service layer's fallback acts.
 */
export function fromWireAnswer(id: string, question: JudgeQuestion, answer: WireAnswer): JudgeAnswerValue {
  switch (question.type) {
    case "bool":
      if (answer.type !== "noul" || !isNumber(answer.noul)) {
        throw new Error(`Jev answered question ${id} with ${answer.type} instead of a probability`);
      }
      return { type: "bool", probability: answer.noul };
    case "score":
      if (answer.type !== "score" || !isNumber(answer.score)) {
        throw new Error(`Jev answered question ${id} with ${answer.type} instead of a score`);
      }
      return { type: "score", score: answer.score };
    case "choice":
      if (answer.type !== "choice" || typeof answer.choice !== "string") {
        throw new Error(`Jev answered question ${id} with ${answer.type} instead of a choice`);
      }
      return { type: "choice", choice: answer.choice };
  }
}

/** The probability of a bool answer, or undefined when it was not one. */
export function probabilityOf(answer: JudgeAnswerValue | undefined): number | undefined {
  return answer !== undefined && answer.type === "bool" ? answer.probability : undefined;
}

/** The score of a score answer, or undefined when it was not one. */
export function scoreOf(answer: JudgeAnswerValue | undefined): number | undefined {
  return answer !== undefined && answer.type === "score" ? answer.score : undefined;
}

/** The choice of a choice answer, or undefined when it was not one. */
export function choiceOf(answer: JudgeAnswerValue | undefined): string | undefined {
  return answer !== undefined && answer.type === "choice" ? answer.choice : undefined;
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
