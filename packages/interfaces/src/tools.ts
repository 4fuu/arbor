/**
 * The `ToolGroup` interface: a set of direct tools and code mode modules
 * (docs/architecture.md#interfaces, docs/tools.md).
 *
 * Decisions and plain commands are direct tools, declared to the model and
 * called in the turn. Everything else is a module function, called from a
 * script in `code_exec`. Plugins add no tools of their own; what the model can
 * do with a plugin is an MCP server and skills in `/env`.
 */

import type { DirectToolSpec, FunctionSpec, ModuleSpec, ParameterSpec, ToolCall, ToolResult } from "./agent.ts";
import type { EventRef, WindowRef } from "./refs.ts";
import type { WorkspaceMount } from "./workspace.ts";

/** What a call is made in. The service layer fills it; a group never reaches past it. */
export interface CallContext {
  window: WindowRef;
  task?: string;
  /** The window's mounted workspace, when it has one. */
  workspace?: WorkspaceMount;
  /** The environment revision frozen when the window opened. */
  envRevision?: string;
  /** The event this call is recorded at. */
  call?: EventRef;
}

export interface ToolGroup {
  readonly id: string;

  /** The direct tools this group declares to the model. */
  tools(): readonly DirectToolSpec[];

  /** The modules this group contributes, one line each in the prompt. */
  modules(): readonly ModuleSpec[];

  /** Run one call. The same path as a direct tool: same hooks, same errors. */
  call(request: ToolCall, context: CallContext): Promise<ToolResult>;
}

export type { DirectToolSpec, FunctionSpec, ModuleSpec, ParameterSpec, ToolCall, ToolResult };
