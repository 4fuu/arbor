#!/usr/bin/env node
// A fake `ovnfs` for the unit tests (packages/workspace-ovnfs).
//
// It answers the same JSON shapes as ovnfs v0.1.1 over the `ctl` admin path,
// and keeps its checkouts in `<state>/checkouts.json` so `ls` reflects `new`
// and `rm` across the separate process each call spawns. A checkout is born
// dirty (as if the window already edited it) and `apply` clears it, unless the
// name contains "conflict", which reports a conflict and leaves it dirty. The
// real tests run the real binary; this fake only proves the wrapper and the
// workspace logic against the contract.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
let state = "";
let mount = "";
let json = false;
let index = 0;
while (index < args.length && args[index].startsWith("--")) {
  if (args[index] === "--state") {
    state = args[index + 1];
    index += 2;
  } else if (args[index] === "--mount") {
    mount = args[index + 1];
    index += 2;
  } else if (args[index] === "--json") {
    json = true;
    index += 1;
  } else {
    index += 1;
  }
}
const verb = args[index];
const rest = args.slice(index + 1);

function load() {
  try {
    return JSON.parse(readFileSync(join(state, "checkouts.json"), "utf8"));
  } catch {
    return { checkouts: [] };
  }
}

function save(store) {
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, "checkouts.json"), JSON.stringify(store));
}

function out(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
  process.exit(0);
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

if (verb === "version") {
  process.stdout.write("ovnfs v0.1.1 fake go1.27.3 linux/amd64\n");
  process.exit(0);
}

if (verb === "start") {
  out({ version: 5, pid: 4242, proto: "fuse", port: 0, mount, state, socket: join(state, "admin.sock"), checkouts: 0 });
}

if (verb !== "ctl") fail(`fake ovnfs: unknown verb ${verb}`);

const op = rest[0];
const input = rest[1] === undefined ? {} : JSON.parse(rest[1]);
const store = load();

if (op === "ls") {
  out({ checkouts: store.checkouts, snapshots: [] });
}

if (op === "new") {
  const name = input.name;
  if (store.checkouts.some((one) => one.name === name)) fail(`checkout ${name} exists`);
  const checkout = {
    name,
    path: join(mount, name),
    source: input.dir ?? "",
    base: "base-1",
    git: false,
    dirty: true,
    created: "2026-01-01T00:00:00Z",
  };
  store.checkouts.push(checkout);
  save(store);
  out({ checkout, warnings: [] });
}

const found = store.checkouts.find((one) => one.name === input.checkout);
if (op !== "rm" && found === undefined) fail(`no such checkout ${input.checkout}`);

if (op === "diff") {
  out({ from: "base", changes: found.dirty ? [{ path: "src/app.ts", status: "M" }] : [] });
}

if (op === "apply") {
  if (found.name.includes("conflict")) {
    out({
      snapshot: { id: "snap-1", checkout: found.name },
      source: found.source,
      applied: [],
      merged: [],
      conflicts: [{ path: "src/app.ts", reason: "both changed the same lines", markers: true }],
    });
  }
  found.dirty = false;
  save(store);
  const reply = {
    snapshot: { id: "snap-1", checkout: found.name },
    source: found.source,
    applied: [{ path: "src/app.ts", status: "M" }],
    merged: [],
    conflicts: [],
  };
  if (input.branch !== undefined) {
    reply.branch = input.branch;
    reply.commit = "abc1234";
  }
  out(reply);
}

if (op === "rm") {
  store.checkouts = store.checkouts.filter((one) => one.name !== input.checkout);
  save(store);
  out({});
}

fail(`fake ovnfs: unknown op ${op}`);
