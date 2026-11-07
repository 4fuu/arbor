/**
 * The built-in block kinds (docs/prompting.md#blocks-and-the-renderer).
 *
 * Each kind maps to one shape: its tag, its field order and the fixed lines the
 * renderer writes before its fields, all declared here so rendering stays
 * deterministic and in one place. A plugin registers kinds of its own with the
 * same shape (`BlockKindSpec`).
 *
 * A `time` field carries `formatTime(ms)`, so the one time format lives in one
 * place and the renderer stays a pure function of its blocks.
 */

import type { BlockKindSpec } from "@4fu/arbor-interfaces";

/** The kinds the core defines. Everything a model reads is one of these. */
export const BUILTIN_BLOCK_KINDS: readonly BlockKindSpec[] = [
  {
    kind: "task",
    tag: "task",
    data: true,
    lines: ["task.line", "task.reason", "task.targets", "task.source"],
    fields: [
      { name: "ref", type: "ref" },
      { name: "kind", type: "string" },
      { name: "reason", type: "string" },
      { name: "time", type: "string" },
      { name: "targets", type: "strings" },
      { name: "source", type: "string" },
      { name: "content", type: "blocks" },
    ],
  },
  {
    kind: "board_line",
    tag: "board_line",
    lines: ["board.line", "board.targets", "board.open", "board.usage", "board.expects"],
    fields: [
      { name: "window", type: "ref" },
      { name: "state", type: "string" },
      { name: "doing", type: "string" },
      { name: "targets", type: "strings" },
      { name: "openWork", type: "strings" },
      { name: "used", type: "number" },
      { name: "limit", type: "number" },
      { name: "expects", type: "strings" },
    ],
  },
  {
    kind: "handoff",
    tag: "handoff",
    lines: ["handoff.topics", "handoff.progress", "handoff.pending", "handoff.agreements", "handoff.refs"],
    fields: [
      { name: "topics", type: "strings" },
      { name: "progress", type: "strings" },
      { name: "pending", type: "strings" },
      { name: "agreements", type: "strings" },
      { name: "refs", type: "refs" },
    ],
  },
  {
    kind: "note",
    tag: "note",
    data: true,
    lines: ["note.line", "note.summary", "note.revision", "note.status"],
    fields: [
      { name: "ref", type: "ref" },
      { name: "title", type: "string" },
      { name: "summary", type: "string" },
      { name: "revision", type: "number" },
      { name: "status", type: "string" },
      { name: "body", type: "blocks" },
    ],
  },
  {
    kind: "note_summary",
    tag: "note_summary",
    lines: ["note.line", "note.summary", "note.revision", "note.status"],
    fields: [
      { name: "ref", type: "ref" },
      { name: "title", type: "string" },
      { name: "summary", type: "string" },
      { name: "revision", type: "number" },
      { name: "status", type: "string" },
    ],
  },
  {
    kind: "reminder",
    tag: "reminder",
    lines: ["reminder.head", "reminder.numbers", "reminder.series", "reminder.tier.{tier}", "reminder.open", "reminder.cost.{tier}", "delivery.time"],
    fields: [
      { name: "tier", type: "string" },
      { name: "index", type: "number" },
      { name: "total", type: "number" },
      { name: "used", type: "number" },
      { name: "limit", type: "number" },
      { name: "percent", type: "number" },
      { name: "openWork", type: "strings" },
      { name: "time", type: "string" },
    ],
  },
  {
    kind: "tool_result",
    tag: "tool_result",
    data: true,
    lines: ["tool_result.call", "tool_result.{status}"],
    fields: [
      { name: "callId", type: "string" },
      { name: "name", type: "string" },
      { name: "status", type: "string" },
      { name: "content", type: "string" },
    ],
  },
  {
    kind: "error",
    tag: "error",
    lines: ["error.line", "error.next", "error.refs"],
    fields: [
      { name: "tool", type: "string" },
      { name: "rule", type: "string" },
      { name: "message", type: "string" },
      { name: "next", type: "string" },
      { name: "refs", type: "refs" },
    ],
  },
  {
    kind: "data",
    tag: "data",
    data: true,
    lines: ["data.mark"],
    fields: [{ name: "content", type: "string" }],
  },
  {
    kind: "outside_message",
    tag: "outside_message",
    data: true,
    lines: ["outside_message.line", "outside_message.reply"],
    fields: [
      { name: "external", type: "ref" },
      { name: "source", type: "string" },
      { name: "time", type: "string" },
      { name: "replyTo", type: "ref" },
      { name: "content", type: "blocks" },
    ],
  },
  {
    kind: "notice",
    tag: "notice",
    data: true,
    lines: ["delivery.notice", "delivery.notice.body", "delivery.time"],
    fields: [
      { name: "from", type: "ref" },
      { name: "refs", type: "refs" },
      { name: "time", type: "string" },
      { name: "content", type: "string" },
    ],
  },
  {
    kind: "broadcast",
    tag: "broadcast",
    data: true,
    lines: ["delivery.broadcast", "delivery.time"],
    fields: [
      { name: "from", type: "ref" },
      { name: "time", type: "string" },
      { name: "content", type: "blocks" },
    ],
  },
  {
    kind: "window_message",
    tag: "window_message",
    data: true,
    lines: ["delivery.window_message", "delivery.window_message.reply", "delivery.window_message.ref", "delivery.time"],
    fields: [
      { name: "from", type: "ref" },
      { name: "replyTo", type: "ref" },
      { name: "ref", type: "ref" },
      { name: "time", type: "string" },
      { name: "content", type: "blocks" },
    ],
  },
  {
    kind: "conversation_update",
    tag: "conversation_update",
    data: true,
    lines: ["delivery.conversation_update", "delivery.time"],
    fields: [
      { name: "conversation", type: "string" },
      { name: "refs", type: "refs" },
      { name: "time", type: "string" },
      { name: "content", type: "blocks" },
    ],
  },
  {
    kind: "environment_delta",
    tag: "environment_delta",
    lines: ["delivery.environment_delta", "delivery.time"],
    fields: [
      { name: "revision", type: "ref" },
      { name: "time", type: "string" },
      { name: "items", type: "blocks" },
    ],
  },
  {
    kind: "env_item",
    lines: ["delivery.delta.item"],
    fields: [
      { name: "change", type: "string" },
      { name: "kind", type: "string" },
      { name: "name", type: "string" },
      { name: "description", type: "string" },
    ],
  },
  {
    kind: "plugin_section",
    data: true,
    lines: ["system.plugin.outside"],
    fields: [{ name: "content", type: "blocks" }],
  },
  {
    kind: "prompt_delta",
    tag: "prompt_delta",
    lines: ["delivery.prompt_delta", "delivery.time"],
    fields: [
      { name: "time", type: "string" },
      { name: "items", type: "blocks" },
    ],
  },
  {
    kind: "tools_delta",
    tag: "tools_delta",
    lines: ["delivery.tools_delta", "delivery.time"],
    fields: [
      { name: "time", type: "string" },
      { name: "items", type: "blocks" },
    ],
  },
  {
    kind: "tool_change",
    lines: ["delivery.tool_change"],
    fields: [
      { name: "change", type: "string" },
      { name: "name", type: "string" },
      { name: "source", type: "string" },
    ],
  },
  {
    kind: "prompt_section",
    // The tag is the plugin's own choice, so it rides on the block
    // (docs/prompting.md#plugin-sections-that-change).
    tagField: "tag",
    fields: [
      { name: "tag", type: "string", tag: true },
      { name: "items", type: "blocks" },
    ],
  },
  {
    kind: "prompt_line",
    lines: ["delivery.prompt_line"],
    fields: [
      { name: "change", type: "string" },
      { name: "line", type: "string" },
    ],
  },
  {
    kind: "continuation_note",
    tag: "continuation_note",
    lines: ["continuation.previous", "continuation.tasks", "continuation.effects"],
    fields: [
      { name: "previous", type: "ref" },
      { name: "openTasks", type: "refs" },
      { name: "effects", type: "refs" },
      { name: "changes", type: "blocks" },
    ],
  },
  {
    kind: "continuation_midtask",
    tag: "continuation_midtask",
    lines: ["continuation.midtask"],
    fields: [{ name: "previous", type: "ref" }],
  },
  {
    kind: "continuation_handoff",
    tag: "continuation_handoff",
    lines: ["continuation.handoff"],
    fields: [{ name: "previous", type: "ref" }, { name: "handoff", type: "blocks" }],
  },
  {
    kind: "continuation_recovery",
    tag: "continuation_recovery",
    lines: ["continuation.handoff.none"],
    fields: [{ name: "previous", type: "ref" }],
  },
  {
    kind: "continuation_interrupted",
    tag: "continuation_interrupted",
    lines: ["continuation.interrupted"],
    fields: [{ name: "previous", type: "ref" }],
  },
];
