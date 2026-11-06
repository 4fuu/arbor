/**
 * @4fu/arbor-environment-dir - the default `Environment`: one shared `/env`
 * directory, with a revision per item, validation on install and deltas for
 * live windows (docs/environment.md).
 */

export {
  BUILTIN_SKILLS,
  BUILTIN_SKILL_PATH,
  DirectoryEnvironment,
  type DirectoryEnvironmentOptions,
} from "./directory-environment.ts";
export { StdioMcpServer, type StdioServerOptions, type ServerFunction } from "./mcp.ts";
