import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { blobIdOf } from "./blob-store.ts";
import { SqliteJournal } from "./sqlite-journal.ts";

async function temporaryDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), "arbor-blob-test-"));
}

describe("blob store", () => {
  it("stores media once by content and hands back a ref an event can carry", async () => {
    const journal = new SqliteJournal({ path: ":memory:" });
    try {
      const first = await journal.blobs.put({ data: "the same bytes", mime: "image/png" });
      const again = await journal.blobs.put({ data: "the same bytes", mime: "image/png" });
      const other = await journal.blobs.put({ data: "other bytes" });

      assert.equal(first, "b1");
      assert.equal(again, first);
      assert.equal(other, "b2");

      const content = await journal.blobs.get(first);
      assert.equal(new TextDecoder().decode(content?.data), "the same bytes");
      assert.equal(content?.mime, "image/png");

      const stat = await journal.blobs.stat(first);
      assert.equal(stat?.size, 14);
      assert.equal(stat?.mime, "image/png");
      assert.equal(await journal.blobs.has("b2"), true);
    } finally {
      await journal.close();
    }
  });

  it("keeps the bytes beside the database, not in it", async () => {
    const directory = await temporaryDirectory();
    try {
      const journal = new SqliteJournal({ path: join(directory, "journal.db") });
      const ref = await journal.blobs.put({ data: "beside the database" });
      const event = await journal.append({
        kind: "input",
        window: "c1",
        body: "a picture",
        blobs: [ref],
      });
      await journal.close();

      assert.deepEqual(event.blobs, [ref]);
      const stored = await readdir(`${directory}/journal.db.blobs`);
      assert.equal(stored.length, 1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("erases the bytes when the event that held them is redacted, and keeps them when another event holds them", async () => {
    const journal = new SqliteJournal({ path: ":memory:" });
    try {
      const shared = await journal.blobs.put({ data: "shared bytes" });
      const alone = await journal.blobs.put({ data: "lonely bytes" });

      const one = await journal.append({ kind: "input", window: "c1", body: "one", blobs: [shared] });
      await journal.append({ kind: "input", window: "c2", body: "two", blobs: [shared] });
      const only = await journal.append({ kind: "input", window: "c1", body: "three", blobs: [alone] });

      await journal.redact(one.ref, "personal data");
      assert.equal(await journal.blobs.has(shared), true);
      assert.equal((await journal.get(one.ref))?.blobs.length, 0);

      await journal.redact(only.ref, "personal data");
      assert.equal(await journal.blobs.has(alone), false);
      assert.equal(await journal.blobs.get(alone), null);
    } finally {
      await journal.close();
    }
  });

  it("deletes a blob on request and forgets its id", async () => {
    const journal = new SqliteJournal({ path: ":memory:" });
    try {
      const ref = await journal.blobs.put({ data: "bytes" });
      await journal.blobs.delete(ref);
      assert.equal(await journal.blobs.has(ref), false);
      assert.equal(await journal.blobs.stat(ref), null);
      // The id is not reused for different content.
      const next = await journal.blobs.put({ data: "different" });
      assert.notEqual(next, ref);
    } finally {
      await journal.close();
    }
  });

  it("reads an id out of a ref, and refuses one that is not a blob ref", () => {
    assert.equal(blobIdOf("b12"), 12);
    assert.equal(blobIdOf("r12"), null);
  });
});
