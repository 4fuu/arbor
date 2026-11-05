/**
 * The plugin surface (docs/architecture.md#plugins).
 *
 * A plugin is the one unit that extends the host. It bundles any of the parts
 * below; every part is optional, so a plugin can be only a hook, only a skill,
 * or a whole domain such as a chat channel or a code host.
 *
 * Capabilities are MCP servers, not tools: a plugin adds no direct tool or
 * module of its own. What the model can do with it is an MCP server and skills
 * in `/env`, which the model reads, changes and reinstalls with `reload` like
 * any item.
 */

import type { Block, BlockKindSpec, TextTable } from "./blocks.ts";
import type { Channel } from "./channel.ts";
import type { EffectExecutor } from "./effects.ts";
import type { EnvDraft } from "./environment.ts";
import type { JudgeCriteria } from "./judge.ts";
import type { Hooks } from "./hooks.ts";
import type { TaskSource } from "./task.ts";

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
  /** Its content, as blocks. The plugin hands blocks, never finished text. */
  content(): readonly Block[] | Promise<readonly Block[]>;
  /**
   * The fixed strings its own blocks write, merged into the host's text table.
   * A plugin names no secret here, and writes no prompt text of its own: its
   * blocks carry data, and the table carries the words.
   */
  text?: TextTable;
}

export interface Plugin {
  readonly name: string;

  adapters?: PluginAdapters;

  /** MCP servers, installed into `/env/mcp` under the plugin's name. */
  mcpServers?: readonly EnvDraft[];

  /** Skills, installed into `/env/skills` under the plugin's name. */
  skills?: readonly EnvDraft[];

  hooks?: Hooks;

  promptSection?: PromptSection;

  /** Extra criteria or decisions for its own inputs. */
  judgeCriteria?: readonly JudgeCriteria[];
}
