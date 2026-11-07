/**
 * The group a plugin's or a backend's direct tools are registered as
 * (docs/tools.md#external-tools).
 *
 * One group per source, holding every tool that source declared. Nothing here
 * is special: the group declares its tools the way any group does and runs a
 * call the way any group does, so the hooks, the journaling, the scrub and the
 * one result cut around a call are the ones the host and the catalog apply to
 * every direct tool.
 *
 * The `source` rides on each spec, so the tools list the model reads says where
 * a tool comes from and `tool_search` answers with the same line. So does the
 * JSON Schema the outside harness declared, carried through untouched
 * (docs/tools.md#external-tools).
 */

import type {
  CallContext,
  DirectToolSpec,
  ExternalTool,
  ToolCall,
  ToolGroup,
  ToolResult,
} from "@4fu/arbor-interfaces";
import { refused, type ToolServices } from "../host.ts";

export class ExternalToolGroup implements ToolGroup {
  readonly id: string;

  private readonly declared: readonly ExternalTool[];
  private readonly source: string;
  private readonly services: Pick<ToolServices, "table">;

  constructor(declared: readonly ExternalTool[], source: string, services: Pick<ToolServices, "table">) {
    this.id = `external:${source}`;
    this.declared = declared;
    this.source = source;
    this.services = services;
  }

  tools(): readonly DirectToolSpec[] {
    return this.declared.map((tool) => ({
      name: tool.name,
      description: tool.description,
      // A tool that declares a JSON Schema of its own needs no restatement of
      // it in arbor's shape: the schema is the declaration
      // (docs/tools.md#external-tools).
      parameters: tool.parameters ?? {},
      ...(tool.schema === undefined ? {} : { schema: tool.schema }),
      source: this.source,
    }));
  }

  modules(): readonly [] {
    return [];
  }

  async call(request: ToolCall, context: CallContext): Promise<ToolResult> {
    const tool = this.declared.find((one) => one.name === request.name);
    // The catalog routes by name, so a call reaches this group only for a name
    // it declares; the refusal keeps the answer in the core's error shape.
    if (tool === undefined) return refused("tool.not_owned", this.services.table, "unknown_tool", { name: request.name });
    return tool.execute(request, context);
  }
}
