/**
 * The `Environment` interface: skills, MCP servers and services - revisions,
 * validation, the shared `/env` mount, deltas (docs/architecture.md#interfaces,
 * docs/environment.md).
 *
 * The model changes the environment itself, with `reload`: copy, edit,
 * validate, replace as a whole, record an environment revision, broadcast the
 * delta. Each item has its own revision, so changes to different items never
 * conflict. Two things are outside the model's reach: the value of a secret,
 * and the built-in skills.
 *
 * The settings are an item like any other, at `/env/settings.json`, so the
 * model changes its own identity, general rules, judge and model tiers the same
 * way it changes a skill.
 */

import type { FunctionSpec } from "./agent.ts";
import type { EnvItemName, EnvItemRef, EnvRef } from "./refs.ts";
import type { Settings } from "./settings.ts";
import type { ArborErrorInfo } from "@arbor/errors";

export type EnvItemKind = "skill" | "mcp" | "service" | "settings";

/** One installed item. */
export interface EnvItem {
  ref: EnvItemRef;
  kind: EnvItemKind;
  name: string;
  /** One line: a name, a description and, for a skill, its path. */
  description: string;
  /** A skill's path under `/env`. */
  path?: string;
  revision: number;
  time: number;
  /** True for the built-in skills, which are read-only. */
  builtin?: boolean;
  /**
   * An MCP server's functions, listed when the server was last validated. A
   * server is a module of its own in code mode, so this is what the catalog
   * declares and what `tool_search` answers (docs/tools.md#modules).
   */
  functions?: readonly FunctionSpec[];
}

/**
 * One draft of an environment item, waiting for `reload`. A window's draft
 * names a path inside that window's workspace; a plugin's draft names a path on
 * the host, beside the plugin's own files.
 */
export interface EnvDraft {
  kind: EnvItemKind;
  name: string;
  /** Where the draft is: in the window's workspace, or a host path for a plugin. */
  path: string;
  /** The revision the draft was copied from; a newer one refuses the install. */
  copiedFrom?: number;
}

export interface EnvValidation {
  ok: boolean;
  /** One entry per draft, so a retry acts only on what did not pass. */
  items: ReadonlyArray<{
    name: string;
    ok: boolean;
    error?: ArborErrorInfo;
  }>;
}

export interface EnvRevision {
  ref: EnvRef;
  previous: EnvRef | null;
  time: number;
  window: string | null;
  changes: ReadonlyArray<{ change: "added" | "changed" | "removed"; item: EnvItem }>;
}

/** What a live window is told changed since it opened. */
export interface EnvDelta {
  revision: EnvRef;
  previous: EnvRef;
  items: ReadonlyArray<{ change: "added" | "changed" | "removed"; item: EnvItem }>;
}

export interface Environment {
  /** The shared mount every window reads `/env` through. */
  readonly mount: string;
  /** The directory the mount is, on the host, which the file tools read. */
  readonly directory: string;

  revision(): Promise<EnvRef>;

  list(): Promise<readonly EnvItem[]>;

  /** An item's revisions, or the environment's when `item` is omitted. */
  history(item?: EnvItemRef | EnvItemName): Promise<readonly EnvRevision[]>;

  /** The settings, from `/env/settings.json`. Undefined until one is installed. */
  settings(): Promise<Settings | undefined>;

  /** Validate drafts: a skill parses, an MCP server starts and lists its functions. */
  validate(drafts: readonly EnvDraft[]): Promise<EnvValidation>;

  /**
   * `reload({ install, remove })`. Replaces each item as a whole, or refuses
   * and changes nothing. One call is one environment revision, so a call that
   * both installs and removes lands as a single delta.
   */
  install(drafts: readonly EnvDraft[], remove?: readonly (EnvItemRef | EnvItemName)[]): Promise<EnvRevision>;

  /** `reload({ remove })`. */
  remove(items: readonly (EnvItemRef | EnvItemName)[]): Promise<EnvRevision>;

  /** What changed since a revision, for a live window's delta. */
  delta(since: EnvRef): Promise<EnvDelta>;

  /** Start every installed service again, after a host restart. */
  resume(): Promise<void>;

  /** Call one function of an installed MCP server, from a script in `code_exec`. */
  call(server: string, fn: string, args: Record<string, unknown>): Promise<string>;
}
