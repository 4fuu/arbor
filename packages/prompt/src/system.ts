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
} from "@4fu/arbor-interfaces";
import { Renderer } from "./render.ts";
import { textOf } from "./text.ts";

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
function sectionsOf(input: SystemPromptInput, table: TextTable): Section[] {
  const identity = input.settings?.identity?.trim() ?? "";
  const rules = input.settings?.generalRules ?? DEFAULT_GENERAL_RULES;
  const sections: Section[] = [];

  if (identity !== "") sections.push({ tag: "identity", lines: [identity] });
  sections.push({
    tag: "agent",
    lines: rules.map((rule) => textOf(table, rule, undefined, rule)),
  });
  if (input.tools.length > 0) {
    sections.push({
      tag: "tools",
      // A tool a plugin or a backend declared says where it comes from, so the
      // model knows whose it is (docs/tools.md#external-tools).
      lines: input.tools.map((tool) =>
        tool.source === undefined
          ? textOf(table, "system.tool", { name: tool.name, description: tool.description })
          : textOf(table, "system.tool.source", { name: tool.name, description: tool.description, source: tool.source }),
      ),
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

/**
 * Build the frozen prefix. `plugins` are awaited last because their content is
 * produced per epoch, and their sections render in a tag named after the
 * plugin.
 */
export async function renderSystemPrompt(
  input: SystemPromptInput,
  renderer: Renderer,
): Promise<string> {
  const table = rendererTable(renderer);
  const sections: string[] = [];
  for (const section of sectionsOf(input, table)) {
    sections.push([`<${section.tag}>`, ...section.lines, `</${section.tag}>`].join("\n"));
  }
  for (const plugin of input.plugins ?? []) {
    const content = await plugin.content();
    const rendered = renderer.render(content);
    if (rendered === "") continue;
    sections.push([`<${plugin.tag}>`, rendered, `</${plugin.tag}>`].join("\n"));
  }
  return sections.join("\n\n");
}

/** The table a renderer was built with, for the lines that are not blocks. */
function rendererTable(renderer: Renderer): TextTable {
  return renderer.table;
}
