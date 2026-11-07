#!/usr/bin/env node
/**
 * Pack every package, or publish the release's packages, from each `dist`.
 *
 *   node scripts/publish.mjs              `npm pack --dry-run` for every package
 *   node scripts/publish.mjs --publish    `npm publish` for each one in the release
 *   node scripts/publish.mjs --stage      `npm stage publish` for each one in the
 *                                         release; a maintainer approves each
 *                                         stage with 2FA
 *
 * The release is the packages at the newest version in the workspace:
 * `scripts/set-version.mjs` gives it only to the packages that changed and
 * their dependents, and every other package keeps a version already on the
 * registry, so it is not published again.
 *
 * The repository's own `package.json` files point their `exports` at the
 * TypeScript sources, because that is what development runs: Node strips the
 * types where they are, and `pnpm check` needs no build. A published package
 * cannot do that - Node refuses to strip types inside `node_modules` - so it
 * needs a manifest of its own that points at the built output. This script
 * writes that manifest into `dist` and packs or publishes from there.
 *
 * Everything the published manifest carries comes from the repository's
 * manifest: only what must differ does. The `exports`, `types` and `main` are
 * rewritten to `dist`-relative paths, a workspace range such as
 * `workspace:*` becomes that package's own version, and the fields that only mean
 * something in the repository - `private`, `scripts`, `devDependencies` - are
 * dropped. `license`, `repository`, `engines`, `description` and
 * `publishConfig.access` are carried over unchanged.
 *
 * Run `node scripts/build.mjs` first: publishing packs whatever `dist` holds.
 */

import { spawnSync } from "node:child_process";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildablePackages, filesUnder } from "./workspace.mjs";

const stage = process.argv.includes("--stage");
const publish = stage || process.argv.includes("--publish");
const dryRun = !publish;
const root = new URL("..", import.meta.url);

/** A `YYYY.MDD.REVISION` version as numbers, so two compare in order. */
function parts(version) {
  return version.split(".").map((part) => Number.parseInt(part, 10));
}

/** The newest version any package carries: the release's version. */
function releaseVersion(packages) {
  const versions = packages.map((one) => one.manifest.version);
  const newest = versions.reduce((best, one) => {
    const [a, b] = [parts(one), parts(best)];
    const order = a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
    return order > 0 ? one : best;
  });
  if (publish && newest === "0.0.0") {
    throw new Error("set the release version with node scripts/set-version.mjs first");
  }
  return newest;
}

/** Where one `exports` entry or `types`/`main` field points once published. */
function distPath(specifier, condition) {
  const extension = condition === "types" ? "d.ts" : "js";
  if (specifier.startsWith("./src/")) {
    return `./${specifier.slice(6).replace(/\.ts$/, "")}.${extension}`;
  }
  if (specifier.startsWith("./dist/")) return `./${specifier.slice(7)}`;
  return specifier;
}

function rewriteExports(exports) {
  const rewritten = {};
  for (const [specifier, target] of Object.entries(exports)) {
    if (typeof target === "string") rewritten[specifier] = distPath(target, "default");
    else {
      const conditions = {};
      for (const [condition, path] of Object.entries(target)) {
        conditions[condition] = typeof path === "string" ? distPath(path, condition) : path;
      }
      rewritten[specifier] = conditions;
    }
  }
  return rewritten;
}

/** A workspace range becomes that package's own version; an external one is kept. */
function pin(dependencies, versions) {
  if (dependencies === undefined) return undefined;
  const pinned = {};
  for (const [name, range] of Object.entries(dependencies)) {
    if (!range.startsWith("workspace:")) pinned[name] = range;
    else if (versions.has(name)) pinned[name] = versions.get(name);
    else throw new Error(`${name} is not a published workspace package`);
  }
  return pinned;
}

/** The manifest one package is published with, derived from its own. */
function publishManifest(package_, versions, files) {
  const source = package_.manifest;
  const manifest = { ...source };
  delete manifest.private;
  delete manifest.scripts;
  delete manifest.devDependencies;
  manifest.exports = rewriteExports(source.exports);
  if (typeof source.types === "string") manifest.types = distPath(source.types, "types");
  if (typeof source.main === "string") manifest.main = distPath(source.main, "default");
  manifest.files = files;
  const dependencies = pin(source.dependencies, versions);
  if (dependencies !== undefined) manifest.dependencies = dependencies;
  else delete manifest.dependencies;
  const peerDependencies = pin(source.peerDependencies, versions);
  if (peerDependencies !== undefined) manifest.peerDependencies = peerDependencies;
  else delete manifest.peerDependencies;
  return manifest;
}

/** The `README` and `LICENSE` a published package shows on the registry. */
async function copyDocuments(package_) {
  const own = join(package_.directory, "README.md");
  const readme = await readFile(await exists(own) ? own : new URL("README.md", root), "utf8");
  await writeFile(join(package_.dist, "README.md"), readme);
  const license = new URL("LICENSE", root);
  if (await exists(license)) await copyFile(license, join(package_.dist, "LICENSE"));
}

async function exists(path) {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

/** What a dry run runs: `npm pack --dry-run` in the package's `dist`. */
function packCommand() {
  return ["npm", ["pack", "--dry-run"]];
}

/**
 * What a release runs, from the same place: `npm publish`, or with `--stage`
 * `npm stage publish`, where the version waits on the registry until a
 * maintainer approves it with 2FA, so a stage-only token is enough
 * (docs/release.md).
 */
function publishCommand() {
  return stage ? ["npm", ["stage", "publish"]] : ["npm", ["publish", "--access", "public"]];
}

/** A release carries today's date in `Asia/Hong_Kong`, so a stale version is refused. */
function checkDate(version) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Hong_Kong",
    year: "numeric",
    month: "numeric",
    day: "2-digit",
  }).formatToParts(new Date());
  const part = (type) => parts.find((one) => one.type === type).value;
  const today = `${part("year")}.${part("month")}${part("day")}`;
  if (!version.startsWith(`${today}.`)) {
    throw new Error(`version ${version} is not today's date in Asia/Hong_Kong (${today}); set ${today}.<revision>`);
  }
}

/** Every entry point the package declares, as the file it is built into. */
function builtEntries(package_) {
  const declared = [];
  for (const target of Object.values(package_.manifest.exports)) {
    if (typeof target === "string") declared.push([target, "default"]);
    else for (const [condition, path] of Object.entries(target)) declared.push([path, condition]);
  }
  return declared.map(([path, condition]) => {
    const built = distPath(path, condition);
    return join(package_.dist, built.slice(2));
  });
}

/** The build output each entry point needs, checked before anything is packed. */
async function checkBuild(package_) {
  for (const entry of builtEntries(package_)) {
    if (!(await exists(entry))) {
      throw new Error(`${package_.name}: ${entry} is missing; run node scripts/build.mjs first`);
    }
  }
}

const all = await buildablePackages();
if (all.length === 0) throw new Error("no package carries a tsconfig.build.json");
const version = releaseVersion(all);
if (publish) checkDate(version);
const versions = new Map(all.map((one) => [one.name, one.manifest.version]));
const release = all.filter((one) => one.manifest.version === version);
const packages = dryRun ? all : release;
console.log(`${version}: ${release.map((one) => one.name).join(", ")}`);
console.log(`${dryRun ? "packing" : stage ? "staging" : "publishing"} ${packages.length} of ${all.length} packages`);

for (const package_ of packages) {
  await checkBuild(package_);
  await copyDocuments(package_);
  const files = (await filesUnder(package_.dist)).filter(
    (one) => one !== "package.json" && one !== "README.md" && one !== "LICENSE",
  );
  const manifest = publishManifest(package_, versions, files);
  await writeFile(join(package_.dist, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  const result = spawnSync(...(publish ? publishCommand() : packCommand()), {
    cwd: package_.dist,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(`${package_.name}: npm exited with ${result.status}`);
  }
}
