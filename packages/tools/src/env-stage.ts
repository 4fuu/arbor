/**
 * The environment as a command sees it (docs/environment.md#layout).
 *
 * A window reads the environment at `/env`, and it lives on the host. Where a
 * command runs decides how the prefix reaches it:
 *
 * - A plain-directory workspace runs the command on the host, so the prefix is
 *   rewritten onto the directory itself.
 * - A workspace that owns its execution environment runs the command where the
 *   host's directory is not visible, so the files are staged into that
 *   environment through the mount's own capability and the prefix is rewritten
 *   onto where they landed. It is read-only, so a change goes through the
 *   environment's own draft and `reload`.
 *
 * Staging is per mount and per revision: a `reload` lands as a new revision,
 * and the next command stages it again before it runs, so a live window always
 * reads what the environment holds now.
 */

import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import type { StagedFile, WorkspaceMount } from "@arbor/interfaces";

/** The environment as the file tools read it: the prefix and the host directory. */
export interface EnvPaths {
  prefix: string;
  directory: string;
}

/** What each mount has staged, and for which revision of the environment. */
const staged = new WeakMap<WorkspaceMount, { revision: string | undefined; at: string }>();

/**
 * One command as the execution environment sees it: the environment staged
 * where the command can read it, and the prefix rewritten onto where it landed.
 */
export async function envCommand(
  workspace: WorkspaceMount,
  command: string,
  env: EnvPaths | undefined,
  revision: string | undefined,
): Promise<string> {
  if (env === undefined || !command.includes(env.prefix)) return command;
  const stage = workspace.stage;
  // A mount whose `path` is a host path already reaches the directory.
  if (stage === undefined) return command.split(env.prefix).join(env.directory);
  const previous = staged.get(workspace);
  // No revision is no cache: a command then always reads what the environment
  // holds, rather than what was staged for a revision nobody named.
  const at =
    revision !== undefined && previous?.revision === revision
      ? previous.at
      : await stage(env.prefix, await envFiles(env.directory));
  staged.set(workspace, { revision, at });
  return command.split(env.prefix).join(at);
}

/** Every file under the environment's directory, as the text a command reads. */
async function envFiles(directory: string): Promise<StagedFile[]> {
  const files: StagedFile[] = [];
  const walk = async (at: string): Promise<void> => {
    for (const entry of await readdir(at, { withFileTypes: true }).catch(() => [])) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }
      if (!entry.isFile()) continue;
      const text = await readFile(path, "utf8").catch(() => null);
      if (text === null) continue;
      files.push({ path: relative(directory, path), text });
    }
  };
  await walk(directory);
  return files;
}
