import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { isArborError } from "@arbor/errors";
import type { Event, EventInput, EventRef, NoteId, NoteRef } from "@arbor/interfaces";
import { SqliteJournal } from "@arbor/journal-sqlite";
import { SqliteNoteStore } from "./notes.ts";

/** A store and its journal, sharing one fixed clock. */
function memoryStore(now: () => number = () => 0): {
  store: SqliteNoteStore;
  journal: SqliteJournal;
} {
  const journal = new SqliteJournal({ path: ":memory:", now });
  return { store: new SqliteNoteStore({ journal, now }), journal };
}

/** A store whose clock a test moves, for the snapshot epochs. */
function clockStore(): {
  store: SqliteNoteStore;
  journal: SqliteJournal;
  advance: (ms: number) => void;
} {
  let now = 0;
  const journal = new SqliteJournal({ path: ":memory:", now: () => now });
  const store = new SqliteNoteStore({ journal, now: () => now });
  return { store, journal, advance: (ms) => (now += ms) };
}

/** A journal that refuses the next event it is asked to append. */
class FlakyJournal extends SqliteJournal {
  refuseNext = false;

  override async append(input: EventInput): Promise<Event> {
    if (this.refuseNext) {
      this.refuseNext = false;
      throw new Error("the journal is gone");
    }
    return super.append(input);
  }
}

/** A journal that refuses every event, to check a store on its own. */
class RefusingJournal extends SqliteJournal {
  override async append(): Promise<Event> {
    throw new Error("the journal is gone");
  }
}

/** The error a refused call carries, for the assertions below. */
function refused(rule: string): (error: unknown) => boolean {
  return (error: unknown) =>
    isArborError(error) && error.rule === rule && typeof error.nextAction === "string";
}

describe("writes", () => {
  it("creates a note at revision 1 and takes the opening of its body as the summary", async () => {
    const { store } = memoryStore(() => 5_000);
    const note = await store.write({ title: "deploy runbook", body: "step one\nstep two" });

    assert.equal(note.ref, "n1@1");
    assert.equal(note.id, "n1");
    assert.equal(note.title, "deploy runbook");
    assert.equal(note.summary, "step one step two");
    assert.equal(note.body, "step one\nstep two");
    assert.equal(note.visibility, "shared");
    assert.equal(note.revision, 1);
    assert.equal(note.time, 5_000);
    assert.equal(note.window, null);
    // A note is not active until an epoch picks it.
    assert.equal(note.status, "archived");
  });

  it("cuts a derived summary at 200 characters", async () => {
    const { store } = memoryStore();
    const note = await store.write({ title: "long", body: `${"x".repeat(250)}tail` });
    assert.equal(Array.from(note.summary).length, 201);
    assert.equal(note.summary.endsWith("…"), true);
  });

  it("records the write in the journal as a note revision event", async () => {
    const { store, journal } = memoryStore(() => 5_000);
    await store.write({
      title: "deploy runbook",
      body: "step one",
      anchor: { window: "c1", event: "r902" },
      refs: ["r7"],
    });

    const events = await journal.list({ kinds: ["note_revision"] });
    assert.equal(events.total, 1);
    const event = events.items[0];
    assert.ok(event !== undefined);
    assert.equal(event.window, "c1");
    assert.equal(event.time, 5_000);
    // The host fills targets in: the note it changed.
    assert.deepEqual(event.targets, ["n1"]);
    assert.equal(event.refs[0], "n1@1");
    assert.deepEqual(
      event.links.map((link) => [link.kind, link.to, link.weight]),
      [
        ["revision", "n1@1", 1],
        ["cite", "r7", 0.5],
      ],
    );
    assert.equal(event.body, "deploy runbook\nstep one");
  });

  it("keeps the summary and visibility a replace was not given, when the body holds", async () => {
    const { store } = memoryStore();
    await store.write({ title: "a", body: "one", summary: "the first summary", visibility: "private" });
    const second = await store.write({ title: "a renamed", body: "one", id: "n1", expectedRevision: 1 });

    assert.equal(second.ref, "n1@2");
    assert.equal(second.title, "a renamed");
    assert.equal(second.summary, "the first summary");
    assert.equal(second.visibility, "private");
    assert.equal((await store.read("n1"))?.body, "one");
    // Revisions are append-only: the one it replaced still resolves.
    assert.equal((await store.read("n1@1"))?.body, "one");
  });

  it("refuses a replace that changes the body without naming a summary", async () => {
    const { store } = memoryStore();
    await store.write({ title: "a", body: "one", summary: "the first summary" });
    await assert.rejects(
      () => store.write({ title: "a", body: "two", id: "n1", expectedRevision: 1 }),
      refused("note.write.summary"),
    );
    const replaced = await store.write({
      title: "a",
      body: "two",
      summary: "the second summary",
      id: "n1",
      expectedRevision: 1,
    });
    assert.equal(replaced.summary, "the second summary");
    assert.equal((await store.read("n1@1"))?.body, "one");
  });

  it("deletes a note: the current body is gone, the revisions are not", async () => {
    const { store, journal } = memoryStore();
    await store.write({ title: "a", body: "one" });
    const deleted = await store.write({
      title: "a",
      body: "",
      id: "n1",
      delete: true,
      expectedRevision: 1,
    });

    assert.equal(deleted.status, "deleted");
    assert.equal(deleted.body, null);
    assert.equal(await store.read("n1"), null);
    assert.equal((await store.read("n1@1"))?.body, "one");
    assert.equal((await store.search({ query: "one" })).total, 0);
    assert.equal((await store.active()).total, 0);
    assert.equal((await journal.list({ kinds: ["note_revision"] })).total, 2);
  });

  it("refuses a write to an existing note that names no revision", async () => {
    const { store } = memoryStore();
    await store.write({ title: "a", body: "one" });
    await assert.rejects(
      () => store.write({ title: "a", body: "two", id: "n1" }),
      refused("note.write.revision"),
    );
    assert.equal((await store.read("n1"))?.revision, 1);
  });

  it("refuses a stale write with what changed since the revision it read", async () => {
    const { store } = memoryStore(() => 1_000);
    await store.write({ title: "a", body: "one\nshared", anchor: { window: "c1", event: "r1" } });
    await store.write({
      title: "a",
      body: "two\nshared",
      summary: "the second line",
      id: "n1",
      expectedRevision: 1,
      anchor: { window: "c2", event: "r2" },
    });

    await assert.rejects(
      () => store.write({ title: "a", body: "three", id: "n1", expectedRevision: 1 }),
      (error: unknown) => {
        if (!isArborError(error)) return false;
        if (error.code !== "conflict" || error.rule !== "note.write.stale_revision") return false;
        const conflict = error.details.conflict as {
          read: number;
          current: number;
          revisions: ReadonlyArray<{ revision: number; window: string | null }>;
        };
        assert.equal(conflict.read, 1);
        assert.equal(conflict.current, 2);
        assert.equal(conflict.revisions.length, 1);
        assert.equal(conflict.revisions[0]?.revision, 2);
        assert.equal(conflict.revisions[0]?.window, "c2");
        // The differences, so the model merges them without reading it twice.
        assert.match(String(error.details.diff), /-one/);
        assert.match(String(error.details.diff), /\+two/);
        assert.deepEqual(error.refs, ["n1@2", "n1@2"]);
        return typeof error.nextAction === "string";
      },
    );
    // A refused call changes nothing.
    assert.equal((await store.read("n1"))?.body, "two\nshared");
  });

  it("shows the differences as a unified diff with context", async () => {
    const { store } = memoryStore();
    await store.write({ title: "a", body: "keep\none\nkeep", summary: "the first" });
    await store.write({ title: "a", body: "keep\ntwo\nkeep", summary: "the second", id: "n1", expectedRevision: 1 });

    await assert.rejects(
      () => store.write({ title: "a", body: "three", summary: "the third", id: "n1", expectedRevision: 1 }),
      (error: unknown) => {
        if (!isArborError(error)) return false;
        assert.equal(
          error.details.diff,
          ["@@ -1,3 +1,3 @@", " keep", "-one", "+two", " keep"].join("\n"),
        );
        return true;
      },
    );
  });

  it("reports a body too large to diff instead of walking it", async () => {
    const { store } = memoryStore();
    const big = Array.from({ length: 2100 }, (_unused, index) => `line ${index}`).join("\n");
    await store.write({ title: "a", body: big, summary: "the first" });
    await store.write({ title: "a", body: `${big}\nmore`, summary: "the second", id: "n1", expectedRevision: 1 });

    await assert.rejects(
      () => store.write({ title: "a", body: "x", summary: "the third", id: "n1", expectedRevision: 1 }),
      (error: unknown) =>
        isArborError(error) &&
        error.details.diff === "the body is too large to diff; read both revisions",
    );
  });

  it("carries the revisions even when the body did not change", async () => {
    const { store } = memoryStore();
    await store.write({ title: "a", body: "one", summary: "the first" });
    await store.write({
      title: "a renamed",
      body: "one",
      summary: "the second",
      id: "n1",
      expectedRevision: 1,
    });

    await assert.rejects(
      () => store.write({ title: "a", body: "two", summary: "the third", id: "n1", expectedRevision: 1 }),
      (error: unknown) => {
        if (!isArborError(error)) return false;
        assert.equal(error.details.diff, undefined);
        const conflict = error.details.conflict as {
          revisions: ReadonlyArray<{ summary: string }>;
        };
        assert.equal(conflict.revisions[0]?.summary, "the second");
        return true;
      },
    );
  });

  it("refuses a revision ahead of the note, and a note that is not there", async () => {
    const { store } = memoryStore();
    await store.write({ title: "a", body: "one" });
    await assert.rejects(
      () => store.write({ title: "a", body: "x", id: "n1", expectedRevision: 5 }),
      refused("note.write.revision"),
    );
    await assert.rejects(
      () => store.write({ title: "a", body: "x", id: "n9", expectedRevision: 1 }),
      refused("note.write.note"),
    );
    await assert.rejects(() => store.write({ title: "a", body: "x", id: "nonsense" as NoteId }), refused("note.write.ref"));
  });

  it("refuses a write that breaks the note's shape", async () => {
    const { store } = memoryStore();
    await assert.rejects(() => store.write({ title: "  ", body: "one" }), refused("note.write.title"));
    await assert.rejects(() => store.write({ title: "a", body: "  " }), refused("note.write.body"));
    await assert.rejects(
      () => store.write({ title: "a", body: "one", summary: "x".repeat(201) }),
      refused("note.write.summary"),
    );
    await assert.rejects(
      () => store.write({ title: "a", body: "one", expectedRevision: 1 }),
      refused("note.write.expected_revision"),
    );
    assert.equal((await store.search({})).total, 0);
  });

  it("refuses a write to a deleted note, and a second delete", async () => {
    const { store } = memoryStore();
    await store.write({ title: "a", body: "one" });
    await store.write({ title: "a", body: "", id: "n1", delete: true, expectedRevision: 1 });
    await assert.rejects(
      () => store.write({ title: "a", body: "x", id: "n1", expectedRevision: 2 }),
      refused("note.write.deleted"),
    );
    await assert.rejects(
      () => store.write({ title: "a", body: "", id: "n1", delete: true, expectedRevision: 2 }),
      refused("note.write.deleted"),
    );
  });
});

describe("concurrent writes", () => {
  it("lets one of two writes on the same revision through and refuses the other", async () => {
    const { store } = memoryStore();
    await store.write({ title: "a", body: "one" });

    const outcomes = await Promise.allSettled([
      store.write({
        title: "a",
        body: "from c1",
        summary: "from c1",
        id: "n1",
        expectedRevision: 1,
        anchor: { window: "c1", event: "r1" },
      }),
      store.write({
        title: "a",
        body: "from c2",
        summary: "from c2",
        id: "n1",
        expectedRevision: 1,
        anchor: { window: "c2", event: "r2" },
      }),
    ]);
    const kept = outcomes.filter((outcome) => outcome.status === "fulfilled");
    const lost = outcomes.filter((outcome) => outcome.status === "rejected");
    assert.equal(kept.length, 1);
    assert.equal(lost.length, 1);
    assert.ok(isArborError((lost[0] as PromiseRejectedResult).reason));

    const note = await store.read("n1");
    assert.equal(note?.revision, 2);
    assert.ok(note?.body === "from c1" || note?.body === "from c2");
    assert.equal((await store.revisions("n1")).total, 2);
  });

  it("checks the revision across two stores on one database", async () => {
    const directory = await mkdtemp(join(tmpdir(), "arbor-notes-test-"));
    try {
      const journal = new SqliteJournal({ path: join(directory, "journal.db") });
      const first = new SqliteNoteStore({ journal, path: join(directory, "notes.db") });
      const second = new SqliteNoteStore({ journal, path: join(directory, "notes.db") });
      await first.write({ title: "a", body: "one" });

      const outcomes = await Promise.allSettled([
        first.write({
          title: "a",
          body: "from the first store",
          summary: "from the first store",
          id: "n1",
          expectedRevision: 1,
        }),
        second.write({
          title: "a",
          body: "from the second store",
          summary: "from the second store",
          id: "n1",
          expectedRevision: 1,
        }),
      ]);
      assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
      assert.equal(outcomes.filter((outcome) => outcome.status === "rejected").length, 1);
      assert.equal((await first.read("n1"))?.revision, 2);
      assert.equal((await second.read("n1"))?.revision, 2);

      await first.close();
      await second.close();
      await journal.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("takes a write back when the journal refuses its event", async () => {
    const journal = new FlakyJournal({ path: ":memory:" });
    const store = new SqliteNoteStore({ journal });
    await store.write({ title: "a", body: "one" });
    journal.refuseNext = true;

    await assert.rejects(
      () => store.write({ title: "a", body: "two", id: "n1", expectedRevision: 1, summary: "two" }),
      (error: unknown) => isArborError(error) && error.rule === "note.write.journal",
    );
    // A refused call changes nothing: the note is still the one it was, and the
    // search index still holds the body that is there.
    assert.equal((await store.read("n1"))?.body, "one");
    assert.equal((await store.read("n1"))?.revision, 1);
    assert.equal((await store.search({ query: "one" })).total, 1);
    assert.equal((await store.search({ query: "two" })).total, 0);
    const retried = await store.write({ title: "a", body: "two", id: "n1", expectedRevision: 1, summary: "two" });
    assert.equal(retried.ref, "n1@2");

    await store.close();
    await journal.close();
  });

  it("takes a new note back when the journal refuses its event", async () => {
    const journal = new RefusingJournal({ path: ":memory:" });
    const store = new SqliteNoteStore({ journal });
    await assert.rejects(
      () => store.write({ title: "a", body: "one" }),
      refused("note.write.journal"),
    );
    assert.equal(await store.read("n1"), null);
    assert.equal((await store.revisions("n1")).total, 0);
    assert.equal((await store.search({})).total, 0);

    await store.close();
    await journal.close();
  });

  it("names the journal's own refusal with the write's rule", async () => {
    const journal = new SqliteJournal({ path: ":memory:" });
    const store = new SqliteNoteStore({ journal });
    await journal.close();
    await assert.rejects(
      () => store.write({ title: "a", body: "one" }),
      (error: unknown) =>
        isArborError(error) &&
        error.rule === "note.write.journal" &&
        error.code === "unavailable" &&
        error.details.upstream === "journal.closed: journal: the journal is closed",
    );
    assert.equal(await store.read("n1"), null);
    await store.close();
  });
});

describe("reads", () => {
  it("pages a body and reports the bound", async () => {
    const { store } = memoryStore();
    await store.write({ title: "long", body: "abcdefghij" });

    const page = await store.read("n1", { limit: 4 });
    assert.equal(page?.body, "abcd");
    assert.equal(page?.total, 10);
    assert.equal(page?.nextCall, "notes.read(n1@1, offset=4)");
    assert.equal((await store.read("n1", { offset: 4, limit: 4 }))?.body, "efgh");
    assert.equal((await store.read("n1", { offset: 8, limit: 4 }))?.body, "ij");
    assert.equal((await store.read("n1", { offset: 10 }))?.body, "");
    assert.equal(await store.read("n9"), null);
  });

  it("lists revisions oldest first, with their anchors and refs", async () => {
    const { store } = memoryStore(() => 10);
    await store.write({
      title: "a",
      body: "one",
      refs: ["r1"],
      anchor: { window: "c1", event: "r1" },
    });
    await store.write({ title: "b", body: "two", id: "n1", expectedRevision: 1, refs: ["r2"], summary: "two" });

    const page = await store.revisions("n1");
    assert.equal(page.total, 2);
    assert.deepEqual(
      page.items.map((revision) => [revision.revision, revision.summary, revision.window]),
      [
        [1, "one", "c1"],
        [2, "two", null],
      ],
    );
    assert.deepEqual(page.items[0]?.refs, ["r1"]);
    assert.equal(page.items[0]?.anchor?.event, "r1");
    assert.equal(page.nextCall, "notes.revisions(n1, offset=20)");
    assert.equal((await store.revisions("n9")).total, 0);
  });

  it("restores the surroundings of a revision", async () => {
    const { store, journal } = memoryStore(() => 100);
    const before = await journal.append({ kind: "input", window: "c1", body: "the question" });
    const after = await journal.append({ kind: "tool_result", window: "c1", body: "the answer" });
    await store.write({
      title: "a",
      body: "one",
      anchor: { window: "c1", event: before.ref, evidence: [after.ref] },
    });

    const context = await store.context("n1");
    assert.equal(context?.revision, 1);
    assert.equal(context?.anchor?.event, before.ref);
    // The events around the one the anchor names, plus the write's own event.
    assert.deepEqual(context?.events, [before.ref, after.ref, "r3"]);
    assert.deepEqual(context?.evidence, [after.ref]);
    assert.equal(await store.context("n9"), null);
  });

  it("counts a read as usage the active set is scored by", async () => {
    const { store } = memoryStore();
    await store.write({ title: "a", body: "one" });
    await store.write({ title: "b", body: "two" });
    await store.read("n1");

    const scores = await store.score();
    const byId = new Map(scores.items.map((item) => [item.id, item.score]));
    assert.ok((byId.get("n1") ?? 0) > 0);
    assert.equal(byId.get("n2"), 0);
  });
});

describe("search", () => {
  it("finds a note by an exact substring of its title, summary or body", async () => {
    const { store } = memoryStore();
    await store.write({ title: "部署上线", body: "the runbook", summary: "上线流程" });
    await store.write({ title: "other", body: "nothing here" });

    assert.equal((await store.search({ query: "上线" })).total, 1);
    assert.equal((await store.search({ query: "上线流程" })).total, 1);
    assert.equal((await store.search({ query: "runbook" })).total, 1);
    // A one-character query has no trigram of its own and falls back to a scan.
    assert.equal((await store.search({ query: "署" })).total, 1);
    assert.equal((await store.search({ query: "missing" })).total, 0);
    assert.equal((await store.search({})).total, 2);
    assert.equal((await store.search({ status: "active" })).total, 0);
  });

  it("filters by status and visibility", async () => {
    const { store } = memoryStore();
    await store.write({ title: "a", body: "one", visibility: "private" });
    await store.write({ title: "b", body: "two" });

    assert.equal((await store.search({ visibility: "private" })).total, 1);
    assert.equal((await store.search({ visibility: "shared" })).total, 1);
    assert.equal((await store.search({ visibility: "private", query: "two" })).total, 0);
  });

  it("finds the notes about a target, and the notes linked to a ref", async () => {
    const { store, journal } = memoryStore();
    const issue = await journal.append({
      kind: "input",
      window: "c1",
      body: "the report",
      targets: ["gh:issue:42"],
    });
    await store.write({
      title: "a",
      body: "one",
      refs: [issue.ref],
      anchor: { window: "c1", event: issue.ref, evidence: [issue.ref] },
    });
    await journal.append({
      kind: "input",
      window: "c1",
      body: "the follow-up",
      targets: ["gh:issue:42"],
      refs: ["n1@1"],
    });

    const about = await store.search({ about: "gh:issue:42" });
    assert.equal(about.total, 1);
    assert.equal(about.items[0]?.id, "n1");

    const linked = await store.search({ linked: issue.ref });
    assert.equal(linked.total, 1);
    assert.equal(linked.items[0]?.id, "n1");

    assert.equal((await store.search({ about: "gh:issue:42", linked: issue.ref })).total, 1);
    assert.equal((await store.search({ about: "gh:issue:42", linked: "r99" })).total, 0);
    assert.equal((await store.search({ about: "gh:issue:42", query: "one" })).total, 1);
    assert.equal((await store.search({ about: "gh:issue:42", query: "missing" })).total, 0);
  });

  it("pages a text search and reports the bound", async () => {
    const { store } = memoryStore();
    for (let index = 1; index <= 3; index += 1) {
      await store.write({ title: `note ${index}`, body: "the same words" });
    }

    const page = await store.search({ query: "words", limit: 2 });
    assert.equal(page.total, 3);
    assert.equal(page.limit, 2);
    assert.deepEqual(
      page.items.map((item) => item.id),
      ["n1", "n2"],
    );
    assert.equal(page.nextCall, 'notes.search(query="words", offset=2)');
    const rest = await store.search({ query: "words", limit: 2, offset: 2 });
    assert.deepEqual(
      rest.items.map((item) => item.id),
      ["n3"],
    );
  });
});

describe("the active set and its epochs", () => {
  it("builds an epoch, and freezes it while the interval has not passed", async () => {
    const { store } = clockStore();
    await store.write({ title: "a", body: "one" });
    await store.recordUse({ ref: "n1", kind: "cite", event: "r1", weight: 1 });

    const first = await store.snapshot({ minIntervalMs: 600_000 });
    assert.equal(first.epoch, 1);
    assert.equal(first.items.length, 1);
    assert.equal(first.items[0]?.ref, "n1@1");
    assert.equal(first.items[0]?.status, "active");
    assert.equal(first.nextCall, "notes.delta(1)");
    assert.deepEqual(first.budget, { count: 40, tokens: 8000 });

    // A write during the epoch does not change the frozen snapshot.
    await store.write({ title: "b", body: "two" });
    const again = await store.snapshot({ minIntervalMs: 600_000 });
    assert.equal(again.epoch, 1);
    assert.deepEqual(again.items, first.items);
  });

  it("keeps the frozen summaries when a note in the set is revised", async () => {
    const { store } = clockStore();
    await store.write({ title: "a", body: "one" });
    await store.recordUse({ ref: "n1", kind: "cite", event: "r1", weight: 1 });
    const first = await store.snapshot();

    await store.write({ title: "a", summary: "revised summary", body: "three", id: "n1", expectedRevision: 1 });
    const frozen = await store.snapshot();
    assert.equal(frozen.epoch, first.epoch);
    assert.equal(frozen.items[0]?.summary, "one");
    assert.equal(frozen.items[0]?.revision, 1);
    // The current state is what a list shows.
    assert.equal((await store.search({ status: "active" })).items[0]?.summary, "revised summary");
  });

  it("builds a new epoch after the interval, and reports what changed since the old one", async () => {
    const { store, advance } = clockStore();
    await store.write({ title: "a", body: "one" });
    await store.recordUse({ ref: "n1", kind: "cite", event: "r1", weight: 1 });
    const first = await store.snapshot({ minIntervalMs: 600_000 });
    await store.write({ title: "b", body: "two" });

    advance(600_001);
    const next = await store.snapshot({ minIntervalMs: 600_000 });
    assert.equal(next.epoch, 2);
    assert.equal(next.items[0]?.revision, 1);

    const delta = await store.delta(first.epoch);
    assert.equal(delta.since, first.epoch);
    assert.equal(delta.epoch, 2);
    assert.deepEqual(
      delta.items.map((item) => [item.id, item.change, item.revision]),
      [["n2", "created", 1]],
    );
    assert.equal(delta.nextCall, "notes.delta(1, offset=20)");

    // Nothing was written since the epoch was built, so it is not rebuilt.
    const same = await store.snapshot({ minIntervalMs: 600_000 });
    assert.equal(same.epoch, 2);
    assert.deepEqual(same.items, next.items);
  });

  it("reports a revision and a deletion in the delta, and drops a deleted note from the set", async () => {
    const { store, advance } = clockStore();
    await store.write({ title: "a", body: "one" });
    await store.write({ title: "b", body: "two" });
    await store.recordUse({ ref: "n1", kind: "cite", event: "r1", weight: 1 });
    const first = await store.snapshot({ minIntervalMs: 600_000 });
    await store.write({ title: "a", body: "revised", summary: "revised", id: "n1", expectedRevision: 1 });
    await store.write({ title: "b", body: "", id: "n2", delete: true, expectedRevision: 1 });

    advance(600_001);
    const next = await store.snapshot({ minIntervalMs: 600_000 });
    assert.deepEqual(
      next.items.map((item) => item.id),
      ["n1"],
    );

    const delta = await store.delta(first.epoch);
    assert.deepEqual(
      delta.items.map((item) => [item.id, item.change]),
      [
        ["n1", "revised"],
        ["n2", "deleted"],
      ],
    );
  });

  it("refuses a delta for an epoch that is not there", async () => {
    const { store } = clockStore();
    await store.write({ title: "a", body: "one" });
    await assert.rejects(() => store.delta(9), refused("note.delta.epoch"));
    // Zero asks for every note, which is what a window with no epoch needs.
    assert.equal((await store.delta(0)).total, 1);
  });

  it("bounds the active set by its count and its token budget", async () => {
    const { store } = memoryStore();
    for (let index = 1; index <= 4; index += 1) {
      await store.write({ title: `note ${index}`, body: `body ${index}` });
      await store.recordUse({ ref: `n${index}` as NoteRef, kind: "cite", event: `r${index}` as EventRef });
    }

    const byCount = await store.snapshot({ budget: { count: 2, tokens: 10_000 } });
    assert.deepEqual(
      byCount.items.map((item) => item.id),
      ["n1", "n2"],
    );
    assert.equal(byCount.total, 2);
  });

  it("leaves the active set empty when the budget holds nothing", async () => {
    const { store, advance } = clockStore();
    await store.write({ title: "a", body: "one" });
    await store.recordUse({ ref: "n1", kind: "cite", event: "r1", weight: 1 });
    assert.equal((await store.snapshot()).items.length, 1);

    advance(600_001);
    const tight = await store.snapshot({ budget: { count: 10, tokens: 0 } });
    assert.equal(tight.items.length, 0);
    assert.equal((await store.active()).total, 0);
  });

  it("adds the judge's bounded share, and never outweighs the model's own use", async () => {
    const { store, advance } = clockStore();
    await store.write({ title: "a", body: "one" });
    await store.write({ title: "b", body: "two" });
    await store.recordUse({ ref: "n1", kind: "cite", event: "r1", weight: 1 });

    const alone = await store.snapshot({ budget: { count: 2, tokens: 10_000 }, judgeShare: 0 });
    assert.deepEqual(
      alone.items.map((item) => item.id),
      ["n1"],
    );

    advance(600_001);
    // A note was written since the epoch was built, so the next one is built
    // with the judge's answer.
    await store.write({ title: "c", body: "three" });
    const withJudge = await store.snapshot({
      budget: { count: 2, tokens: 10_000 },
      judgeKeep: ["n2"],
      judgeShare: 0.5,
    });
    assert.deepEqual(
      withJudge.items.map((item) => item.id),
      ["n1", "n2"],
    );

    // Half of a budget of two is one note, so the judge adds one and no more.
    advance(600_001);
    await store.write({ title: "d", body: "four" });
    const stillOne = await store.snapshot({
      budget: { count: 2, tokens: 10_000 },
      judgeKeep: ["n2", "n3"],
      judgeShare: 0.5,
    });
    assert.deepEqual(
      stillOne.items.map((item) => item.id),
      ["n1", "n2"],
    );
  });

  it("ignores a judge's note that is not there", async () => {
    const { store } = clockStore();
    await store.write({ title: "a", body: "one" });
    await store.recordUse({ ref: "n1", kind: "cite", event: "r1", weight: 1 });
    const snapshot = await store.snapshot({
      budget: { count: 2, tokens: 10_000 },
      judgeKeep: ["n9", "nonsense" as NoteRef],
      judgeShare: 1,
    });
    assert.deepEqual(
      snapshot.items.map((item) => item.id),
      ["n1"],
    );
  });
});

describe("credit through links", () => {
  it("flows through evidence links up to three hops, decaying 50/25/12.5", async () => {
    const { store } = memoryStore();
    await store.write({ title: "one", body: "one" });
    await store.write({ title: "two", body: "two", anchor: { window: "c1", event: "r1", evidence: ["n1@1"] } });
    await store.write({ title: "three", body: "three", anchor: { window: "c1", event: "r2", evidence: ["n2@1"] } });
    await store.write({ title: "four", body: "four", anchor: { window: "c1", event: "r3", evidence: ["n3@1"] } });
    await store.write({ title: "five", body: "five", anchor: { window: "c1", event: "r4", evidence: ["n4@1"] } });
    await store.recordUse({ ref: "n1", kind: "cite", event: "r9", weight: 1 });

    const byId = new Map((await store.score()).items.map((item) => [item.id, item.score]));
    assert.equal(byId.get("n1"), 1);
    assert.equal(byId.get("n2"), 0.5);
    assert.equal(byId.get("n3"), 0.25);
    assert.equal(byId.get("n4"), 0.125);
    // A fourth hop is past the bound.
    assert.equal(byId.get("n5"), 0);
  });

  it("gives a note its direct credit or its linked share, whichever is larger", async () => {
    const { store } = memoryStore();
    await store.write({ title: "one", body: "one" });
    await store.write({ title: "two", body: "two", anchor: { window: "c1", event: "r1", evidence: ["n1@1"] } });
    await store.recordUse({ ref: "n1", kind: "cite", event: "r9", weight: 1 });
    await store.recordUse({ ref: "n2", kind: "cite", event: "r10", weight: 2 });

    const byId = new Map((await store.score()).items.map((item) => [item.id, item.score]));
    assert.equal(byId.get("n1"), 1);
    assert.equal(byId.get("n2"), 2);
  });

  it("records one use per event, so a redelivered one is not counted twice", async () => {
    const { store } = memoryStore();
    await store.write({ title: "a", body: "one" });
    await store.recordUse({ ref: "n1", kind: "cite", event: "r1", weight: 1 });
    await store.recordUse({ ref: "n1", kind: "cite", event: "r1", weight: 1 });

    const scores = await store.score();
    assert.equal(scores.items.find((item) => item.id === "n1")?.score, 1);
  });

  it("lets a deleted note earn nothing and pass nothing on", async () => {
    const { store } = memoryStore();
    await store.write({ title: "one", body: "one" });
    await store.write({ title: "two", body: "two", anchor: { window: "c1", event: "r1", evidence: ["n1@1"] } });
    await store.recordUse({ ref: "n1", kind: "cite", event: "r9", weight: 1 });
    assert.equal((await store.score()).items.find((item) => item.id === "n2")?.score, 0.5);

    await store.write({ title: "one", body: "", id: "n1", delete: true, expectedRevision: 1 });
    const byId = new Map((await store.score()).items.map((item) => [item.id, item.score]));
    assert.equal(byId.has("n1"), false);
    assert.equal(byId.get("n2"), 0);
  });

  it("decays a use by its age", async () => {
    const { store, advance } = clockStore();
    await store.write({ title: "a", body: "one" });
    await store.recordUse({ ref: "n1", kind: "cite", event: "r1", weight: 1 });
    assert.equal((await store.score()).items[0]?.score, 1);

    // One half-life later, half of it is left.
    advance(86_400_000);
    assert.equal((await store.score()).items[0]?.score, 0.5);
  });
});

describe("the store itself", () => {
  it("keeps the notes and their epochs across a restart of the host", async () => {
    const directory = await mkdtemp(join(tmpdir(), "arbor-notes-test-"));
    try {
      const journal = new SqliteJournal({ path: join(directory, "journal.db") });
      const first = new SqliteNoteStore({ journal, path: join(directory, "notes.db") });
      await first.write({ title: "a", body: "one" });
      await first.recordUse({ ref: "n1", kind: "cite", event: "r1", weight: 1 });
      const epoch = await first.snapshot();
      await first.close();

      const second = new SqliteNoteStore({ journal, path: join(directory, "notes.db") });
      assert.equal((await second.read("n1"))?.ref, "n1@1");
      const again = await second.snapshot();
      assert.equal(again.epoch, epoch.epoch);
      assert.deepEqual(again.items, epoch.items);
      assert.equal((await second.delta(0)).total, 1);

      await second.close();
      await journal.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("refuses a read after the store is closed", async () => {
    const { store, journal } = memoryStore();
    await store.close();
    await assert.rejects(() => store.write({ title: "a", body: "one" }), refused("note.closed"));
    await assert.rejects(() => store.read("n1"), refused("note.closed"));
    await journal.close();
  });
});
