/**
 * The tool declarations a window is opened with, as pi's tools
 * (docs/tools.md#direct-tools).
 *
 * A direct tool is declared to the model and called in the turn. The core
 * declares it once, as a `DirectToolSpec`; this mapping turns that one
 * declaration into pi's JSON Schema, so the model, the host and the journal all
 * read the same description. No pi type crosses back: `execute` answers with the
 * core's own `ToolResult`, and a refusal reaches the model as the renderer's
 * error block - the rule and the next action, one line.
 */

import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ParameterSpec, ToolResult } from "@arbor/interfaces";
import type { Renderer } from "@arbor/prompt";
import { errorBlock } from "@arbor/prompt";

/** One parameter's JSON Schema, from its `ParameterSpec`. */
export function parameterSchema(parameter: ParameterSpec): Record<string, unknown> {
  const schema: Record<string, unknown> = {
    type: jsonType(parameter.type),
    description: parameter.description,
  };
  if (parameter.default !== undefined) schema.default = parameter.default;
  if (parameter.type === "refs" || parameter.type === "blocks" || parameter.type === "array") {
    schema.items = { type: "string" };
  }
  return schema;
}

function jsonType(type: ParameterSpec["type"]): string {
  switch (type) {
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "refs":
    case "blocks":
    case "array":
      return "array";
    default:
      return "string";
  }
}

/** The JSON Schema one tool declares to pi. */
export function toolParameters(parameters: Record<string, ParameterSpec>): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [name, parameter] of Object.entries(parameters)) {
    properties[name] = parameterSchema(parameter);
    if (parameter.required === true) required.push(name);
  }
  return { type: "object", properties, ...(required.length === 0 ? {} : { required }) };
}

/**
 * What the model reads of one result. A refusal is rendered as the error block,
 * so the model always gets the rule and the next action, never an empty result.
 */
export function resultText(result: ToolResult, renderer: Renderer): string {
  if (result.ok) return result.content;
  const error = result.error;
  if (error === undefined) return result.content;
  return renderer.render([
    errorBlock({
      tool: result.callId,
      rule: error.rule,
      message: error.message,
      ...(error.nextAction === undefined ? {} : { nextAction: error.nextAction }),
      ...(error.refs === undefined ? {} : { refs: error.refs }),
    }),
  ]);
}

/** The core's result as pi's. */
export function toolResultOf(result: ToolResult, renderer: Renderer): AgentToolResult<undefined> {
  return {
    content: [{ type: "text", text: resultText(result, renderer) }],
    details: undefined,
    isError: result.ok === false,
  };
}

/** One direct tool, declared and wired to the core's call path. */
export function piTool(
  spec: { name: string; description: string; parameters: Record<string, ParameterSpec> },
  call: (args: Record<string, unknown>, callId: string) => Promise<ToolResult>,
  renderer: Renderer,
): AgentTool<Record<string, unknown>> {
  return {
    name: spec.name,
    label: spec.name,
    description: spec.description,
    parameters: toolParameters(spec.parameters),
    execute: async (callId: string, params: unknown) => {
      const result = await call((params ?? {}) as Record<string, unknown>, callId);
      return toolResultOf(result, renderer);
    },
  };
}
