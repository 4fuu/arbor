/**
 * @4fu/arbor-interfaces - every replaceable interface, and the core's own shapes.
 *
 * No pi type or SQL row crosses an interface; the core only sees
 * its own shapes (docs/architecture.md#interfaces). Each interface ships with
 * a default; replacing a module means implementing its interface and
 * registering it, and nothing else changes.
 */

export type {
  EventRef,
  WindowRef,
  NoteId,
  NoteRef,
  TaskRef,
  MessageRef,
  WorkspaceRef,
  EnvRef,
  EnvItemRef,
  EnvItemName,
  BlobRef,
  ExternalRef,
  Ref,
  Target,
  EventKind,
  LinkKind,
  MatchKind,
} from "./refs.ts";

export type {
  BlockValue,
  Block,
  BlockKind,
  BlockFieldSpec,
  BlockKindSpec,
  TextTable,
} from "./blocks.ts";

/** Page bounds every read reports (docs/prompting.md). */
export { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT } from "./refs.ts";

export type {
  EventInput,
  Link,
  LinkInput,
  Redaction,
  Event,
  ListOptions,
  Page,
  EventPage,
  AroundOptions,
  SearchOptions,
  SearchHit,
  SearchPage,
  LinksOptions,
  RelatedItem,
  LinkPage,
  TraceOptions,
  TraceNode,
  TargetGap,
  JournalError,
} from "./events.ts";

export type {
  BlobInput,
  BlobContent,
  BlobInfo,
  BlobStore,
  Segmenter,
  Journal,
} from "./journal.ts";

export type {
  ModelInfo,
  LoginState,
  LoginRequest,
  LoginResult,
  RenderedPrompt,
  OpenWindowRequest,
  WindowLimits,
  ContinuationInfo,
  Delivery,
  WindowSession,
  StreamEvent,
  WindowEvent,
  WindowEndReason,
  WindowOutcome,
  AgentBackend,
  DirectToolSpec,
  ModuleSpec,
  FunctionSpec,
  ParameterSpec,
  ToolCall,
  ToolResult,
} from "./agent.ts";

export type {
  WindowState,
  WindowRuntimeState,
  TokenUsage,
  Handoff,
  BoardLine,
  Expectation,
  InputBlock,
} from "./windows.ts";

export type {
  NoteStatus,
  Anchor,
  NoteWriteInput,
  Note,
  NoteSummary,
  NoteBody,
  NoteRevision,
  NoteContext,
  NoteQuery,
  NoteConflictInfo,
  ActiveSetBudget,
  ActiveCandidate,
  NoteUseKind,
  NoteUseInput,
  SnapshotOptions,
  NotesSnapshot,
  NoteDelta,
  NoteDeltaItem,
  NoteStore,
} from "./notes.ts";

export type {
  ExecResult,
  StagedFile,
  WorkspaceCheckout,
  WorkspaceKeep,
  WorkspaceMount,
  WorkspaceQuota,
  Workspace,
} from "./workspace.ts";

export type {
  JudgeMode,
  JudgeDecisionKind,
  CandidateWindow,
  JudgeTask,
  FilterState,
  RouteState,
  ModelTierState,
  NoticeState,
  BroadcastState,
  ActiveSetState,
  FilterRequest,
  RouteRequest,
  ModelTierRequest,
  NoticeRequest,
  BroadcastRequest,
  ActiveSetRequest,
  JudgeRequest,
  FilterAnswer,
  RouteScore,
  RouteAnswer,
  ModelTierAnswer,
  WindowDecision,
  NoticeAnswer,
  BroadcastAnswer,
  ActiveSetAnswer,
  JudgeAnswer,
  Judge,
  JudgeCriteria,
} from "./judge.ts";

export type {
  OutsideEvent,
  OutsideMessage,
  ChannelConnection,
  SendRequest,
  SendResult,
  Unsubscribe,
  Channel,
} from "./channel.ts";

export type { TaskKind, TaskInput, Task, TaskSource } from "./task.ts";

export type { EffectKind, Effect, EffectResult, EffectExecutor } from "./effects.ts";

export type { CallContext, ToolGroup, ExternalTool } from "./tools.ts";

export type {
  EnvItemKind,
  EnvItem,
  EnvDraft,
  EnvValidation,
  EnvRevision,
  EnvDelta,
  Environment,
} from "./environment.ts";

export type {
  ServiceState,
  ServiceSpec,
  ServiceHandle,
  ServiceStatus,
  LogOptions,
  LogPage,
  Supervisor,
} from "./supervisor.ts";

export type {
  QueuedInput,
  InsertionRequest,
  InsertionPlan,
  RateLimitState,
  AdmissionRequest,
  AdmissionPlan,
  SkipPeriod,
  DailyRepeat,
  EveryRepeat,
  RepeatBounds,
  RepeatRule,
  WeeklyRepeat,
  ScheduledTaskInput,
  ScheduledTask,
  ScheduledTaskUpdate,
  Scheduler,
} from "./scheduler.ts";

export type {
  AfterHookOutcome,
  HookOutcome,
  AppendContext,
  DispatchContext,
  JudgeContext,
  WindowStartContext,
  WindowEndContext,
  WindowContinueContext,
  ModelRequestContext,
  DeliveryContext,
  WindowStreamContext,
  ToolCallContext,
  EffectOutcome,
  EffectHold,
  EffectContext,
  NoteWriteContext,
  ReloadContext,
  ServiceStateContext,
  Hooks,
  HeldEffect,
} from "./hooks.ts";

export type {
  PluginAdapters,
  PromptSection,
  Plugin,
} from "./plugin.ts";

export type { Settings } from "./settings.ts";
