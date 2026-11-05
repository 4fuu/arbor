/**
 * The registry: which arbor ref names which LayerFS Branch and Commit.
 *
 * Arbor's refs are stable and the service layer records a snapshot's ref on the
 * event that changed the files; a LayerFS Commit id is not a ref and cannot be
 * recorded anywhere the core can see (docs/architecture.md#interfaces). So this
 * package keeps the mapping itself, in one small SQLite file beside the LayerFS
 * Store. It is the only place a LayerFS id is written down.
 *
 * Two tables: one row per window workspace, and one row per snapshot the
 * service layer recorded at an event. Nothing here is a cache of LayerFS
 * state: the Branches and Commits are LayerFS's, the refs are arbor's, and
 * losing this file stops `ws3@r902` from resolving while the history itself
 * stays in the Store.
 */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { EventRef, WorkspaceRef } from "@arbor/interfaces";
import { branchNameOf, workspaceRefOf } from "./refs.ts";

/** One window's directory, as this package knows it. */
export interface WorkspaceRecord {
  ref: WorkspaceRef;
  /** The LayerFS Branch that holds it. */
  branch: string;
  /** The window the directory was created or forked for. */
  window: string;
  /** The workspace this one was forked from, when it was a continuation. */
  forkedFrom: WorkspaceRef | null;
  createdAt: number;
  reclaimedAt: number | null;
}

/** One snapshot, recorded at one event. */
export interface SnapshotRecord {
  workspace: WorkspaceRef;
  /** The event that recorded the change, or `latest` for an unlabelled one. */
  at: EventRef | "latest";
  /** The LayerFS Commit. Never leaves this package. */
  commit: string;
  time: number;
}

const STATEMENTS: readonly string[] = [
  `PRAGMA journal_mode = WAL`,
  `PRAGMA foreign_keys = ON`,
  `PRAGMA busy_timeout = 5000`,
  `CREATE TABLE IF NOT EXISTS workspace (
     ref TEXT PRIMARY KEY,
     branch TEXT NOT NULL,
     window TEXT NOT NULL,
     forked_from TEXT,
     created_at INTEGER NOT NULL,
     reclaimed_at INTEGER
   )`,
  `CREATE TABLE IF NOT EXISTS snapshot (
     workspace TEXT NOT NULL,
     at TEXT NOT NULL,
     commit_id TEXT NOT NULL,
     time INTEGER NOT NULL,
     PRIMARY KEY (workspace, at)
   )`,
  `CREATE INDEX IF NOT EXISTS snapshot_order ON snapshot (workspace, time DESC)`,
];

export class Registry {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    for (const statement of STATEMENTS) this.db.exec(statement);
  }

  close(): void {
    this.db.close();
  }

  /**
   * The next workspace ref, and the Branch it will hold. Numbers only grow:
   * a reclaimed workspace keeps its row, so a ref that once resolved keeps
   * naming the same directory's history even after its snapshots are gone.
   */
  allocate(window: string, forkedFrom: WorkspaceRef | null): WorkspaceRecord {
    const row = this.db.prepare(`SELECT MAX(CAST(SUBSTR(ref, 3) AS INTEGER)) AS top FROM workspace`).get() as {
      top: number | null;
    };
    const ref = workspaceRefOf((row.top ?? 0) + 1);
    const record: WorkspaceRecord = {
      ref,
      branch: branchNameOf(ref),
      window,
      forkedFrom,
      createdAt: Date.now(),
      reclaimedAt: null,
    };
    this.db
      .prepare(
        `INSERT INTO workspace (ref, branch, window, forked_from, created_at, reclaimed_at)
         VALUES (?, ?, ?, ?, ?, NULL)`,
      )
      .run(record.ref, record.branch, record.window, record.forkedFrom, record.createdAt);
    return record;
  }

  workspace(ref: WorkspaceRef): WorkspaceRecord | null {
    const row = this.db
      .prepare(`SELECT ref, branch, window, forked_from, created_at, reclaimed_at FROM workspace WHERE ref = ?`)
      .get(ref) as
      | { ref: string; branch: string; window: string; forked_from: string | null; created_at: number; reclaimed_at: number | null }
      | undefined;
    if (row === undefined) return null;
    return {
      ref: row.ref as WorkspaceRef,
      branch: row.branch,
      window: row.window,
      forkedFrom: row.forked_from as WorkspaceRef | null,
      createdAt: row.created_at,
      reclaimedAt: row.reclaimed_at,
    };
  }

  /** Every workspace, oldest first. */
  workspaces(): WorkspaceRecord[] {
    const rows = this.db
      .prepare(`SELECT ref, branch, window, forked_from, created_at, reclaimed_at FROM workspace ORDER BY created_at, ref`)
      .all() as {
      ref: string;
      branch: string;
      window: string;
      forked_from: string | null;
      created_at: number;
      reclaimed_at: number | null;
    }[];
    return rows.map((row) => ({
      ref: row.ref as WorkspaceRef,
      branch: row.branch,
      window: row.window,
      forkedFrom: row.forked_from as WorkspaceRef | null,
      createdAt: row.created_at,
      reclaimedAt: row.reclaimed_at,
    }));
  }

  /**
   * Record the Commit one event's snapshot holds. Recording the same event
   * twice is the same snapshot: an append and its snapshot are two steps, and
   * a retry must not fork the history.
   */
  recordSnapshot(workspace: WorkspaceRef, at: EventRef | "latest", commit: string, time: number): SnapshotRecord {
    this.db
      .prepare(
        `INSERT INTO snapshot (workspace, at, commit_id, time) VALUES (?, ?, ?, ?)
         ON CONFLICT (workspace, at) DO NOTHING`,
      )
      .run(workspace, at, commit, time);
    const found = this.snapshot(workspace, at);
    if (found === null) throw new Error(`snapshot ${workspace}@${at} was not recorded`);
    return found;
  }

  snapshot(workspace: WorkspaceRef, at: EventRef | "latest"): SnapshotRecord | null {
    const row = this.db
      .prepare(`SELECT workspace, at, commit_id, time FROM snapshot WHERE workspace = ? AND at = ?`)
      .get(workspace, at) as { workspace: string; at: string; commit_id: string; time: number } | undefined;
    if (row === undefined) return null;
    return {
      workspace: row.workspace as WorkspaceRef,
      at: row.at as EventRef | "latest",
      commit: row.commit_id,
      time: row.time,
    };
  }

  /** A workspace's snapshots, newest first. */
  snapshots(workspace: WorkspaceRef, options?: { limit?: number; offset?: number }): SnapshotRecord[] {
    const limit = Math.max(0, Math.trunc(options?.limit ?? Number.MAX_SAFE_INTEGER));
    const offset = Math.max(0, Math.trunc(options?.offset ?? 0));
    const rows = this.db
      .prepare(
        `SELECT workspace, at, commit_id, time FROM snapshot
         WHERE workspace = ? ORDER BY time DESC, at DESC LIMIT ? OFFSET ?`,
      )
      .all(workspace, limit, offset) as { workspace: string; at: string; commit_id: string; time: number }[];
    return rows.map((row) => ({
      workspace: row.workspace as WorkspaceRef,
      at: row.at as EventRef | "latest",
      commit: row.commit_id,
      time: row.time,
    }));
  }

  /**
   * Forget one workspace and its snapshots. Only for a workspace whose Branch
   * was never created: a reclaimed workspace keeps its row, so its number is
   * never handed to another window.
   */
  drop(ref: WorkspaceRef): void {
    this.db.prepare(`DELETE FROM snapshot WHERE workspace = ?`).run(ref);
    this.db.prepare(`DELETE FROM workspace WHERE ref = ?`).run(ref);
  }

  /**
   * Mark one workspace reclaimed: its snapshots stop resolving, and its ref
   * keeps its row so the number is never used again.
   */
  markReclaimed(ref: WorkspaceRef, at: number): void {
    this.db.prepare(`DELETE FROM snapshot WHERE workspace = ?`).run(ref);
    this.db.prepare(`UPDATE workspace SET reclaimed_at = ? WHERE ref = ?`).run(at, ref);
  }
}
