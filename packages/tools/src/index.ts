/**
 * @4fu/arbor-tools - the entry points: direct tools, code mode modules and the one
 * catalog that routes both through the service layer (docs/tools.md).
 *
 * Decisions and plain commands are direct tools, declared to the model and
 * called in the turn. Everything else is a module function, called from a script
 * in `code_exec`. There is no CLI, and there is no second path around the
 * service layer.
 */

export { ToolCatalog, type ToolCatalogOptions } from "./catalog.ts";
export {
  SCRIPT_TIMEOUT_MS,
  directToolIn,
  runScript,
  type CodeExecContext,
  type ScriptCatalog,
} from "./code-exec.ts";
export { RESULT_LIMIT, boundResult, boundText, nextCall, type Bound } from "./bound.ts";
export { WORKSPACE_ENV, childEnvironment, type ChildEnvInput } from "./child-env.ts";
export {
  callContext,
  moduleSpec,
  refused,
  toolSpec,
  type EnvCatalog,
  type LiveWindow,
  type ReloadOutcome,
  type SearchOutcome,
  type SendOutcome,
  type TaskRecord,
  type TaskSummary,
  type ToolServices,
} from "./host.ts";
export { CoreToolGroup, handoffOf } from "./groups/core.ts";
export { bashEnvironment } from "./groups/files.ts";
export { EnvToolGroup } from "./groups/env.ts";
export { NoteToolGroup } from "./groups/notes.ts";
export { FileToolGroup } from "./groups/files.ts";
export {
  BoardModuleGroup,
  ChannelsModuleGroup,
  JournalModuleGroup,
  NotesModuleGroup,
  ScheduleModuleGroup,
  TasksModuleGroup,
  WindowsModuleGroup,
  WorkspaceModuleGroup,
} from "./modules/modules.ts";
