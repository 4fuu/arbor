/**
 * The environment a child process gets
 * (docs/environment.md#what-a-subprocess-gets).
 *
 * A subprocess never inherits the host's own environment: every MCP call, every
 * resident service and every command a window runs would otherwise read every
 * variable the host carries, including the ones no configuration named. Each one
 * gets the minimum it needs to run - a PATH to find programs in, HOME, LANG,
 * TMPDIR and the directory it works in - plus what its own configuration adds:
 * the item's own `env`, and the secrets it names by name.
 *
 * The values of the minimum come from the host, because a child process needs
 * the same PATH and HOME the host itself runs with; nothing else does.
 */

/** The variable that carries the directory a child process works in. */
export const WORKSPACE_ENV = "ARBOR_WORKSPACE";

/**
 * The variables every child process gets, whatever it is: where programs and
 * the user's files are, the locale and time zone, the terminal, the network
 * proxy (without which `npx` or `uvx` cannot fetch an MCP server behind one),
 * and the system variables Windows programs cannot start without. None of
 * them is a credential a configuration would name as a secret.
 */
const MINIMUM_KEYS = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TERM",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TMPDIR",
  "XDG_RUNTIME_DIR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
  // Windows.
  "SystemRoot",
  "windir",
  "ComSpec",
  "PATHEXT",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "TEMP",
  "TMP",
  "ProgramFiles",
  "ProgramData",
] as const;

/** What one child process is given beyond the minimum. */
export interface ChildEnvInput {
  /** The directory it works in, when it has one. */
  workspace?: string;
  /** What its own configuration declares. */
  env?: Record<string, string | undefined>;
  /** The secrets its configuration names; their values are resolved by the caller. */
  secrets?: Record<string, string | undefined>;
}

/**
 * One child process's environment. A variable the minimum names and the host
 * does not carry is left out rather than filled with an empty string, so a
 * child process sees the same absence the host does.
 */
export function childEnvironment(input: ChildEnvInput): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of MINIMUM_KEYS) {
    const value = process.env[key];
    if (value !== undefined && value !== "") env[key] = value;
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
