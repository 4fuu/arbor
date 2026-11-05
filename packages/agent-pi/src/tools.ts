/**
 * The tool declarations a window is opened with, as pi's tools
 * (docs/tools.md#direct-tools).
 *
 * A direct tool is declared to the model and called in the turn. The core
 * declares it once, as a `DirectToolSpec`; this mapping turns that one
 * declaration into pi's JSON Schema, so the model, the host and the journal all
 * read the same description. No pi type crosses back: `execute` answers with the
 * core's own `ToolResult`.
 */

import type {
  AgentTool,
  AgentToolResult,
} from "@earendil-works/pi-agent-core";
import type { ParameterSpec } from "@arbor/interfaces";

/** One parameter's JSON Schema, from its `ParameterSpec`. */
export function parameterSchema(parameter: ParameterSpec): Record<string, unknown> {
  const schema: Record<string, unknown> = { type: jsonType(parameter.type) };
  schema.description = parameter.description;
  if (parameter.default !== undefined) schema.default = parameter.default;
  if (parameter.type === "refs" || parameter.type === "array" || parameter.type === "blocks") {
    schema.type = "array";
    schema.items = { type: "string" };
  }
  if (parameter.type === "object") schema.type = "object";
  return schema;
}

function jsonType(type: ParameterSpec["type"]): string {
  switch (type) {
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "ref":
    case "refs":
    case "blocks":
    case "array":
      return "array";
    case "object":
      return "object";
    default:
      return "string";
  }
}

/** The JSON Schema one tool declares to pi. */
export function toolParameters(
  parameters: Record<string, ParameterSpec>,
): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [name, parameter] of Object.entries(parameters)) {
    properties[name] = parameterSchema(parameter);
    if (parameter.required === true) required.push(name);
  }
  return {
    type: "object",
    properties,
    ...(required.length === 0 ? {} : { required }),
  };
}

/** The core's result as pi's, so the model reads the same text either way. */
export function toolResultOf(
  result: { callId: string; ok: boolean; content: string },
): AgentToolResult<undefined> {
  return {
    content: [{ type: "text", text: result.content }],
    details: undefined,
    isError: result.ok === false,
  };
}

/** One direct tool, declared and wired to the core's call path. */
export function piTool(
  spec: { name: string; description: string; parameters: Record<string, ParameterSpec> },
  call: (args: Record<string, unknown>, callId: string) => Promise<{ ok: boolean; content: string }>,
): AgentTool<Record<string, unknown>> {
  return {
    name: spec.name,
    label: spec.name,
    description: spec.description,
    parameters: toolParameters(spec.parameters),
    execute: async (callId: string, params: unknown) => {
      const args = (params ?? {}) as Record<string, unknown>;
      const result = await call(args, callId);
      return toolResultOf({ callId, ...result });
    },
  };
}
