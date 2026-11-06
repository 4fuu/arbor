/**
 * The first input: the task, the board lines related to it, and for a
 * continuation the previous window's ref and handoff, plus what changed since
 * the epoch (docs/prompting.md#layers, docs/windows.md#prompt-layout).
 *
 * It is this window's own layer, so it carries the per-input facts a frozen
 * prefix must not: the time, the targets, the numbers.
 */

import type { Block, BoardLine, Handoff, Ref, TaskRef, WindowRef } from "@4fu/arbor-interfaces";
import {
  boardLineBlock,
  continuationBlocks,
  continuationHandoffBlock,
  continuationInterruptedBlock,
  continuationRecoveryBlock,
  handoffBlock,
  midTaskResetBlock,
  taskBlock,
} from "./build.ts";

/** What the first input is built from. */
export interface FirstInputInput {
  task: {
    ref: TaskRef;
    kind: string;
    reason: string;
    time: number;
    targets: readonly string[];
    source?: string;
    content?: readonly Block[];
  };
  /** The live windows related to the task. */
  boardLines?: readonly BoardLine[];
  continuation?: {
    previous: WindowRef;
    handoff?: Handoff;
    /** Set after the hard limit: the window was reset mid-task. */
    midTaskReset?: boolean;
    /**
     * Set when the previous window's run was cut short by a model failure:
     * the steps it had taken stand, and the ones it had sent are not repeated.
     */
    interrupted?: boolean;
    /** The tasks the previous window still had open. */
    openTasks?: readonly Ref[];
    /** The effects the previous window already made. */
    effects?: readonly Ref[];
  };
  /** Notes and environment changes since the snapshot epoch. */
  changes?: readonly Block[];
}

/** The blocks of one window's first input, in the layout's order. */
export function firstInputBlocks(input: FirstInputInput): Block[] {
  const blocks: Block[] = [taskBlock(input.task)];
  for (const line of input.boardLines ?? []) {
    blocks.push(
      boardLineBlock({
        window: line.window,
        state: line.state,
        doing: line.doing,
        targets: line.targets,
        used: line.usage.used,
        limit: line.usage.limit,
        expects: line.expects.map((expectation) => expectation.description ?? expectation.ref),
      }),
    );
  }
  const continuation = input.continuation;
  if (continuation !== undefined) {
    blocks.push(
      ...continuationBlocks({
        previous: continuation.previous,
        ...(continuation.openTasks === undefined ? {} : { openTasks: continuation.openTasks }),
        ...(continuation.effects === undefined ? {} : { effects: continuation.effects }),
        ...(input.changes === undefined ? {} : { changes: input.changes }),
      }),
    );
    if (continuation.midTaskReset === true) blocks.push(midTaskResetBlock(continuation.previous));
    if (continuation.interrupted === true) blocks.push(continuationInterruptedBlock(continuation.previous));
    if (continuation.handoff === undefined) {
      blocks.push(continuationRecoveryBlock(continuation.previous));
    } else {
      blocks.push(continuationHandoffBlock(continuation.previous, continuation.handoff));
    }
  } else {
    blocks.push(...(input.changes ?? []));
  }
  return blocks;
}

/** A handoff's blocks, for a continuation's first input. */
export { handoffBlock };
