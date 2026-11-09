/**
 * The plugin surface (docs/architecture.md#plugins).
 *
 * A plugin is the one unit that extends the host. It bundles any of the parts
 * below; every part is optional, so a plugin can be only a hook, only a skill,
 * or a whole domain such as a chat channel or a code host.
 *
 * Capabilities the model reads, changes and reinstalls itself are MCP servers
 * and skills in `/env`. A tool whose behaviour is the plugin's own code rather
 * than an item in `/env` is declared as an `ExternalTool` and reaches the model
 * under its own name (docs/tools.md#external-tools).
 */

import type { Block, BlockKindSpec, TextTable } from "./blocks.ts";
import type { Channel } from "./channel.ts";
import type { EffectExecutor } from "./effects.ts";
import type { EnvDraft } from "./environment.ts";
import type { JudgeCriteria } from "./judge.ts";
import type { Hooks } from "./hooks.ts";
import type { WindowRef } from "./refs.ts";
import type { TaskSource } from "./task.ts";
import type { ExternalTool, ExternalToolSource } from "./tools.ts";

/** Connections to the outside world. */
export interface PluginAdapters {
  channels?: readonly Channel[];
  taskSources?: readonly TaskSource[];
  effectExecutors?: readonly EffectExecutor[];
}

/** One plugin section of the system prompt. */
export interface PromptSection {
  /** The XML tag it renders in, named after the plugin. */
  tag: string;
  /** The block kinds its inputs use, which the renderer maps to text. */
  blocks: readonly BlockKindSpec[];
  /**
   * Its content, as blocks. The plugin hands blocks, never finished text.
   *
   * `window` is the window the section is rendered for, which the host names on
   * every render: the epoch a window opens with, a delta of the changed lines
   * while it runs. A section whose content is the same for every window ignores
   * it; one that serves several sessions - one workspace per session, each
   * naming the window it serves - answers for that window
   * (docs/prompting.md#plugin-sections-that-change).
   *
   * `label` is the opaque label the embedding attached to what that window
   * serves, which the host carries and never interprets: the id of the session
   * this window belongs to, so a section can say which one it is rendering for
   * without a map of its own (docs/windows.md#what-a-window-serves). Absent
   * when the task that opened the window named none.
   */
  content(window?: WindowRef, label?: string): readonly Block[] | Promise<readonly Block[]>;
  /**
   * The fixed strings its own blocks write, merged into the host's text table.
   * A plugin names no secret here, and writes no prompt text of its own: its
   * blocks carry data, and the table carries the words.
   */
  text?: TextTable;
  /**
   * The section's revision, which the plugin raises when its content changes.
   * The host asks for it as a window runs - one cheap call per step - and
   * renders the section again only when it moved, so a section that changes
   * reaches a live window as a delta carrying the changed lines
   * (docs/prompting.md#plugin-sections-that-change). Absent for a section that
   * never changes once the host has rendered it.
   */
  revision?(): string | number | Promise<string | number>;
  /**
   * True when this section's content differs from window to window - a section
   * that serves several sessions, one workspace per session, naming the window
   * it serves. The host then renders it for each window instead of freezing it
   * with the epoch, and that window's prefix is its own where this section is
   * concerned; every other window still shares the epoch's prefix
   * (docs/prompting.md#plugin-sections-that-change). Absent, like `false`: the
   * section says the same thing to every window and is frozen with the epoch.
   */
  perWindow?: boolean;
  /**
   * True when the section is material from outside the framework - a third
   * party's prompt text, such as the sections a DeepSeek Harness plugin
   * contributes. It is marked as data, carries a lead line saying what it is,
   * and the `<agent>` rules state that the framework's own prompt wins on
   * conflict (docs/prompting.md#data-and-instructions).
   */
  outside?: boolean;
}

export interface Plugin {
  readonly name: string;

  adapters?: PluginAdapters;

  /** MCP servers, installed into `/env/mcp` under the plugin's name. */
  mcpServers?: readonly EnvDraft[];

  /** Skills, installed into `/env/skills` under the plugin's name. */
  skills?: readonly EnvDraft[];

  /**
   * Direct tools of its own: declared to the model under the names it gives
   * them, and called in the turn through the same path a core tool takes
   * (docs/tools.md#external-tools). A name a core tool or a module already
   * declares is not registered; the host records the collision with its rule.
   *
   * The set may be a list or a source the host calls again on every refresh, so
   * a plugin whose tools change while the host runs - the tools a harness
   * around the host registered - answers with what stands now
   * (docs/tools.md#external-tools-that-change).
   */
  tools?: readonly ExternalTool[] | ExternalToolSource;

  hooks?: Hooks;

  promptSection?: PromptSection;

  /** Extra criteria or decisions for its own inputs. */
  judgeCriteria?: readonly JudgeCriteria[];
}
