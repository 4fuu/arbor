/**
 * The seam between the entry points and the service layer
 * (docs/architecture.md#layers, docs/tools.md#rules).
 *
 * A direct tool and a code mode function are thin wrappers of one service
 * call: same arguments, same behaviour, same errors. The host API calls the
 * same layer. So a group never reaches past these interfaces, and the service
 * layer implements them once.
 */

import type {
  BoardLine,
  CallContext,
  DirectToolSpec,
  Event,
  EventRef,
  Expectation,
  Handoff,
  Journal,
  ModuleSpec,
  Note,
  NoteStore,
  NoteWriteInput,
  Page,
  ParameterSpec,
  Ref,
  SearchHit,
  TextTable,
  ToolCall,
  ToolResult,
  WindowRef,
  Workspace,
  WorkspaceMount,
} from "@arbor/interfaces";

/** One window the host knows about, for `windows.list` and the board. */
export interface LiveWindow {
  window: WindowRef;
  state: string;
  startedAt: number;
  task?: Ref;
  targets: readonly string[];
  doing: string;
  expects: readonly Expectation[];
  usage: { used: number; limit: number; reserve: number };
}

/** One query over the journal, the notes and the board in one call. */
export interface SearchOutcome {
  query: string;
  scope: readonly string[];
  hits: readonly SearchHit[];
  notes: readonly { ref: Ref; title: string; summary: string }[];
  windows: readonly { window: WindowRef; doing: string }[];
  total: number;
  nextCall: string;
}

/** A send, as the host records and queues it. */
export interface SendOutcome {
  event: EventRef;
  /** Events on the conversation the window has not seen yet. */
  behind: number;
}

/** What a group needs from the service layer. Each group takes what it uses. */
export interface ToolServices {
  readonly table: TextTable;
  readonly journal: Journal;
  readonly notes?: NoteStore;
  readonly workspace?: Workspace;

  /** The window's own directory, created on first use. */
  ensureWorkspace(window: WindowRef): Promise<WorkspaceMount | undefined>;

  /** End the run, with a handoff when there is unfinished work. */
  endWindow(window: WindowRef, handoff?: Handoff): Promise<ToolResult>;

  /** True when the window still has work the host can see. */
  hasOpenWork(window: WindowRef): Promise<boolean>;

  /**
   * One note write, with the anchor the host fills in: the window, the event
   * and the evidence. The model never declares an anchor.
   */
  writeNote(window: WindowRef, input: NoteWriteInput): Promise<Note>;

  /** One query over the journal, the notes and the board. */
  search(window: WindowRef, query: string, scope?: readonly string[]): Promise<SearchOutcome>;

  /** One send, through the effect queue. */
  send(
    window: WindowRef,
    request: { to: string; content: string; replyTo?: string; cites?: readonly Ref[] },
  ): Promise<SendOutcome>;

  /** The board. */
  board(): Promise<Page<BoardLine>>;
  setBoardLine(window: WindowRef, doing: string): Promise<void>;
  expect(window: WindowRef, item?: string, description?: string): Promise<Expectation>;
  unexpect(window: WindowRef, ref: Ref): Promise<void>;

  /** The live windows. */
  windows(): Promise<readonly LiveWindow[]>;
  /** A window's transcript, exactly as the model saw it. */
  windowTranscript(window: WindowRef): Promise<readonly Event[]>;
  /** A message to another live window. */
  windowMessage(from: WindowRef, to: WindowRef, text: string, replyTo?: Ref): Promise<EventRef>;
  /** A message to every live window. */
  broadcast(from: WindowRef, text: string): Promise<number>;
  /** What is queued for this window and not inserted yet. */
  inbox(window: WindowRef): Promise<readonly { ref: Ref; from: WindowRef; text: string }[]>;
}

/** The context one call is made in, filled by the service layer. */
export function callContext(
  window: WindowRef,
  options: { task?: string; workspace?: WorkspaceMount; envRevision?: string; call?: EventRef } = {},
): CallContext {
  return {
    window,
    ...(options.task === undefined ? {} : { task: options.task }),
    ...(options.workspace === undefined ? {} : { workspace: options.workspace }),
    ...(options.envRevision === undefined ? {} : { envRevision: options.envRevision }),
    ...(options.call === undefined ? {} : { call: options.call }),
  };
}

/** One refusal, in the core's error shape, as a tool result. */
export function refused(
  rule: string,
  table: TextTable,
  key: string,
  args: Record<string, string | number> = {},
  refs?: readonly Ref[],
): ToolResult {
  return {
    callId: "",
    ok: false,
    content: "",
    error: {
      rule,
      message: messageOf(table, key, args),
      nextAction: nextActionOf(table, key, args),
      ...(refs === undefined || refs.length === 0 ? {} : { refs }),
    },
  };
}

function messageOf(table: TextTable, key: string, args: Record<string, string | number>): string {
  const message = lookup(table, `refused.${key}`, args);
  return message === "" ? key : message;
}

function nextActionOf(table: TextTable, key: string, args: Record<string, string | number>): string | undefined {
  const next = lookup(table, `next.${key}`, args);
  return next === "" ? undefined : next;
}

function lookup(table: TextTable, key: string, args: Record<string, string | number>): string {
  const template = table[key];
  if (template === undefined) return "";
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = args[name];
    return value === undefined ? match : String(value);
  });
}

/** A tool's spec, with its description taken from the table. */
export function toolSpec(
  table: TextTable,
  name: string,
  parameters: Record<string, Omit<ParameterSpec, "description">>,
): DirectToolSpec {
  const described: DirectToolSpec["parameters"] = {};
  for (const [key, parameter] of Object.entries(parameters)) {
    described[key] = { ...parameter, description: lookup(table, `param.${key}`, {}) };
  }
  return { name, description: lookup(table, `tool.${name}`, {}), parameters: described };
}

/** A module's spec, with its description taken from the table. */
export function moduleSpec(
  table: TextTable,
  name: string,
  functions: readonly { name: string; signature: string }[],
): ModuleSpec {
  return {
    name,
    description: lookup(table, `module.${name}`, {}),
    functions: functions.map((fn) => ({
      name: fn.name,
      signature: fn.signature,
      description: lookup(table, `function.${fn.name}`, {}),
    })),
  };
}

/** One call a group did not own. */
export function unknownTool(table: TextTable, call: ToolCall): ToolResult {
  return {
    callId: call.callId,
    ok: false,
    content: "",
    error: {
      rule: "tool.unknown",
      message: messageOf(table, "unknown_tool", { name: call.name }),
    },
  };
}
