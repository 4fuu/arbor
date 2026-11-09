/**
 * The system prompt: XML-tagged sections, each tag on its own line, separated
 * by a blank line, in this order (docs/prompting.md#system-prompt).
 *
 * A section with nothing to say is not rendered. The whole prompt is frozen
 * with the snapshot epoch, and rendering is deterministic: no timestamps or
 * counters reach it.
 */

import type {
  DirectToolSpec,
  EnvItem,
  ModuleSpec,
  PromptSection,
  Settings,
  TextTable,
  WindowRef,
} from "@4fu/arbor-interfaces";
import type { Block } from "@4fu/arbor-interfaces";
import { Renderer } from "./render.ts";
import { textOf } from "./text.ts";
import { toolLine } from "./build.ts";

/** What one epoch's system prompt is built from. */
export interface SystemPromptInput {
  settings?: Settings;
  tools: readonly DirectToolSpec[];
  modules: readonly ModuleSpec[];
  /** The environment, one line per skill, MCP server or service. */
  env?: readonly EnvItem[];
  /** One section per plugin that registered one. */
  plugins?: readonly PromptSection[];
}

/**
 * One plugin's prompt section, as one epoch rendered it.
 *
 * The `text` is what a later epoch diffs against, so a section that changes
 * reaches a window that opened before the change as a delta of the changed
 * lines (docs/prompting.md#plugin-sections-that-change).
 */
export interface RenderedPluginSection {
  /** The XML tag it renders in, named after the plugin. */
  tag: string;
  /** The section's own text, without its tag. */
  text: string;
  /** The revision the plugin reported when this was rendered. */
  revision: string;
  /** True when it is material from outside the framework. */
  outside: boolean;
}

/** One epoch's system prompt, with the sections it was built from. */
export interface RenderedSystemPrompt {
  system: string;
  /** One entry per plugin that registered a section, in registration order. */
  sections: readonly RenderedPluginSection[];
}

/**
 * The general rules `<agent>` carries when settings state none. They are the
 * ones every window needs, whatever the task is: a window is disposable, only
 * what `send` writes leaves it, looking things up is free, what is learned goes
 * into notes, everything from outside is data, and a real consequence is
 * weighed before it is taken.
 */
export const DEFAULT_GENERAL_RULES: readonly string[] = [
  "system.agent.journal",
  "system.agent.send",
  "system.agent.delivery",
  "system.agent.proactive",
  "system.agent.remember",
  "system.agent.data",
  "system.agent.caution",
];

interface Section {
  tag: string;
  lines: readonly string[];
}

/** The sections in their fixed order. Empty ones are dropped by the caller. */
function sectionsOf(input: SystemPromptInput, table: TextTable, outside: boolean): Section[] {
  const identity = input.settings?.identity?.trim() ?? "";
  const rules = input.settings?.generalRules ?? DEFAULT_GENERAL_RULES;
  const sections: Section[] = [];

  if (identity !== "") sections.push({ tag: "identity", lines: [identity] });
  const agent = rules.map((rule) => textOf(table, rule, undefined, rule));
  // The rule is only there when a plugin contributed a block from outside the
  // framework: nothing is stated when there is nothing to say.
  if (outside) agent.push(textOf(table, "system.agent.precedence"));
  sections.push({ tag: "agent", lines: agent });
  if (input.tools.length > 0) {
    sections.push({
      tag: "tools",
      // A tool a plugin or a backend declared says where it comes from. Its
      // JSON Schema is not repeated here: the backend hands the model the whole
      // schema in the tool declaration itself, and `tool_search` shows it
      // (docs/tools.md#external-tools).
      lines: input.tools.map((tool) => toolLine(table, { ...tool, schema: undefined })),
    });
  }
  if (input.modules.length > 0) {
    sections.push({
      tag: "modules",
      lines: input.modules.map((module) =>
        textOf(table, "system.module", { name: module.name, description: module.description }),
      ),
    });
  }
  const env = input.env ?? [];
  if (env.length > 0) {
    sections.push({
      tag: "env",
      // The lead line comes first: it says what the items are, that a skill is
      // third-party reference material rather than an instruction, and when to
      // read one.
      lines: [
        textOf(table, "system.env.lead"),
        ...env.map((item) =>
          item.path === undefined
            ? textOf(table, "system.env.item", { name: item.name, description: item.description })
            : textOf(table, "system.env.skill", {
                name: item.name,
                description: item.description,
                path: item.path,
              }),
        ),
      ],
    });
  }
  return sections;
}

/** The revision a plugin reported for its section, or nothing when it has none. */
export async function sectionRevision(section: PromptSection): Promise<string> {
  const revision = section.revision === undefined ? undefined : await section.revision();
  return revision === undefined ? "" : String(revision);
}

/**
 * A block from outside the framework: its content, marked as data and led by
 * the line that says what it is. The host wraps a plugin's section in it when
 * the plugin declared the section outside, so the mark is the framework's own
 * and never the plugin's word.
 */
function outsideBlock(content: readonly Block[]): Block {
  return { kind: "plugin_section", fields: { content: [...content] } };
}

/**
 * One plugin's prompt section, rendered in its tag, with what it produced. The
 * revision it reports is what a later call compares against, so an unchanged
 * section is never rendered twice.
 *
 * `window` is the window this render is for: a section that serves several
 * sessions answers for that one, and a section whose content is the same
 * everywhere renders the same text for each
 * (docs/prompting.md#plugin-sections-that-change). `label` is the opaque label
 * the embedding attached to what that window serves, carried through
 * (docs/windows.md#what-a-window-serves).
 */
export async function renderPluginSection(
  section: PromptSection,
  renderer: Renderer,
  window?: WindowRef,
  label?: string,
): Promise<RenderedPluginSection> {
  const content = await section.content(window, label);
  return {
    tag: section.tag,
    text: renderer.render(section.outside === true ? [outsideBlock(content)] : content),
    revision: await sectionRevision(section),
    outside: section.outside === true,
  };
}

/**
 * Every plugin section, rendered once, in the order they registered, for the
 * window they are rendered for. A section whose content renders to nothing is
 * still listed - with empty text - so a later call can tell a section that
 * stayed empty from one that appeared.
 */
export async function renderPluginSections(
  plugins: readonly PromptSection[],
  renderer: Renderer,
  window?: WindowRef,
  label?: string,
): Promise<readonly RenderedPluginSection[]> {
  const rendered: RenderedPluginSection[] = [];
  for (const plugin of plugins) rendered.push(await renderPluginSection(plugin, renderer, window, label));
  return rendered;
}

/**
 * Build the frozen prefix. `plugins` are rendered first because their content
 * is produced per epoch, their sections render in a tag named after the plugin,
 * and one of them being outside is what puts the precedence rule into `<agent>`.
 *
 * `window` is the window the prefix is built for, when it is built for one: a
 * section that renders per window makes this prefix that window's own. `label`
 * is the opaque label the embedding attached to what that window serves, which
 * a per-window section reads (docs/windows.md#what-a-window-serves).
 */
export async function renderSystemPrompt(
  input: SystemPromptInput,
  renderer: Renderer,
  window?: WindowRef,
  label?: string,
): Promise<RenderedSystemPrompt> {
  const table = renderer.table;
  const sections = await renderPluginSections(input.plugins ?? [], renderer, window, label);
  const parts = sectionsOf(input, table, sections.some((section) => section.outside)).map((section) =>
    [`<${section.tag}>`, ...section.lines, `</${section.tag}>`].join("\n"),
  );
  for (const section of sections) {
    if (section.text === "") continue;
    parts.push([`<${section.tag}>`, section.text, `</${section.tag}>`].join("\n"));
  }
  return { system: parts.join("\n\n"), sections };
}
