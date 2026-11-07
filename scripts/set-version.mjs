#!/usr/bin/env node
/**
 * Set the release version on the packages that changed since the last release.
 *
 *   node scripts/set-version.mjs 2026.1106.0
 *
 * arbor versions use a calendar version in the form `YYYY.MDD.REVISION`, on the
 * same scheme as URI Agent: the year, the month without a leading zero, the day
 * on two digits, and the revision of that day, starting at zero. `2026.1106.0`
 * is the first release on 2026-11-06.
 *
 * A package takes the new version when it changed since the last release tag
 * (`v<version>`), or when it depends on one that takes it: the published
 * packages name each other at exact versions, so a dependent left behind would
 * keep installing the old one. Every other package keeps the version it was
 * last released at. A change is any committed change under the package's
 * directory except its test files (`*.test.ts` under `src`), which are never
 * published.
 * Without a release tag every package takes the version.
 *
 * The workspace links in `pnpm-lock.yaml` carry no version, so nothing else
 * changes. `scripts/publish.mjs --publish` publishes the packages at the newest
 * version and checks it against the date in `Asia/Hong_Kong`
 * (docs/release.md); this script only checks the form.
 */

import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { buildablePackages } from "./workspace.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const PATTERN = /^(\d{4})\.(\d{3,4})\.(\d+)$/;

function validate(version) {
  const match = PATTERN.exec(version);
  if (match === null) throw new Error("version must use YYYY.MDD.REVISION, for example 2026.1106.0");
  const [year, monthDay] = [match[1], match[2]];
  const month = Number.parseInt(monthDay.slice(0, -2), 10);
  const day = Number.parseInt(monthDay.slice(-2), 10);
  const date = new Date(Date.UTC(Number(year), month - 1, day));
  if (date.getUTCFullYear() !== Number(year) || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new Error(`invalid calendar version ${version}: no such date`);
  }
  if (monthDay !== `${month}${String(day).padStart(2, "0")}`) {
    throw new Error("the month must be unpadded and the day two digits");
  }
}

function git(...args) {
  return spawnSync("git", args, { cwd: root, encoding: "utf8" });
}

/** The newest release tag reachable from HEAD, or `null` when there is none. */
function lastReleaseTag() {
  const result = git("describe", "--tags", "--abbrev=0", "--match", "v[0-9]*", "HEAD");
  return result.status === 0 ? result.stdout.trim() : null;
}

/** Whether a committed change since `tag` touches what the package publishes. */
function changedSince(tag, directory) {
  const path = relative(root, directory);
  const result = git("diff", "--quiet", tag, "HEAD", "--", path, `:(exclude,glob)${path}/src/**/*.test.ts`);
  if (result.status === 0) return false;
  if (result.status === 1) return true;
  throw new Error(`git diff against ${tag} failed: ${result.stderr.trim()}`);
}

/** The workspace packages a package depends on, or takes as a peer. */
function workspaceDependencies(manifest) {
  const ranges = { ...manifest.dependencies, ...manifest.peerDependencies };
  return Object.entries(ranges)
    .filter(([, range]) => range.startsWith("workspace:"))
    .map(([name]) => name);
}

const [version] = process.argv.slice(2);
if (version === undefined || process.argv.length !== 3) {
  throw new Error("usage: node scripts/set-version.mjs <YYYY.MDD.REVISION>");
}
validate(version);

const packages = await buildablePackages();
const tag = lastReleaseTag();
/** Why each package takes the new version. */
const reasons = new Map();
for (const package_ of packages) {
  if (tag === null) reasons.set(package_.name, "no release tag");
  else if (changedSince(tag, package_.directory)) reasons.set(package_.name, `changed since ${tag}`);
}
if (reasons.size === 0) throw new Error(`no package changed since ${tag}; there is nothing to release`);
for (let grown = true; grown; ) {
  grown = false;
  for (const package_ of packages) {
    if (reasons.has(package_.name)) continue;
    const bumped = workspaceDependencies(package_.manifest).find((name) => reasons.has(name));
    if (bumped === undefined) continue;
    reasons.set(package_.name, `depends on ${bumped}`);
    grown = true;
  }
}

for (const package_ of packages) {
  const { manifest } = package_;
  const reason = reasons.get(package_.name);
  if (reason === undefined) {
    console.log(`${package_.name}: stays at ${manifest.version}`);
    continue;
  }
  if (manifest.version !== version) {
    const path = new URL("package.json", `file://${package_.directory}/`);
    await writeFile(path, `${JSON.stringify({ ...manifest, version }, null, 2)}\n`);
  }
  console.log(`${package_.name}: ${manifest.version} -> ${version} (${reason})`);
}
console.log(`set ${reasons.size} of ${packages.length} packages to ${version}`);
