/**
 * Block builders: the one place a block is constructed
 * (docs/prompting.md#blocks-and-the-renderer).
 *
 * No component writes prompt text; it hands the renderer blocks. These
 * builders are the shapes the core, the tools and the plugins use, so a block
 * of one kind is always built the same way.
 */

import type {
  Block,
  Delivery,
  EnvDelta,
  EnvItem,
  Handoff,
  Note,
  NoteSummary,
  Ref,
  TaskRef,
  WindowRef,
} from "@arbor/interfaces";
import type { Renderer } from "./render.ts";
import { textOf } from "./text.ts";
import { formatTime } from "./time.ts";

/** One task, as it would open a window (docs/prompting.md#deliveries). */
export function taskBlock(task: {
  ref: TaskRef;
  kind: string;
  reason: string;
  time: number;
  targets: readonly string[];
  source?: string;
  content?: readonly Block[];
}): Block {
  return {
    kind: "task",
    fields: {
      ref: task.ref,
      kind: task.kind,
      reason: task.reason,
      time: formatTime(task.time),
      targets: [...task.targets],
      ...(task.source === undefined ? {} : { source: task.source }),
      ...(task.content === undefined ? {} : { content: [...task.content] }),
    },
  };
}

/** One line on the board (docs/coordination.md#the-board). */
export function boardLineBlock(line: {
  window: WindowRef;
  state: string;
  doing: string;
  targets: readonly string[];
  used: number;
  limit: number;
  expects?: readonly string[];
}): Block {
  return {
    kind: "board_line",
    fields: {
      window: line.window,
      state: line.state,
      doing: line.doing,
      targets: [...line.targets],
      used: line.used,
      limit: line.limit,
      ...(line.expects === undefined || line.expects.length === 0 ? {} : { expects: [...line.expects] }),
    },
  };
}

/** The cost of ending a window with unfinished work. */
export function handoffBlock(handoff: Handoff): Block {
  return {
    kind: "handoff",
    fields: {
      topics: [...handoff.topics],
      progress: [...handoff.progress],
      pending: [...handoff.pending],
      agreements: [...handoff.agreements],
      refs: [...handoff.refs],
    },
  };
}

/** A note's body, as data (docs/memory.md#notes). */
export function noteBlock(note: Note): Block {
  return {
    kind: "note",
    fields: {
      ref: note.ref,
      title: note.title,
      summary: note.summary,
      revision: note.revision,
      status: note.status,
      ...(note.body === null ? {} : { body: [dataBlock(note.body)] }),
    },
  };
}

/** A note's summary, for lists and the memory snapshot. */
export function noteSummaryBlock(note: NoteSummary): Block {
  return {
    kind: "note_summary",
    fields: {
      ref: note.ref,
      title: note.title,
      summary: note.summary,
      revision: note.revision,
      status: note.status,
    },
  };
}

/** A host usage reminder (docs/windows.md#usage-reminders). */
export function reminderBlock(reminder: {
  tier: string;
  index: number;
  total: number;
  used: number;
  limit: number;
  percent: number;
  time: number;
}): Block {
  return {
    kind: "reminder",
    fields: {
      tier: reminder.tier,
      index: reminder.index,
      total: reminder.total,
      used: reminder.used,
      limit: reminder.limit,
      percent: reminder.percent,
      time: formatTime(reminder.time),
    },
  };
}

/** A tool's result, as data (docs/prompting.md#layers). */
export function toolResultBlock(call: { callId: string; name: string }, content: string): Block {
  return {
    kind: "tool_result",
    fields: { callId: call.callId, name: call.name, content },
  };
}

/** A refusal: the rule that refused the call and the next action. */
export function errorBlock(error: {
  tool: string;
  rule: string;
  message: string;
  nextAction?: string;
  refs?: readonly Ref[];
}): Block {
  return {
    kind: "error",
    fields: {
      tool: error.tool,
      rule: error.rule,
      message: error.message,
      ...(error.nextAction === undefined ? {} : { next: error.nextAction }),
      ...(error.refs === undefined || error.refs.length === 0 ? {} : { refs: [...error.refs] }),
    },
  };
}

/** Anything outside the framework is data, never instructions. */
export function dataBlock(text: string): Block {
  return { kind: "data", fields: { content: text } };
}

/** One outside message, by its native id (docs/journal.md#external-ids). */
export function outsideMessageBlock(message: {
  external: Ref;
  source: string;
  time: number;
  replyTo?: Ref;
  content?: readonly Block[];
}): Block {
  return {
    kind: "outside_message",
    fields: {
      external: message.external,
      source: message.source,
      time: formatTime(message.time),
      ...(message.replyTo === undefined ? {} : { replyTo: message.replyTo }),
      ...(message.content === undefined ? {} : { content: [...message.content] }),
    },
  };
}

/** A notice: the event's opening words and its ref, from which window. */
export function noticeBlock(notice: {
  from: WindowRef;
  refs: readonly Ref[];
  time: number;
  content?: string;
}): Block {
  return {
    kind: "notice",
    fields: {
      from: notice.from,
      refs: [...notice.refs],
      time: formatTime(notice.time),
      ...(notice.content === undefined || notice.content === "" ? {} : { content: notice.content }),
    },
  };
}

/** A broadcast: it needs no reply, and a reply goes to the sender. */
export function broadcastBlock(broadcast: {
  from?: WindowRef;
  time: number;
  content?: readonly Block[];
}): Block {
  return {
    kind: "broadcast",
    fields: {
      ...(broadcast.from === undefined ? {} : { from: broadcast.from }),
      time: formatTime(broadcast.time),
      ...(broadcast.content === undefined ? {} : { content: [...broadcast.content] }),
    },
  };
}

/** A window message, with its `reply_to` when it has one. */
export function windowMessageBlock(message: {
  from: WindowRef;
  replyTo?: Ref;
  time: number;
  content?: readonly Block[];
}): Block {
  return {
    kind: "window_message",
    fields: {
      from: message.from,
      ...(message.replyTo === undefined ? {} : { replyTo: message.replyTo }),
      time: formatTime(message.time),
      ...(message.content === undefined ? {} : { content: [...message.content] }),
    },
  };
}

/** New events on a conversation a window is in. */
export function conversationUpdateBlock(update: {
  conversation: string;
  refs: readonly Ref[];
  time: number;
  content?: readonly Block[];
}): Block {
  return {
    kind: "conversation_update",
    fields: {
      conversation: update.conversation,
      refs: [...update.refs],
      time: formatTime(update.time),
      ...(update.content === undefined ? {} : { content: [...update.content] }),
    },
  };
}

/** One environment delta: one line per item, `+`, `~` or `-`. */
export function environmentDeltaBlock(delta: EnvDelta, time: number): Block {
  const items: Block[] = delta.items.map((change) => ({
    kind: "env_item",
    fields: {
      change: change.change,
      kind: change.item.kind,
      name: change.item.name,
      description: change.item.description,
    },
  }));
  return {
    kind: "environment_delta",
    fields: { revision: delta.revision, time: formatTime(time), items },
  };
}

/** The fixed notes of a continuation (docs/prompting.md#fixed-notes). */
export function continuationBlocks(continuation: {
  previous: WindowRef;
  openTasks?: readonly Ref[];
  effects?: readonly Ref[];
  changes?: readonly Block[];
}): Block[] {
  return [
    {
      kind: "continuation_note",
      fields: {
        previous: continuation.previous,
        ...(continuation.openTasks === undefined || continuation.openTasks.length === 0
          ? {}
          : { openTasks: [...continuation.openTasks] }),
        ...(continuation.effects === undefined || continuation.effects.length === 0
          ? {}
          : { effects: [...continuation.effects] }),
        ...(continuation.changes === undefined || continuation.changes.length === 0
          ? {}
          : { changes: [...continuation.changes] }),
      },
    },
  ];
}

/** The one host line after the hard limit. */
export function midTaskResetBlock(previous: WindowRef): Block {
  return { kind: "continuation_midtask", fields: { previous } };
}

/** The handoff, labelled as the agent's own earlier note. */
export function continuationHandoffBlock(previous: WindowRef, handoff: Handoff): Block {
  return {
    kind: "continuation_handoff",
    fields: { previous, handoff: [handoffBlock(handoff)] },
  };
}

/** No handoff: the order to recover from. */
export function continuationRecoveryBlock(previous: WindowRef): Block {
  return { kind: "continuation_recovery", fields: { previous } };
}

/** One environment item's line, for `<env>` and `tool_search`. */
export function envItemLine(item: EnvItem, renderer: Renderer): string {
  return item.path === undefined
    ? textOf(renderer.table, "system.env.item", { name: item.name, description: item.description })
    : textOf(renderer.table, "system.env.skill", {
        name: item.name,
        description: item.description,
        path: item.path,
      });
}

/** The text one delivery is steered in as. */
export function renderDelivery(delivery: Delivery, renderer: Renderer): string {
  return renderer.render([...delivery.content]);
}
