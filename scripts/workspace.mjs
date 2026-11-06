/**
 * The workspace's packages, as the build and the publish scripts see them.
 *
 * `pnpm-workspace.yaml` is the source of truth for which directories are
 * packages, so it is read here rather than hard-coded: a package that joins the
 * workspace is built and packed without a change to either script.
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Every workspace package directory, from the globs in `pnpm-workspace.yaml`. */
async function packageDirectories() {
  const workspace = await readFile(join(root, "pnpm-workspace.yaml"), "utf8");
  const globs = [...workspace.matchAll(/^ {2}- (\S+)$/gm)].map((match) => match[1]);
  if (globs.length === 0) throw new Error("pnpm-workspace.yaml declares no packages");
  const directories = [];
  for (const glob of globs) {
    const [parent, pattern] = glob.split("/");
    if (pattern !== "*") throw new Error(`unsupported workspace glob: ${glob}`);
    for (const entry of await readdir(join(root, parent), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const directory = join(root, parent, entry.name);
      if (await exists(join(directory, "package.json"))) directories.push(directory);
    }
  }
  return directories.sort();
}

/** Every workspace package, with its manifest, its directory and its `dist`. */
export async function workspacePackages() {
  const packages = [];
  for (const directory of await packageDirectories()) {
    const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
    packages.push({ name: manifest.name, directory, dist: join(directory, "dist"), manifest });
  }
  return packages;
}

/**
 * The packages that are built and published: every one that carries a
 * `tsconfig.build.json`. A package without one is the repository's own - the
 * root - and stays private.
 */
export async function buildablePackages() {
  const packages = [];
  for (const package_ of await workspacePackages()) {
    if (await exists(join(package_.directory, "tsconfig.build.json"))) packages.push(package_);
  }
  return packages;
}

/** `tsc` as one package resolves it, so the root needs no TypeScript of its own. */
export function compilerOf(directory) {
  return require.resolve("typescript/bin/tsc", { paths: [directory] });
}

/** Every file under a directory, as paths relative to it, sorted. */
export async function filesUnder(directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await filesUnder(path)).map((one) => join(entry.name, one)));
    else found.push(entry.name);
  }
  return found.sort();
}
