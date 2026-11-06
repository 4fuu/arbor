/**
 * @4fu/arbor-prompt - typed blocks, the one deterministic renderer and the
 * framework's own text (docs/prompting.md).
 *
 * No component writes prompt text. Everything that reaches a model is a typed
 * block: a kind and its fields. One renderer turns blocks into text when a
 * request is built, by fixed rules, so the same blocks always give the same
 * bytes. A plugin registers kinds of its own and hands the host blocks, never
 * finished text.
 */

export { BUILTIN_BLOCK_KINDS } from "./blocks.ts";
export { changedLines, type LineChange } from "./diff.ts";
export { Renderer, escapeText, type RendererOptions } from "./render.ts";
export {
  DEFAULT_GENERAL_RULES,
  renderPluginSection,
  renderPluginSections,
  renderSystemPrompt,
  sectionRevision,
  type RenderedPluginSection,
  type RenderedSystemPrompt,
  type SystemPromptInput,
} from "./system.ts";
export {
  memoryBlocks,
  noteSortKey,
  renderMemorySnapshot,
} from "./memory.ts";
export {
  boardLineBlock,
  broadcastBlock,
  continuationBlocks,
  continuationHandoffBlock,
  continuationInterruptedBlock,
  continuationRecoveryBlock,
  conversationUpdateBlock,
  dataBlock,
  envItemLine,
  environmentDeltaBlock,
  errorBlock,
  handoffBlock,
  midTaskResetBlock,
  noteBlock,
  noteSummaryBlock,
  noticeBlock,
  outsideMessageBlock,
  promptSectionDeltaBlock,
  reminderBlock,
  renderDelivery,
  taskBlock,
  toolResultBlock,
  windowMessageBlock,
} from "./build.ts";
export { firstInputBlocks, type FirstInputInput } from "./first-input.ts";
export {
  REMINDER_SERIES,
  REMINDER_TIERS,
  atHardLimit,
  hardLimitAt,
  hardLimitReserve,
  nextReminderTier,
  usedPercent,
  type ReminderTier,
} from "./reminder.ts";
export { formatText, textOf, zhTextTable, type TextArgs } from "./text.ts";
export { formatTime } from "./time.ts";
