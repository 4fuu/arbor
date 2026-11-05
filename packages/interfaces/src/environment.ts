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
 */

import type { EnvItemRef, EnvRef } from "./refs.ts";
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
}

/** A draft in a workspace, waiting for `reload`. */
export interface EnvDraft {
  kind: EnvItemKind;
  name: string;
  /** Where the draft is, in the window's workspace. */
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

  revision(): Promise<EnvRef>;

  list(): Promise<readonly EnvItem[]>;

  /** An item's revisions, or the environment's when `item` is omitted. */
  history(item?: EnvItemRef): Promise<readonly EnvRevision[]>;

  /** Validate drafts: a skill parses, an MCP server starts and lists its functions. */
  validate(drafts: readonly EnvDraft[]): Promise<EnvValidation>;

  /** `reload({ install })`. Replaces each item as a whole, or refuses and changes nothing. */
  install(drafts: readonly EnvDraft[]): Promise<EnvRevision>;

  /** `reload({ remove })`. */
  remove(items: readonly EnvItemRef[]): Promise<EnvRevision>;

  /** What changed since a revision, for a live window's delta. */
  delta(since: EnvRef): Promise<EnvDelta>;
}
