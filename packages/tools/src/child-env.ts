/**
 * The environment a child process gets
 * (docs/environment.md#what-a-subprocess-gets).
 *
 * Every MCP server, resident service and command a window runs inherits the
 * host's whole environment, plus what its own configuration adds: the
 * directory it works in, the item's own `env`, and the secrets it names by
 * name. Nothing is withheld here on purpose: protection is one layer, the
 * secret scrub, which replaces every configured secret value in whatever
 * reaches the model or the journal (docs/environment.md#secrets).
 */

/** The variable that carries the directory a child process works in. */
export const WORKSPACE_ENV = "ARBOR_WORKSPACE";

/** What one child process is given beyond the host's own environment. */
export interface ChildEnvInput {
  /** The directory it works in, when it has one. */
  workspace?: string;
  /** What its own configuration declares. */
  env?: Record<string, string | undefined>;
  /** The secrets its configuration names; their values are resolved by the caller. */
  secrets?: Record<string, string | undefined>;
}

/** One child process's environment: the host's, then what its configuration adds. */
export function childEnvironment(input: ChildEnvInput): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  if (input.workspace !== undefined && input.workspace !== "") env[WORKSPACE_ENV] = input.workspace;
  for (const [key, value] of Object.entries(input.env ?? {})) {
    if (value !== undefined) env[key] = value;
  }
  for (const [key, value] of Object.entries(input.secrets ?? {})) {
    if (value !== undefined && value !== "") env[key] = value;
  }
  return env;
}
