#!/usr/bin/env node
/**
 * Build every package into its `dist` directory.
 *
 * Development runs the TypeScript sources: `pnpm check` typechecks and tests
 * each package's `src`, and every package's `exports` points at that source, so
 * a change in one package is seen by the others without a build. Publishing is
 * the other case: Node refuses to strip types inside `node_modules`, so a
 * published package needs JavaScript and declarations. This script emits them.
 *
 * What it does, per package that carries a `tsconfig.build.json`:
 *
 * 1. removes the previous `dist`, so a deleted source leaves no stale output;
 * 2. runs `tsc` on it, which compiles `src` (tests excluded) to `dist`, with
 *    declarations, and rewrites the `.ts` extensions the sources carry to `.js`
 *    in both the JavaScript and the declarations;
 * 3. copies the files `tsc` does not compile - the web page the HTTP plugin
 *    serves, the built-in skills the environment seeds - beside the output.
 *
 * Imports of a sibling package stay package-name imports in the output, so a
 * built package resolves its siblings the same way in the repository and in a
 * published install: through the sibling's `exports`.
 *
 * `scripts/publish.mjs` turns each `dist` into a publishable package.
 */

import { spawnSync } from "node:child_process";
import { cp, rm } from "node:fs/promises";
import { join } from "node:path";
import { buildablePackages, compilerOf } from "./workspace.mjs";

/** The files a package ships beside its compiled output, keyed by package name. */
const ASSETS = {
  "@4fu/arbor-environment-dir": ["skills"],
  "@4fu/arbor-workspace-ovnfs": ["hooks", "skills"],
  "@4fu/arbor-plugin-http": ["web"],
};

async function build(package_) {
  await rm(package_.dist, { recursive: true, force: true });
  const compiled = spawnSync(process.execPath, [compilerOf(package_.directory), "-p", "tsconfig.build.json"], {
    cwd: package_.directory,
    stdio: "inherit",
  });
  if (compiled.status !== 0) {
    throw new Error(`${package_.name}: tsc exited with ${compiled.status}`);
  }
  for (const asset of ASSETS[package_.name] ?? []) {
    await cp(join(package_.directory, "src", asset), join(package_.dist, asset), {
      recursive: true,
    });
  }
}

const packages = await buildablePackages();
if (packages.length === 0) throw new Error("no package carries a tsconfig.build.json");

for (const package_ of packages) {
  await build(package_);
  console.log(`${package_.name}: dist`);
}
console.log(`built ${packages.length} packages`);
