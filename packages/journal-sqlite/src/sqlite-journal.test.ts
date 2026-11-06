import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { isArborError } from "@4fu/arbor-errors";
import type { EventRef } from "@4fu/arbor-interfaces";
import { SqliteJournal } from "./sqlite-journal.ts";
import { SCHEMA_VERSION, readMeta } from "./schema.ts";

function memoryJournal(now?: () => number): SqliteJournal {
  return new SqliteJournal({ path: ":memory:", now });
}

describe("append", () => {
  it("assigns the one global order and the ref that carries it", async () => {
    const journal = memoryJournal(() => 1_700_000_000_000);
    const first = await journal.append({
      kind: "input",
      window: "c1",
      body: "部署上线",
      targets: ["qq:group:1"],
    });
    const second = await journal.append({ kind: "tool_result", window: "c1", body: "done" });

    assert.equal(first.ref, "r1");
    assert.equal(first.seq, 1);
    assert.equal(second.ref, "r2");
    assert.equal(second.seq, 2);
    assert.equal(first.time, 1_700_000_000_000);
    assert.deepEqual(first.targets, ["qq:group:1"]);
    assert.equal(first.external, null);
    assert.equal(first.redacted, null);
  });

  it("keeps an event immutable: two reads give the same record", async () => {
    const journal = memoryJournal();
    const event = await journal.append({ kind: "input", window: "c1", body: "one", refs: [] });
    const again = await journal.get(event.ref);
    assert.deepEqual(again, event);
  });

  it("stores a redelivered outside message once, under its native id", async () => {
    const journal = memoryJournal();
    const first = await journal.append({
      kind: "input",
      external: "qq:12345",
      body: "hello",
      targets: ["qq:private:456"],
    });
    const again = await journal.append({
      kind: "input",
      external: "qq:12345",
      body: "hello",
      targets: ["qq:private:456"],
    });

    assert.equal(first.ref, again.ref);
    const all = await journal.list({});
    assert.equal(all.total, 1);
  });

  it("keeps the sequence growing when many windows append at once", async () => {
    const journal = memoryJournal();
    const appended = await Promise.all(
      Array.from({ length: 24 }, (_unused, index) =>
        journal.append({ kind: "input", window: "c1", body: `message ${index}` }),
      ),
    );
    const seqs = appended.map((event) => event.seq);
    assert.equal(new Set(seqs).size, 24);
    assert.deepEqual(
      [...seqs].sort((a, b) => a - b),
      Array.from({ length: 24 }, (_unused, index) => index + 1),
    );
    assert.equal((await journal.list({})).total, 24);
  });

  it("keeps the sequence across a restart of the host", async () => {
    const directory = await mkdtemp(join(tmpdir(), "arbor-journal-test-"));
    try {
      const path = join(directory, "journal.db");
      const first = new SqliteJournal({ path });
      await first.append({ kind: "input", window: "c1", body: "before the restart" });
      await first.close();

      const second = new SqliteJournal({ path });
      const event = await second.append({ kind: "input", window: "c1", body: "after the restart" });
      assert.equal(event.ref, "r2");
      assert.equal((await second.list({})).total, 2);
      await second.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("opens a version-1 database, migrating the events table it has", async () => {
    const directory = await mkdtemp(join(tmpdir(), "arbor-journal-v1-"));
    try {
      const path = join(directory, "journal.db");
      // The schema as version 1 left it: the `snapshot` column `events` carried
      // before the workspace snapshots were dropped, with an index on it.
      const old = new DatabaseSync(path);
      old.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
      old.exec(`INSERT INTO meta (key, value) VALUES ('schema_version', '1')`);
      old.exec(`CREATE TABLE events (
         seq INTEGER PRIMARY KEY AUTOINCREMENT,
         window TEXT,
         time INTEGER NOT NULL,
         kind TEXT NOT NULL,
         external TEXT,
         body TEXT,
         snapshot TEXT,
         redacted TEXT
       )`);
      old.exec(`CREATE UNIQUE INDEX events_external ON events (external) WHERE external IS NOT NULL`);
      old.exec(`CREATE INDEX events_window ON events (window, seq)`);
      old.exec(`CREATE INDEX events_kind ON events (kind, seq)`);
      old.exec(`CREATE INDEX events_snapshot ON events (snapshot)`);
      old.prepare(`INSERT INTO events (window, time, kind, body, snapshot) VALUES (?, ?, ?, ?, ?)`)
        .run("c1", 1_700_000_000_000, "input", "第一批", "ws1");
      old.close();

      const journal = new SqliteJournal({ path, now: () => 1_700_000_001_000 });
      const stored = await journal.get("r1" as EventRef);
      assert.equal(stored?.window, "c1");
      assert.equal(stored?.body, "第一批");

      // The dropped column and its index are gone, and the version says so.
      const migrated = new DatabaseSync(path);
      const columns = (migrated.prepare("PRAGMA table_info(events)").all() as { name: string }[]).map(
        (column) => column.name,
      );
      assert.ok(!columns.includes("snapshot"));
      assert.equal(readMeta(migrated, "schema_version"), String(SCHEMA_VERSION));
      migrated.close();

      // The one global order carries on from where the old database left off.
      const next = await journal.append({ kind: "input", window: "c1", body: "第二批" });
      assert.equal(next.ref, "r2");
      assert.equal((await journal.list({})).total, 2);
      await journal.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("refuses a database a newer build wrote", async () => {
    const directory = await mkdtemp(join(tmpdir(), "arbor-journal-v9-"));
    try {
      const path = join(directory, "journal.db");
      const future = new DatabaseSync(path);
      future.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
      future.exec(`INSERT INTO meta (key, value) VALUES ('schema_version', '9')`);
      future.close();
      assert.throws(() => new SqliteJournal({ path }), /journal schema 9 is newer than this build \(2\)/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("reads", () => {
  it("reads many events in the order asked for and skips what is missing", async () => {
    const journal = memoryJournal();
    const first = await journal.append({ kind: "input", window: "c1", body: "one" });
    const second = await journal.append({ kind: "input", window: "c1", body: "two" });
    const third = await journal.append({ kind: "input", window: "c1", body: "three" });

    const events = await journal.getMany([third.ref, first.ref, "r99"]);
    assert.deepEqual(
      events.map((event) => event.ref),
      [third.ref, first.ref],
    );
    assert.equal(events[1]?.body, "one");
    assert.equal(second.ref, "r2");
  });

  it("lists events chronologically, filtered, and reports the bound", async () => {
    const journal = memoryJournal();
    await journal.append({ kind: "input", window: "c1", body: "one", targets: ["qq:group:1"] });
    await journal.append({ kind: "tool_result", window: "c2", body: "two", targets: ["file:src/a.ts"] });
    await journal.append({ kind: "input", window: "c1", body: "three", targets: ["qq:group:1"] });

    const page = await journal.list({ window: "c1", limit: 1 });
    assert.equal(page.total, 2);
    assert.equal(page.limit, 1);
    assert.equal(page.items[0]?.body, "one");
    assert.equal(page.nextCall, "journal.list(window=c1, offset=1)");

    const byTarget = await journal.list({ targets: ["file:src/a.ts"] });
    assert.equal(byTarget.total, 1);
    assert.equal(byTarget.items[0]?.body, "two");

    const byKind = await journal.list({ kinds: ["tool_result"] });
    assert.equal(byKind.total, 1);
    assert.equal(byKind.items[0]?.body, "two");

    const later = await journal.list({ afterSeq: 1 });
    assert.deepEqual(
      later.items.map((event) => event.body),
      ["two", "three"],
    );
  });

  it("counts an event with three targets once", async () => {
    const journal = memoryJournal();
    await journal.append({
      kind: "tool_call",
      window: "c1",
      body: "edit",
      targets: ["file:src/a.ts", "file:src/b.ts", "file:src/c.ts"],
    });
    const page = await journal.list({ targets: ["file:src/a.ts", "file:src/b.ts", "file:src/c.ts"] });
    assert.equal(page.total, 1);
  });

  it("reads the events around one, bounded on both sides", async () => {
    const journal = memoryJournal();
    for (let index = 1; index <= 6; index += 1) {
      await journal.append({ kind: "input", window: "c1", body: `event ${index}` });
    }
    const around = await journal.around("r4", { before: 1, after: 2 });
    assert.deepEqual(
      around.map((event) => event.ref),
      ["r3", "r4", "r5", "r6"],
    );
  });
  it("finds the stored copy of an outside message by its native id", async () => {
    const journal = memoryJournal();
    const message = await journal.append({
      kind: "input",
      external: "qq:12345",
      body: "the message",
      targets: ["qq:private:456"],
    });

    const byId = await journal.list({ external: "qq:12345" });
    assert.equal(byId.total, 1);
    assert.equal(byId.items[0]?.ref, message.ref);
    assert.equal(byId.items[0]?.external, "qq:12345");

    const other = await journal.list({ external: "qq:99999" });
    assert.equal(other.total, 0);
  });
});

describe("links and tracing", () => {
  it("records what an append declared and a bare cite for every other ref", async () => {
    const journal = memoryJournal(() => 1_000);
    const parent = await journal.append({ kind: "input", window: "c1", body: "the question" });
    const child = await journal.append({
      kind: "input",
      window: "c2",
      body: "the answer",
      refs: [parent.ref],
      links: [{ kind: "handoff", to: "c1", weight: 1 }],
    });

    assert.deepEqual(
      child.links.map((link) => [link.kind, link.to, link.weight]),
      [
        ["handoff", "c1", 1],
        ["cite", parent.ref, 0.5],
      ],
    );

    const related = await journal.links(child.ref);
    assert.deepEqual(
      related.items.map((item) => [item.ref, item.kind, item.weight, item.direction]),
      [
        ["c1", "handoff", 1, "out"],
        [parent.ref, "cite", 0.5, "out"],
      ],
    );
    assert.equal(related.total, 2);
    assert.equal(related.nextCall, "journal.links(r2, offset=3)");
  });

  it("shows a ref's related items by weight, and pages the rest", async () => {
    const journal = memoryJournal();
    const origin = await journal.append({ kind: "input", external: "qq:1", body: "outside" });
    await journal.append({ kind: "input", window: "c1", body: "one", refs: [origin.ref] });
    await journal.append({
      kind: "input",
      window: "c2",
      body: "two",
      refs: [origin.ref],
      links: [{ kind: "reply", to: origin.ref, weight: 1 }],
    });

    const page = await journal.links(origin.ref, { limit: 1 });
    assert.equal(page.total, 2);
    assert.equal(page.items[0]?.ref, "r3");
    assert.equal(page.items[0]?.direction, "in");
    assert.equal(page.items[0]?.window, "c2");
    assert.equal(page.items[0]?.summary, "two");

    const rest = await journal.links(origin.ref, { limit: 1, offset: 1 });
    assert.equal(rest.items[0]?.ref, "r2");
    assert.equal(rest.items[0]?.weight, 0.5);
  });

  it("walks the links back to the original outside message", async () => {
    const journal = memoryJournal();
    const outside = await journal.append({
      kind: "input",
      external: "qq:12345",
      body: "the request that started it",
    });
    const worked = await journal.append({
      kind: "tool_result",
      window: "c1",
      body: "the result",
      refs: [outside.ref],
    });
    const concluded = await journal.append({
      kind: "input",
      window: "c1",
      body: "the conclusion",
      refs: [worked.ref],
      links: [{ kind: "evidence", to: worked.ref, weight: 1 }],
    });

    const trace = await journal.trace(concluded.ref);
    assert.equal(trace.ref, concluded.ref);
    assert.equal(trace.origin, false);
    assert.equal(trace.from[0]?.ref, worked.ref);
    assert.equal(trace.from[0]?.from[0]?.ref, outside.ref);
    assert.equal(trace.from[0]?.from[0]?.origin, true);
    assert.equal(trace.from[0]?.from[0]?.from.length, 0);
  });
});

describe("watermarks", () => {
  it("keeps the newest event on a target a window has seen, and never moves back", async () => {
    const journal = memoryJournal();
    await journal.append({ kind: "input", window: "c1", body: "one", targets: ["qq:group:1"] });
    await journal.append({ kind: "input", window: "c2", body: "two", targets: ["qq:group:1"] });
    await journal.append({ kind: "input", window: "c2", body: "three", targets: ["qq:group:1"] });

    assert.equal(await journal.watermark("c1", "qq:group:1"), null);
    assert.equal(await journal.advanceWatermark("c1", "qq:group:1", 1), 1);
    assert.equal(await journal.advanceWatermark("c1", "qq:group:1", 1), 1);
    assert.equal(await journal.watermark("c1", "qq:group:1"), 1);

    const behind = await journal.targetsBehind("c1");
    assert.deepEqual(behind, [
      { target: "qq:group:1", latest: 3, watermark: 1, count: 2 },
    ]);

    await journal.advanceWatermark("c1", "qq:group:1", 3);
    assert.deepEqual(await journal.targetsBehind("c1"), []);
  });

  it("reports only what another window wrote after the window opened", async () => {
    const journal = memoryJournal();
    // The task and the outside events a window was opened for are not open
    // work, and neither is the window's own `window_start`.
    await journal.append({ kind: "input", body: "one", targets: ["qq:group:1"] });
    await journal.append({ kind: "task", targets: ["qq:group:1"] });
    await journal.append({ kind: "window_start", window: "c1", body: "opened", targets: ["qq:group:1"] });
    await journal.append({ kind: "input", window: "c2", body: "two", targets: ["qq:group:2"] });
    assert.deepEqual(await journal.targetsBehind("c1"), []);

    // What another window wrote on the target after this one opened is.
    await journal.append({ kind: "input", window: "c2", body: "three", targets: ["qq:group:1"] });
    assert.deepEqual(await journal.targetsBehind("c1"), [
      { target: "qq:group:1", latest: 5, watermark: 0, count: 1 },
    ]);

    // And so is what the host itself wrote there afterwards.
    await journal.append({ kind: "input", body: "four", targets: ["qq:group:1"] });
    assert.deepEqual(await journal.targetsBehind("c1"), [
      { target: "qq:group:1", latest: 6, watermark: 0, count: 2 },
    ]);
  });
});

describe("redaction", () => {
  it("erases the content, records what erased it, and keeps the ref resolving", async () => {
    const journal = memoryJournal(() => 5_000);
    const secret = await journal.append({
      kind: "input",
      window: "c1",
      body: "the api key is sk-live-1234",
      targets: ["qq:group:1"],
    });

    const redaction = await journal.redact(secret.ref, "recorded a secret by mistake");
    assert.equal(redaction.kind, "redaction");
    assert.deepEqual(redaction.refs, [secret.ref]);

    const after = await journal.get(secret.ref);
    assert.equal(after?.body, null);
    assert.equal(after?.redacted?.by, redaction.ref);
    assert.equal(after?.redacted?.reason, "recorded a secret by mistake");
    assert.equal(after?.redacted?.time, 5_000);

    // The ref still resolves and the content is gone from every index.
    assert.equal((await journal.search("sk-live-1234")).total, 0);
    assert.equal((await journal.search("api key")).total, 0);
    assert.equal((await journal.get(secret.ref))?.ref, secret.ref);
  });

  it("refuses to redact an event that is not in the journal", async () => {
    const journal = memoryJournal();
    await assert.rejects(
      () => journal.redact("r42", "not there"),
      (error: unknown) =>
        isArborError(error) &&
        error.code === "not_found" &&
        error.rule === "journal.redact.event" &&
        typeof error.nextAction === "string",
    );
  });
});

describe("errors", () => {
  it("refuses a ref that is not an event ref, naming the next action", async () => {
    const journal = memoryJournal();
    await journal.append({ kind: "input", window: "c1", body: "one" });
    // A caller passed a window ref where an event ref belongs.
    const notAnEvent = "c41" as EventRef;
    await assert.rejects(
      () => journal.get(notAnEvent),
      (error: unknown) =>
        isArborError(error) &&
        error.code === "invalid_input" &&
        error.rule === "journal.get" &&
        error.nextAction === "pass a ref an event carries, such as r902",
    );
  });

  it("refuses a read after the journal is closed", async () => {
    const journal = memoryJournal();
    await journal.close();
    await assert.rejects(
      () => journal.append({ kind: "input", body: "one" }),
      (error: unknown) => isArborError(error) && error.rule === "journal.closed",
    );
  });
});
