import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  parseRef,
  snapshotRefOf,
  viewBranchNameOf,
  workspaceNumberOf,
  workspaceRefOf,
} from "./refs.ts";

describe("refs", () => {
  it("splits a workspace ref, a snapshot ref and the latest snapshot", () => {
    assert.deepEqual(parseRef("ws3"), { workspace: "ws3", at: null });
    assert.deepEqual(parseRef("ws3@r902"), { workspace: "ws3", at: "r902" });
    assert.deepEqual(parseRef("ws3@latest"), { workspace: "ws3", at: "latest" });
  });

  it("refuses anything that is not a workspace or snapshot ref", () => {
    assert.throws(() => parseRef("ws"), /not a workspace ref/);
    assert.throws(() => parseRef("ws3@"), /not a snapshot ref/);
    assert.throws(() => parseRef("ws3@r90x"), /not a snapshot ref/);
    assert.throws(() => parseRef("c41"), /not a workspace ref/);
    assert.throws(() => parseRef("ws3@r902@r1"), /not a snapshot ref/);
  });

  it("names the Branch a workspace holds, and the one a snapshot is read through", () => {
    assert.equal(workspaceNumberOf("ws3"), 3);
    assert.equal(workspaceNumberOf("ws3@r902"), null);
    assert.equal(workspaceRefOf(3), "ws3");
    assert.equal(snapshotRefOf("ws3", "r902"), "ws3@r902");
    assert.equal(snapshotRefOf("ws3", "latest"), "ws3@latest");
    assert.equal(viewBranchNameOf("ws3", "r902"), "ws3-r902-view");
  });

  it("keeps a view Branch's name inside LayerFS's 63 bytes", () => {
    const long = `ws${"9".repeat(60)}` as "ws9";
    const name = viewBranchNameOf(long, "r902");
    assert.ok(name.length <= 63, `${name} is ${name.length} bytes`);
    assert.match(name, /^view-[0-9a-z]+$/);
    // Two different snapshots of one workspace never share a view Branch.
    assert.notEqual(viewBranchNameOf("ws3", "r902"), viewBranchNameOf("ws3", "r903"));
  });

  it("refuses a workspace number that is not a positive integer", () => {
    assert.throws(() => workspaceRefOf(0), RangeError);
    assert.throws(() => workspaceRefOf(-1), RangeError);
    assert.throws(() => workspaceRefOf(1.5), RangeError);
  });
});
