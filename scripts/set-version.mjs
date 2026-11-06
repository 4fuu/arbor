#!/usr/bin/env node
/**
 * Set the release version across every package.
 *
 *   node scripts/set-version.mjs 2026.1106.0
 *
 * arbor versions use a calendar version in the form `YYYY.MDD.REVISION`, on the
 * same scheme as URI Agent: the year, the month without a leading zero, the day
 * on two digits, and the revision of that day, starting at zero. `2026.1106.0`
 * is the first release on 2026-11-06.
 *
 * Every package is published at the same version, so one version is set
 * everywhere - the packages and the repository's own root - and the workspace
 * links in `pnpm-lock.yaml` carry no version, so nothing else changes.
 * `scripts/publish.mjs --publish` is what checks the version against the date
 * in `Asia/Hong_Kong` (docs/release.md); this script only checks the form.
 */

import { readFile, writeFile } from "node:fs/promises";
import { workspacePackages } from "./workspace.mjs";

const PATTERN = /^(\d{4})\.(\d{3,4})\.(\d+)$/;

/** The form the first release used, `0.1.0`, before the calendar versions. */
const PLAIN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function validate(version) {
  if (PLAIN.test(version) && !/^\d{4}\./.test(version)) return;
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

const [version] = process.argv.slice(2);
if (version === undefined || process.argv.length !== 3) {
  throw new Error("usage: node scripts/set-version.mjs <YYYY.MDD.REVISION>");
}
validate(version);

for (const package_ of await workspacePackages()) {
  const path = new URL("package.json", `file://${package_.directory}/`);
  const manifest = JSON.parse(await readFile(path, "utf8"));
  if (manifest.version === version) continue;
  await writeFile(path, `${JSON.stringify({ ...manifest, version }, null, 2)}\n`);
  console.log(`${package_.name}: ${manifest.version} -> ${version}`);
}
console.log(`set every package to ${version}`);
