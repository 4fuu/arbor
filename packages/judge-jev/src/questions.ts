/**
 * The six decisions of docs/dispatch.md#judge-decisions, as Jev questions.
 *
 * Each decision is one request with its questions batched: one bool question
 * for `filter`, one score question per candidate window plus one for a new
 * window for `route`, one choice question for `model tier`, one bool question
 * per candidate window for `notice` and `broadcast`, and one score question
 * per note for `active set`. When items fail separately there is one question
 * per item - a window that does not need a notice is named, not averaged away
 * (docs/prompting.md, "Batching").
 *
 * Every question follows docs/prompting.md, "Judge questions": the instruction
 * names the state path it judges and the point of view and does not restate the
 * state; the criteria describe both outcomes positively, with which evidence
 * comes first, the boundary cases and a tie-break; counts, shares and time gaps
 * are computed in code and appear as labelled facts, so Jev is asked for no
 * arithmetic; and every state carries a `state_note` that defines each field.
 * Questions are in English; the state keeps the original text as it is.
 *
 * The tie-break of every question leans toward the less harmful action, which
 * is that decision's own documented fallback (docs/dispatch.md#judge-decisions):
 * `filter` passes, `notice` stays silent, `broadcast` delivers, and `active set`
 * leaves the rule score alone.
 */

import type {
  ActiveSetAnswer,
  ActiveSetState,
  Block,
  BlockValue,
  BroadcastAnswer,
  BroadcastState,
  CandidateWindow,
  FilterAnswer,
  FilterState,
  JudgeTask,
  ModelTierAnswer,
  ModelTierState,
  NoticeAnswer,
  NoticeState,
  NoteRef,
  RouteAnswer,
  RouteScore,
  RouteState,
  WindowRef,
} from "@arbor/interfaces";

import {
  CANDIDATES_TOKENS,
  CONTENT_TOKENS,
  MAX_EXPECTS,
  MAX_LAST_INPUTS,
  MAX_TASKS,
  fit,
  fitNewest,
  jsonCost,
  newest,
  truncate,
} from "./bounds.ts";
import type { JudgeAnswerValue, JudgeQuestion } from "./options.ts";
import { boolQuestion, choiceOf, choiceQuestion, probabilityOf, scoreOf, scoreQuestion } from "./wire.ts";

/** One decision, ready to send: its state, its questions and the items they judge. */
export interface PreparedDecision {
  state: Record<string, unknown>;
  questions: Record<string, JudgeQuestion>;
  /** The items the questions were asked about, in the order they were asked. */
  items: readonly string[];
}

// --- shared state builders ---------------------------------------------------

/** A task as the judge reads it: its reason, its targets and its content as data. */
function taskState(task: JudgeTask): Record<string, unknown> {
  const content = task.content.map(blockData);
  const kept = fitNewest(content, jsonCost, CONTENT_TOKENS);
  return {
    ref: task.ref,
    kind: task.kind,
    reason: truncate(task.reason),
    targets: task.targets,
    time: task.time,
    content: kept.kept,
    dropped_content: kept.dropped,
  };
}

/**
 * One input block as data: its kind and its fields. The judge is a classifier
 * reading data, not a renderer, so a block is handed over in the shape the host
 * holds it in - no component writes prompt text (docs/prompting.md).
 */
function blockData(block: Block): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(block.fields)) {
    fields[name] = blockValue(value);
  }
  return { kind: block.kind, fields };
}

function blockValue(value: BlockValue): unknown {
  if (typeof value === "string") return truncate(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  return value.map((entry) => (typeof entry === "string" ? entry : blockData(entry)));
}

/** One candidate window's profile, as the host assembled it (docs/dispatch.md). */
function windowState(window: CandidateWindow): Record<string, unknown> {
  const expects = newest(window.expects, MAX_EXPECTS);
  const tasks = newest(window.tasks, MAX_TASKS);
  const inputs = newest(window.lastInputs, MAX_LAST_INPUTS);
  const share = window.usage.limit > 0 ? window.usage.used / window.usage.limit : 0;
  return {
    window: window.window,
    doing: truncate(window.doing),
    targets: window.targets,
    expects: expects.kept.map((entry) => truncate(entry)),
    dropped_expects: expects.dropped,
    state: window.state,
    usage: {
      used: window.usage.used,
      limit: window.usage.limit,
      share: Math.round(share * 100) / 100,
    },
    final_reminder_sent: window.finalReminderSent,
    tasks: tasks.kept.map((entry) => truncate(entry)),
    dropped_tasks: tasks.dropped,
    last_inputs: inputs.kept.map((entry) => ({ ref: entry.ref, summary: truncate(entry.summary) })),
    dropped_last_inputs: inputs.dropped,
  };
}

/**
 * The candidates one decision asks about. The host's order is its own ranking,
 * so the leading ones are kept and the rest are reported as dropped; the whole
 * set is then bounded by the token budget, which keeps a state that ignored the
 * item bound inside Jev's context window.
 */
function candidatesState(
  candidates: readonly CandidateWindow[],
  maxItems: number,
): { windows: Record<string, unknown>[]; dropped: number } {
  const leading = candidates.slice(0, maxItems).map(windowState);
  const kept = fit(leading, jsonCost, CANDIDATES_TOKENS);
  return { windows: kept.kept, dropped: candidates.length - kept.kept.length };
}

/** A score answer's level, normalized to 0..1 over the question's own levels. */
function levelOf(answers: Readonly<Record<string, JudgeAnswerValue>>, id: string, levels: number): number {
  const score = scoreOf(answers[id]);
  if (score === undefined || levels <= 1) return 0;
  return Math.min(1, Math.max(0, score / (levels - 1)));
}

/** Rounded to two decimals, so a logged score never carries float noise. */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

// --- 1. filter ---------------------------------------------------------------

const FILTER_INSTRUCTION = "Does the batch in `task.content` need handling by an agent window at all?";

const FILTER_YES =
  "The batch asks for something, reports something that needs a decision or an action, or changes a target a window is working on, so an agent has to look at it - even when looking at it ends in nothing being done.";

const FILTER_NO =
  "The batch needs no agent: it repeats something already handled, it is an automated heartbeat or a status line with nothing in it, or its only effect has already been applied by the host. When unsure, answer yes: a batch that is looked at and found empty costs one window turn, and a batch that is dropped is never seen again.";

/** `filter`: one bool question over the whole batch. */
export function prepareFilter(state: FilterState, criteria: readonly string[]): PreparedDecision {
  return {
    state: {
      task: taskState(state.task),
      explicit: state.explicit,
      state_note:
        "`task`: the batch being decided - `ref`, `kind` (batch, scheduled or service), `reason` (why the host made it), `targets`, `time`, and `content`, its input blocks as data in order, each a `kind` with its `fields`; `dropped_content` is how many older blocks were left out so the request fits. `explicit`: the batch names the agent directly, which the host always handles.",
    },
    questions: { filter: boolQuestion(FILTER_INSTRUCTION, FILTER_YES, FILTER_NO, criteria) },
    items: ["filter"],
  };
}

/**
 * `filter`'s answer. A question that was not answered at all is this decision's
 * own fallback: the batch passes (docs/dispatch.md#judge-decisions). The
 * probability rides along, because the threshold that turns it into a yes is the
 * service layer's own.
 */
export function filterAnswer(
  answers: Readonly<Record<string, JudgeAnswerValue>>,
  threshold: number,
): FilterAnswer {
  const probability = probabilityOf(answers.filter);
  return {
    decision: "filter",
    needsHandling: probability === undefined ? true : probability >= threshold,
    ...(probability === undefined ? {} : { score: probability }),
  };
}

// --- 2. route ----------------------------------------------------------------

/** `route[i]` judges `candidates[i]`; `route[new]` judges opening a window. */
function routeQuestionId(index: number): string {
  return `route[${index}]`;
}

const ROUTE_NEW_ID = "route[new]";

const ROUTE_INSTRUCTION = (index: number): string =>
  `How well does the window in \`candidates[${index}]\` fit taking the task in \`task\` now?`;

const ROUTE_NEW_INSTRUCTION =
  "How well does opening a new window for the task in `task` fit, against the live windows in `candidates`?";

const ROUTE_LEVELS = [
  "Poor fit: the window is on other work, and taking this task would pull it off what it is doing.",
  "Weak fit: the window shares a target with the task, or worked recently, but nothing ties it to this batch.",
  "Good fit: the window is working on one of the task's targets, or expects something this task answers.",
  "Strong fit: the window is waiting for exactly this - its expectation or its last input is this task's subject - and taking it keeps one piece of work in one window. When two windows fit equally well, take the one that touched the task's targets most recently; when a window and a new window fit equally, take the window, because opening one pays for a fresh prefix.",
];

/** `route`: one score question per candidate, and one for a new window. */
export function prepareRoute(state: RouteState, maxItems: number, criteria: readonly string[]): PreparedDecision {
  const candidates = candidatesState(state.candidates, maxItems);
  const questions: Record<string, JudgeQuestion> = {};
  const items: string[] = [];
  candidates.windows.forEach((window, index) => {
    questions[routeQuestionId(index)] = scoreQuestion(ROUTE_INSTRUCTION(index), ROUTE_LEVELS, criteria);
    items.push(String(window.window));
  });
  questions[ROUTE_NEW_ID] = scoreQuestion(ROUTE_NEW_INSTRUCTION, ROUTE_LEVELS, criteria);
  items.push("new");
  return {
    state: {
      task: taskState(state.task),
      candidates: candidates.windows,
      window_count: state.candidates.length,
      dropped_candidates: candidates.dropped,
      state_note:
        "`task`: the task being routed, as `filter`'s state describes it. `candidates[i]`: one live window that could take it - `window` (its ref), `doing` (its board line), `targets`, `expects` (what it expects to be routed to it), `state` (running or idle), `usage` (`used` and `limit` tokens, and `share`, the fraction of the limit used), `final_reminder_sent`, `tasks` (the tasks it has taken, newest first) and `last_inputs` (its last inputs by ref and opening words); each `dropped_*` is how many older items of that list were left out. `window_count` is how many candidates the host passed, and `dropped_candidates` how many were left out of this request.",
    },
    questions,
    items,
  };
}

/**
 * `route`'s answer: every item's score, and the best of them. The best is the
 * highest score among the items the request asked about; a tie keeps the
 * earlier item, and a live window beats a new one, because opening one pays for
 * a fresh prefix. A candidate the request could not ask about is scored 0 and is
 * never the best, so a bounded request cannot be decided by what it left out.
 * Whether the best is good enough to take the task is the host's own threshold
 * (docs/dispatch.md#routing).
 */
export function routeAnswer(
  answers: Readonly<Record<string, JudgeAnswerValue>>,
  asked: readonly string[],
  candidates: readonly CandidateWindow[],
): RouteAnswer {
  const askedSet = new Set(asked);
  const scoreOfItem = (item: WindowRef | "new"): number => {
    const index = asked.indexOf(item);
    if (index < 0) return 0;
    const id = item === "new" ? ROUTE_NEW_ID : routeQuestionId(index);
    return round2(scoreOf(answers[id]) ?? 0);
  };
  const scores: RouteScore[] = candidates.map((candidate) => ({
    item: candidate.window,
    score: scoreOfItem(candidate.window),
  }));
  scores.push({ item: "new", score: scoreOfItem("new") });
  let best: WindowRef | "new" = "new";
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const entry of scores) {
    if (!askedSet.has(entry.item)) continue;
    if (entry.score < bestScore) continue;
    // A tie keeps the earlier item, except that a live window always beats a new one.
    if (entry.score === bestScore && best !== "new") continue;
    best = entry.item;
    bestScore = entry.score;
  }
  return { decision: "route", scores, best };
}

// --- 3. model tier -----------------------------------------------------------

const MODEL_TIER_INSTRUCTION = "Which tier of model does a new window opened for the task in `task` need?";

/** `model tier`: one choice question over the configured tiers. */
export function prepareModelTier(
  state: ModelTierState,
  criteria: readonly string[],
  tierCriteria: Record<string, string>,
): PreparedDecision {
  const options: Record<string, string> = {};
  // What the host's settings say each tier is for comes first, over this
  // package's own description of the tiers it knows
  // (docs/dispatch.md#model-tiers).
  const described = { ...tierCriteria, ...(state.criteria ?? {}) };
  for (const tier of state.tiers) {
    options[tier] = described[tier] ?? "The task fits this tier's own model better than any other tier's.";
  }
  return {
    state: {
      task: taskState(state.task),
      tiers: [...state.tiers],
      state_note:
        "`task`: the task a new window would open for, as `filter`'s state describes it. `tiers`: the model tiers this host has configured, in the order settings lists them; the answer names one of them, and each option's own criterion says what that tier is for.",
    },
    questions: state.tiers.length === 0 ? {} : { model_tier: choiceQuestion(MODEL_TIER_INSTRUCTION, options, criteria) },
    items: [...state.tiers],
  };
}

/**
 * `model tier`'s answer. A choice outside the configured tiers, or no answer at
 * all, falls back to the first configured tier: only configured tiers are
 * offered, and the host's own default tier is the rule default
 * (docs/dispatch.md#judge-decisions).
 */
export function modelTierAnswer(
  answers: Readonly<Record<string, JudgeAnswerValue>>,
  tiers: readonly string[],
): ModelTierAnswer {
  const choice = choiceOf(answers.model_tier);
  const tier = choice !== undefined && tiers.includes(choice) ? choice : (tiers[0] ?? "");
  return { decision: "model_tier", tier };
}

// --- 4. notice ---------------------------------------------------------------

function noticeQuestionId(index: number): string {
  return `notice[${index}]`;
}

const NOTICE_INSTRUCTION = (index: number): string =>
  `Does the window in \`candidates[${index}]\` need to know about the event in \`event\`?`;

const NOTICE_YES =
  "The event changes something the window is working on, answers something it expects, or touches a target it worked on recently, so a window that never hears about it would keep acting on facts that are no longer true.";

const NOTICE_NO =
  "The event is on a target the window only touched long ago, or is unrelated to its work, so telling it adds a block it does not need. When unsure, answer no: a window can look the event up in the journal, and a notice it did not need costs it context.";

/** `notice`: one bool question per window that touched the event's target. */
export function prepareNotice(state: NoticeState, maxItems: number, criteria: readonly string[]): PreparedDecision {
  const candidates = candidatesState(state.candidates, maxItems);
  const questions: Record<string, JudgeQuestion> = {};
  candidates.windows.forEach((_window, index) => {
    questions[noticeQuestionId(index)] = boolQuestion(NOTICE_INSTRUCTION(index), NOTICE_YES, NOTICE_NO, criteria);
  });
  return {
    state: {
      event: {
        ref: state.event.ref,
        kind: state.event.kind,
        target: state.event.target,
        summary: truncate(state.event.summary),
      },
      candidates: candidates.windows,
      window_count: state.candidates.length,
      dropped_candidates: candidates.dropped,
      state_note:
        "`event`: the new event - `ref`, `kind`, `target` and `summary` (its opening words). `candidates[i]`: one live window that touched the event's target, as `route`'s state describes it. `window_count` is how many candidates the host passed, and `dropped_candidates` how many were left out of this request.",
    },
    questions,
    items: candidates.windows.map((window) => String(window.window)),
  };
}

/**
 * `notice`'s answer: one decision per window the host passed. A window the
 * request could not ask about, or one whose question was not answered, needs no
 * notice, which is this decision's own fallback. The probability rides along for
 * the service layer's own threshold.
 */
export function noticeAnswer(
  answers: Readonly<Record<string, JudgeAnswerValue>>,
  state: NoticeState,
  asked: readonly string[],
  threshold: number,
): NoticeAnswer {
  return {
    decision: "notice",
    windows: state.candidates.map((candidate) => {
      const index = asked.indexOf(candidate.window);
      const probability = index < 0 ? undefined : probabilityOf(answers[noticeQuestionId(index)]);
      return {
        window: candidate.window,
        needs: probability !== undefined && probability >= threshold,
        ...(probability === undefined ? {} : { score: probability }),
      };
    }),
  };
}

// --- 5. broadcast ------------------------------------------------------------

function broadcastQuestionId(index: number): string {
  return `broadcast[${index}]`;
}

const BROADCAST_INSTRUCTION = (index: number): string =>
  `Does the window in \`candidates[${index}]\` need the broadcast in \`broadcast\`?`;

const BROADCAST_YES =
  "The broadcast changes how the window should work - a rule it follows, a fact it relies on, or the state of something it is using - so a window that misses it keeps doing the wrong thing.";

const BROADCAST_NO =
  "The broadcast is about another domain, or repeats what the window already has, so delivering it only adds a block. When unsure, answer no: a broadcast needs no reply, and a window can look it up by its ref.";

/** `broadcast`: one bool question per live window. */
export function prepareBroadcast(
  state: BroadcastState,
  maxItems: number,
  criteria: readonly string[],
): PreparedDecision {
  const candidates = candidatesState(state.candidates, maxItems);
  const questions: Record<string, JudgeQuestion> = {};
  candidates.windows.forEach((_window, index) => {
    questions[broadcastQuestionId(index)] = boolQuestion(
      BROADCAST_INSTRUCTION(index),
      BROADCAST_YES,
      BROADCAST_NO,
      criteria,
    );
  });
  return {
    state: {
      broadcast: {
        from: state.broadcast.from,
        summary: truncate(state.broadcast.summary),
        refs: state.broadcast.refs,
      },
      unfiltered: state.unfiltered === true,
      candidates: candidates.windows,
      window_count: state.candidates.length,
      dropped_candidates: candidates.dropped,
      state_note:
        "`broadcast`: what is being delivered to every live window - `from` (the window that sent it, or null), `summary` and `refs`. `unfiltered`: the broadcast is an environment delta, which the host never filters. `candidates[i]`: one live window, as `route`'s state describes it. `window_count` is how many candidates the host passed, and `dropped_candidates` how many were left out of this request.",
    },
    questions,
    items: candidates.windows.map((window) => String(window.window)),
  };
}

/**
 * `broadcast`'s answer. A window the request could not ask about, or one whose
 * question was not answered, needs the broadcast, which is this decision's own
 * fallback: a delivery is never the harmful action
 * (docs/dispatch.md#judge-decisions). The probability rides along for the
 * service layer's own threshold.
 */
export function broadcastAnswer(
  answers: Readonly<Record<string, JudgeAnswerValue>>,
  state: BroadcastState,
  asked: readonly string[],
  threshold: number,
): BroadcastAnswer {
  return {
    decision: "broadcast",
    windows: state.candidates.map((candidate) => {
      const index = asked.indexOf(candidate.window);
      const probability = index < 0 ? undefined : probabilityOf(answers[broadcastQuestionId(index)]);
      return {
        window: candidate.window,
        needs: probability === undefined || probability >= threshold,
        ...(probability === undefined ? {} : { score: probability }),
      };
    }),
  };
}

// --- 6. active set -----------------------------------------------------------

function activeSetQuestionId(index: number): string {
  return `active_set[${index}]`;
}

const ACTIVE_SET_INSTRUCTION = (index: number): string =>
  `How likely is it that the knowledge in \`notes[${index}]\` is still needed by the windows that open next?`;

const ACTIVE_SET_LEVELS = [
  "The note is about a finished topic, a one-off detail, or something the work has moved past: it is unlikely to be needed again.",
  "The note is background that could still come up, but nothing points at it now: it may or may not be needed.",
  "The note is about work happening now, or a standing fact the work keeps coming back to: it will very likely be needed again.",
];

/**
 * `active set`: one score question per candidate note. The host's own order is
 * not a ranking, so the candidates are ordered here by rule score, strongest
 * first and ties by ref, which is the order the pick uses anyway; a note the
 * request cannot ask about is left to the rule score alone.
 */
export function prepareActiveSet(
  state: ActiveSetState,
  maxItems: number,
  criteria: readonly string[],
): PreparedDecision {
  const ordered = [...state.notes].sort(
    (left, right) => right.score - left.score || (left.ref < right.ref ? -1 : left.ref > right.ref ? 1 : 0),
  );
  const leading = ordered.slice(0, maxItems).map((note) => ({
    ref: note.ref,
    summary: truncate(note.summary),
    score: round2(note.score),
  }));
  const kept = fit(leading, jsonCost, CANDIDATES_TOKENS);
  const questions: Record<string, JudgeQuestion> = {};
  kept.kept.forEach((_note, index) => {
    questions[activeSetQuestionId(index)] = scoreQuestion(
      ACTIVE_SET_INSTRUCTION(index),
      ACTIVE_SET_LEVELS,
      criteria,
    );
  });
  return {
    state: {
      notes: kept.kept,
      budget: { count: state.budget.count, tokens: state.budget.tokens },
      judge_share: state.judgeShare,
      note_count: state.notes.length,
      dropped_notes: state.notes.length - kept.kept.length,
      state_note:
        "`notes[i]`: one candidate note for the next windows' active set - `ref`, `summary`, and `score`, the rule score the host computed from how much the windows used it. `budget`: how many notes and how many tokens the active set may hold. `judge_share`: the bounded share the judge may add, which never outweighs the rule score. `note_count` is how many candidates the host passed, and `dropped_notes` how many were left out of this request.",
    },
    questions,
    items: kept.kept.map((note) => String(note.ref)),
  };
}

/**
 * `active set`'s answer: which notes are still needed, strongest first, and
 * which are not. The judge's share is bounded by the host
 * (docs/memory.md#the-active-set), so this is the judge's own reading and never
 * the set itself. A note the request could not ask about, or one whose question
 * was not answered, is left to the rule score alone, which is this decision's
 * own fallback. Every note's level rides along, for the service layer's own
 * threshold.
 */
export function activeSetAnswer(
  answers: Readonly<Record<string, JudgeAnswerValue>>,
  state: ActiveSetState,
  asked: readonly string[],
  threshold: number,
): ActiveSetAnswer {
  const ranked = state.notes
    .map((note) => {
      const index = asked.indexOf(note.ref);
      const level = index < 0 ? 0 : levelOf(answers, activeSetQuestionId(index), ACTIVE_SET_LEVELS.length);
      return { note, level };
    })
    .sort((left, right) => right.level - left.level || (left.note.ref < right.note.ref ? -1 : 1));
  const keep: NoteRef[] = [];
  const drop: NoteRef[] = [];
  const scores: { ref: NoteRef; score: number }[] = [];
  for (const entry of ranked) {
    if (entry.level >= threshold) keep.push(entry.note.ref);
    else drop.push(entry.note.ref);
    scores.push({ ref: entry.note.ref, score: entry.level });
  }
  return { decision: "active_set", keep, drop, scores };
}
