/**
 * The default `NoteStore`: SQLite beside the journal (docs/memory.md).
 *
 * Notes are the long-term memory: one copy of each, shared by every window,
 * written only through the note tools. What this implementation owns:
 *
 * - the one copy, and the checked write: a write, replace or delete names the
 *   revision it read, and a stale one is refused with what changed since -
 *   the revisions in between, their windows and the differences - so the model
 *   merges and writes again. A refused call changes nothing.
 * - revisions, append-only, with the anchor the host recorded and the refs the
 *   write named, so an anchor keeps working after the note is edited, archived
 *   or deleted;
 * - the active set, picked at each snapshot epoch by usage score within a
 *   count and token budget, and frozen with the epoch's version, so every
 *   window opened in one epoch has the same prefix and later windows see the
 *   changes as a delta;
 * - every write recorded in the journal as a `note_revision` event.
 *
 * It is synchronous inside: one `DatabaseSync`, one transaction per write, so
 * the revision a write checks and the revision it writes are one atomic step.
 * Writes are serialised in process as well, because a write spans the notes
 * database and the journal. The interface is asynchronous because a `NoteStore`
 * may live behind a process boundary.
 */

import { DatabaseSync } from "node:sqlite";
import type { SQLInputValue } from "node:sqlite";
import type { ArborError } from "@arbor/errors";
import { arborError, isArborError } from "@arbor/errors";
import { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT } from "@arbor/interfaces";
import type {
  ActiveCandidate,
  ActiveSetBudget,
  Anchor,
  Event,
  Journal,
  LinkInput,
  Note,
  NoteBody,
  NoteContext,
  NoteDelta,
  NoteDeltaItem,
  NoteQuery,
  NoteRef,
  NoteRevision,
  NoteStatus,
  NoteSummary,
  NoteUseInput,
  NoteVisibility,
  NoteWriteInput,
  NotesSnapshot,
  NoteStore,
  Page,
  Ref,
  SnapshotOptions,
  Target,
  WindowRef,
} from "@arbor/interfaces";
import { bodyDiff } from "./diff.ts";
import {
  noteIdOf,
  noteRefOf,
  noteRefForms,
  parseNoteId,
  parseNoteRef,
  storedEventRef,
  storedWindowRef,
} from "./refs.ts";
import { FTS_TABLE, createSchema } from "./schema.ts";
import { USE_WEIGHTS, applyJudgeShare, pickByBudget, scoreNotes } from "./score.ts";
import type { ScoredNote } from "./score.ts";
import type { SubstringClause } from "./search.ts";
import { holdingIds, substringClause } from "./search.ts";

/** A summary is at most this many characters (docs/memory.md). */
export const SUMMARY_LIMIT = 200;

/** How many characters of a body one read returns. */
export const DEFAULT_BODY_LIMIT = 7000;
export const MAX_BODY_LIMIT = 20000;

/** The system prompt and memory snapshot rebuild at most this often. 10 min. */
export const DEFAULT_MIN_INTERVAL_MS = 600_000;

/** The active set's budget, which bounds every prefix. */
export const DEFAULT_ACTIVE_BUDGET: ActiveSetBudget = { count: 40, tokens: 8000 };

/** The share of the budget the judge may add, which never outweighs the model's own use. */
export const DEFAULT_JUDGE_SHARE = 0.15;

/** Usage loses half of its weight this often. */
export const DEFAULT_HALF_LIFE_MS = 86_400_000;

/** How many events one `about` lookup reads. */
const ABOUT_EVENT_LIMIT = 200;

interface NoteRow {
  id: number;
  created: number;
  updated: number;
  revision: number;
  title: string;
  summary: string;
  body: string;
  visibility: string;
  status: string;
  window: string | null;
  anchor: string | null;
  event: string | null;
}

interface RevisionRow {
  wseq: number;
  note: number;
  revision: number;
  title: string;
  summary: string;
  body: string;
  visibility: string;
  deleted: number;
  time: number;
  window: string | null;
  event: string | null;
  anchor: string | null;
  refs: string | null;
}

interface EpochRow {
  epoch: number;
  time: number;
  wseq: number;
  budget_count: number;
  budget_tokens: number;
}

interface SummaryRow {
  id: number;
  revision: number;
  title: string;
  summary: string;
  visibility: string;
  status: string;
  updated: number;
}

interface DeltaRow {
  id: number;
  revision: number;
  title: string;
  summary: string;
  updated: number;
  window: string | null;
  status: string;
  wseq: number;
  created_wseq: number;
}

/** What one write put in place, so a journal failure can take it back out. */
interface Written {
  id: number;
  revision: number;
  created: boolean;
  previous: NoteRow | null;
  time: number;
  title: string;
  summary: string;
  window: WindowRef | null;
  anchor: Anchor | null;
}

export interface SqliteNoteStoreOptions {
  /** A file path, or `:memory:`. */
  path?: string;
  /** The journal every note revision is recorded in, as a `note_revision` event. */
  journal: Journal;
  /** The clock. Tests pass a fixed one. */
  now?: () => number;
  /** Usage loses half of its weight this often. 24 hours. */
  usageHalfLifeMs?: number;
}

function toNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  throw new Error(`notes: storage returned a value that is not a number: ${String(value)}`);
}

/** One transaction: every write is one atomic step of the one copy. */
function inTransaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // The transaction is already gone; the original error is what matters.
    }
    throw error;
  }
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_PAGE_LIMIT;
  return Math.min(Math.max(1, Math.floor(limit)), MAX_PAGE_LIMIT);
}

function clampBodyLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_BODY_LIMIT;
  return Math.min(Math.max(1, Math.floor(limit)), MAX_BODY_LIMIT);
}

/** The opening of a body, when a write carries no summary of its own. */
export function deriveSummary(body: string): string {
  const flat = body.replace(/\s+/g, " ").trim();
  const characters = Array.from(flat);
  return characters.length <= SUMMARY_LIMIT ? flat : `${characters.slice(0, SUMMARY_LIMIT).join("")}…`;
}

function invalidNoteRef(call: string, ref: string): ArborError {
  return arborError({
    code: "invalid_input",
    rule: `note.${call}.ref`,
    message: `note.${call}: ${ref} is not a note ref`,
    nextAction: "pass a note ref such as n012, or one of its revisions such as n012@3",
    details: { ref },
  });
}

function parseOrThrow(ref: string, call: string): { id: number; revision: number | null } {
  const parsed = parseNoteRef(ref);
  if (parsed === null) throw invalidNoteRef(call, ref);
  return parsed;
}

function toSummary(row: SummaryRow): NoteSummary {
  const id = toNumber(row.id);
  const revision = toNumber(row.revision);
  return {
    ref: noteRefOf(id, revision),
    id: noteIdOf(id),
    title: row.title,
    summary: row.summary,
    visibility: row.visibility as NoteVisibility,
    status: row.status as NoteStatus,
    revision,
    time: toNumber(row.updated),
  };
}

function toNote(row: NoteRow): Note {
  const id = toNumber(row.id);
  const revision = toNumber(row.revision);
  return {
    ref: noteRefOf(id, revision),
    id: noteIdOf(id),
    title: row.title,
    summary: row.summary,
    // A deleted note has no current body; its revisions still resolve by ref.
    body: row.status === "deleted" ? null : row.body,
    visibility: row.visibility as NoteVisibility,
    status: row.status as NoteStatus,
    revision,
    ...(row.anchor === null ? {} : { anchor: JSON.parse(row.anchor) as Anchor }),
    time: toNumber(row.updated),
    window: storedWindowRef(row.window),
  };
}

function toNoteRevision(row: RevisionRow): NoteRevision {
  const note = toNumber(row.note);
  const revision = toNumber(row.revision);
  return {
    ref: noteRefOf(note, revision),
    revision,
    window: storedWindowRef(row.window),
    time: toNumber(row.time),
    summary: row.summary,
    ...(row.anchor === null ? {} : { anchor: JSON.parse(row.anchor) as Anchor }),
    refs: row.refs === null ? [] : (JSON.parse(row.refs) as Ref[]),
  };
}

function searchCall(query: NoteQuery, offset: number, limit: number): string {
  const parts: string[] = [];
  if (query.query !== undefined) parts.push(`query=${JSON.stringify(query.query)}`);
  if (query.status !== undefined) parts.push(`status=${query.status}`);
  if (query.visibility !== undefined) parts.push(`visibility=${query.visibility}`);
  if (query.about !== undefined) parts.push(`about=${query.about}`);
  if (query.linked !== undefined) parts.push(`linked=${query.linked}`);
  parts.push(`offset=${offset + limit}`);
  return `notes.search(${parts.join(", ")})`;
}

export class SqliteNoteStore implements NoteStore {
  readonly path: string;

  private readonly db: DatabaseSync;
  private readonly journal: Journal;
  private readonly clock: () => number;
  private readonly halfLifeMs: number;
  /** One write at a time: a write spans the notes database and the journal. */
  private writeQueue: Promise<unknown> = Promise.resolve();
  private closed = false;

  constructor(options: SqliteNoteStoreOptions) {
    this.path = options.path ?? ":memory:";
    this.db = new DatabaseSync(this.path);
    createSchema(this.db);
    this.journal = options.journal;
    this.clock = options.now ?? (() => Date.now());
    this.halfLifeMs = options.usageHalfLifeMs ?? DEFAULT_HALF_LIFE_MS;
  }

  // --- writes -------------------------------------------------------------

  async write(input: NoteWriteInput): Promise<Note> {
    const run = this.writeQueue.then(() => this.writeOne(input));
    this.writeQueue = run.catch(() => undefined);
    return run;
  }

  private async writeOne(input: NoteWriteInput): Promise<Note> {
    this.ensureOpen();
    this.checkWrite(input);
    const time = this.clock();
    const written = inTransaction(this.db, (): Written => this.place(input, time));
    const noteId = noteIdOf(written.id);
    const noteRef = noteRefOf(written.id, written.revision);

    // The write stands or falls with its journal event: a note revision nobody
    // can find in the record is not a revision.
    let event: Event;
    try {
      event = await this.journal.append({
        kind: "note_revision",
        window: written.window,
        body: `${written.title}\n${written.summary}`,
        targets: [noteId],
        refs: [noteRef, ...(input.refs ?? [])],
        links: [
          { kind: "revision", to: noteRef, weight: 1 },
          ...(written.anchor?.evidence ?? []).map(
            (to): LinkInput => ({ kind: "evidence", to, weight: 1 }),
          ),
        ],
        time: written.time,
      });
    } catch (error) {
      this.takeBack(written);
      // The journal's own refusal travels with this one, so the model reads
      // both the rule that refused the write and what the journal said.
      const detail = isArborError(error)
        ? `${error.rule}: ${error.message}`
        : error instanceof Error
          ? error.message
          : String(error);
      throw arborError({
        code: isArborError(error) ? error.code : "internal",
        rule: "note.write.journal",
        message: `note.write: ${noteRef} was not written because the journal refused the event (${detail})`,
        nextAction: "fix what the journal refused, then write the note again",
        details: { upstream: detail },
        cause: error,
      });
    }

    inTransaction(this.db, () => {
      this.db
        .prepare("UPDATE note_revisions SET event = ? WHERE note = ? AND revision = ?")
        .run(event.ref, written.id, written.revision);
      this.db.prepare("UPDATE notes SET event = ? WHERE id = ?").run(event.ref, written.id);
    });
    return toNote(this.noteRow(written.id) as NoteRow);
  }

  /** The rules a write has to meet before it touches the one copy. */
  private checkWrite(input: NoteWriteInput): void {
    if (input.title.trim() === "") {
      throw arborError({
        code: "invalid_input",
        rule: "note.write.title",
        message: "note.write: a note needs a title",
        nextAction: "give the note a short title",
      });
    }
    if (input.delete !== true && input.body.trim() === "") {
      throw arborError({
        code: "invalid_input",
        rule: "note.write.body",
        message: "note.write: a note needs a body",
        nextAction: "write what the note holds in body; a delete needs no body",
      });
    }
    if (input.summary !== undefined && Array.from(input.summary).length > SUMMARY_LIMIT) {
      throw arborError({
        code: "invalid_input",
        rule: "note.write.summary",
        message: `note.write: a summary is at most ${SUMMARY_LIMIT} characters`,
        nextAction: `shorten the summary to at most ${SUMMARY_LIMIT} characters, or omit it`,
      });
    }
    if (input.id === undefined && input.expectedRevision !== undefined) {
      throw arborError({
        code: "invalid_input",
        rule: "note.write.expected_revision",
        message: "note.write: a new note has no revision to name",
        nextAction: "omit expectedRevision to write a new note, or pass the note's id to replace it",
      });
    }
  }

  /** The one atomic step: check the revision, then place the revision. */
  private place(input: NoteWriteInput, time: number): Written {
    let previous: NoteRow | null = null;
    let id: number;
    let revision: number;
    let created = false;

    if (input.id === undefined) {
      id = 0;
      revision = 1;
      created = true;
    } else {
      const parsed = parseNoteId(input.id);
      if (parsed === null) throw invalidNoteRef("write", input.id);
      previous = this.noteRow(parsed);
      if (previous === null) {
        throw arborError({
          code: "not_found",
          rule: "note.write.note",
          message: `note.write: ${input.id} is not in the notes`,
          nextAction: "omit id to write a new note, or look the note up with notes.search",
        });
      }
      if (previous.status === "deleted") {
        throw arborError({
          code: "not_found",
          rule: "note.write.deleted",
          message: `note.write: ${input.id} is deleted`,
          nextAction: "its revisions still resolve by ref, but it cannot be written; write a new note instead",
        });
      }
      const expected = input.expectedRevision;
      if (expected === undefined) {
        throw arborError({
          code: "invalid_input",
          rule: "note.write.revision",
          message: `note.write: ${input.id} is at revision ${previous.revision}; a write names the revision it read`,
          nextAction: `read the note and write again against revision ${previous.revision}`,
        });
      }
      if (expected > previous.revision) {
        throw arborError({
          code: "invalid_input",
          rule: "note.write.revision",
          message: `note.write: ${input.id}@${expected} does not exist; the note is at revision ${previous.revision}`,
          nextAction: `read the note and write again against revision ${previous.revision}`,
        });
      }
      if (expected < previous.revision) throw this.conflict(previous, expected);
      id = parsed;
      revision = previous.revision + 1;
      // A replace that changes the body names a summary, so a list never shows
      // yesterday's line on today's note.
      if (
        input.delete !== true &&
        input.summary === undefined &&
        input.body !== previous.body
      ) {
        throw arborError({
          code: "invalid_input",
          rule: "note.write.summary",
          message: `note.write: a replace that changes the body of ${input.id} names a summary`,
          nextAction: `write a summary of at most ${SUMMARY_LIMIT} characters for the new body`,
        });
      }
    }

    const anchor = input.anchor ?? null;
    const deleted = input.delete === true;
    // A replace that names no summary or visibility keeps the ones it has.
    const summary = input.summary ?? (previous === null ? deriveSummary(input.body) : previous.summary);
    const visibility = input.visibility ?? (previous === null ? "shared" : (previous.visibility as NoteVisibility));
    const status: NoteStatus = deleted ? "deleted" : ((previous?.status as NoteStatus | undefined) ?? "archived");
    const body = deleted ? "" : input.body;
    const refs =
      input.refs === undefined || input.refs.length === 0 ? null : JSON.stringify([...input.refs]);
    const anchorJson = anchor === null ? null : JSON.stringify(anchor);
    const window = anchor?.window ?? null;

    if (created) {
      const info = this.db
        .prepare(
          `INSERT INTO notes (created, updated, revision, title, summary, body, visibility, status, window, anchor, event)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
        )
        .run(time, time, revision, input.title, summary, body, visibility, status, window, anchorJson);
      id = toNumber(info.lastInsertRowid);
    } else {
      this.db
        .prepare(
          `UPDATE notes SET updated = ?, revision = ?, title = ?, summary = ?, body = ?, visibility = ?,
                             status = ?, window = ?, anchor = ?, event = NULL
           WHERE id = ?`,
        )
        .run(time, revision, input.title, summary, body, visibility, status, window, anchorJson, id);
    }

    this.db
      .prepare(
        `INSERT INTO note_revisions (note, revision, title, summary, body, visibility, deleted, time, window, event, anchor, refs)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      )
      .run(id, revision, input.title, summary, body, visibility, deleted ? 1 : 0, time, window, anchorJson, refs);

    // The search index holds the current state; a deleted note is not found.
    this.db.prepare(`DELETE FROM ${FTS_TABLE} WHERE rowid = ?`).run(id);
    if (!deleted) {
      this.db
        .prepare(`INSERT INTO ${FTS_TABLE} (rowid, title, summary, body) VALUES (?, ?, ?, ?)`)
        .run(id, input.title, summary, body);
    }

    // The refs the revision names: what it cites and what it holds as
    // evidence. The evidence ones between notes are what the credit walk
    // follows, and every one of them answers a `linked` lookup.
    const insertRef = this.db.prepare(
      `INSERT OR IGNORE INTO note_refs (note, revision, kind, ref, to_note, weight, time)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const named = (ref: string, kind: "cite" | "evidence", weight: number): void => {
      const toNote = parseNoteId(ref);
      insertRef.run(id, revision, kind, ref, toNote, weight, time);
    };
    for (const ref of input.refs ?? []) named(ref, "cite", USE_WEIGHTS.cite);
    for (const ref of anchor?.evidence ?? []) named(ref, "evidence", USE_WEIGHTS.evidence);

    return {
      id,
      revision,
      created,
      previous,
      time,
      title: input.title,
      summary,
      window,
      anchor,
    };
  }

  /** Undo a placed revision whose journal event was refused. */
  private takeBack(written: Written): void {
    inTransaction(this.db, () => {
      this.db
        .prepare("DELETE FROM note_revisions WHERE note = ? AND revision = ?")
        .run(written.id, written.revision);
      this.db
        .prepare("DELETE FROM note_refs WHERE note = ? AND revision = ?")
        .run(written.id, written.revision);
      this.db.prepare(`DELETE FROM ${FTS_TABLE} WHERE rowid = ?`).run(written.id);
      if (written.created) {
        this.db.prepare("DELETE FROM notes WHERE id = ?").run(written.id);
        return;
      }
      const previous = written.previous as NoteRow;
      this.db
        .prepare(
          `UPDATE notes SET updated = ?, revision = ?, title = ?, summary = ?, body = ?, visibility = ?,
                             status = ?, window = ?, anchor = ?, event = ?
           WHERE id = ?`,
        )
        .run(
          previous.updated,
          previous.revision,
          previous.title,
          previous.summary,
          previous.body,
          previous.visibility,
          previous.status,
          previous.window,
          previous.anchor,
          previous.event,
          written.id,
        );
      if (previous.status !== "deleted") {
        this.db
          .prepare(`INSERT INTO ${FTS_TABLE} (rowid, title, summary, body) VALUES (?, ?, ?, ?)`)
          .run(written.id, previous.title, previous.summary, previous.body);
      }
    });
  }

  /**
   * The refusal a stale write gets: what changed since the revision it read -
   * the revisions in between, their windows and the differences - so the model
   * merges them and writes again against the current revision.
   */
  private conflict(note: NoteRow, read: number): ArborError {
    const current = note.revision;
    const rows = this.db
      .prepare(
        `SELECT note, revision, title, summary, time, window, anchor, refs FROM note_revisions
         WHERE note = ? AND revision > ? AND revision <= ? ORDER BY revision`,
      )
      .all(note.id, read, current) as unknown as RevisionRow[];
    const revisions = rows.map(toNoteRevision);
    const readRow = this.revisionRow(note.id, read);
    const diff = readRow === null ? null : bodyDiff(readRow.body, note.body);
    return arborError({
      code: "conflict",
      rule: "note.write.stale_revision",
      message: `note.write: ${noteIdOf(note.id)} is at revision ${current}, not the revision ${read} you read; merge what changed and write again`,
      nextAction: `read ${noteIdOf(note.id)}@${current} and the revisions since ${read}, merge them with this write, then write again against revision ${current}`,
      refs: [noteRefOf(note.id, current), ...revisions.map((revision) => revision.ref)],
      details: {
        conflict: { read, current, revisions },
        ...(diff === null ? {} : { diff }),
      },
    });
  }

  // --- reads --------------------------------------------------------------

  async read(ref: NoteRef, options?: { offset?: number; limit?: number }): Promise<NoteBody | null> {
    this.ensureOpen();
    const parsed = parseOrThrow(ref, "read");
    const row =
      parsed.revision === null ? this.latestRevisionRow(parsed.id) : this.revisionRow(parsed.id, parsed.revision);
    if (row === null) return null;

    const characters = Array.from(row.body);
    const offset = Math.max(0, Math.floor(options?.offset ?? 0));
    const limit = clampBodyLimit(options?.limit);
    const page = characters.slice(offset, offset + limit).join("");
    // A read is one of the things the active set is scored by.
    if (page !== "") this.recordRead(parsed.id);
    const out = noteRefOf(parsed.id, toNumber(row.revision));
    return {
      ref: out,
      revision: toNumber(row.revision),
      body: page,
      total: characters.length,
      nextCall: `notes.read(${out}, offset=${offset + limit})`,
    };
  }

  async revisions(ref: NoteRef): Promise<Page<NoteRevision>> {
    this.ensureOpen();
    const parsed = parseOrThrow(ref, "revisions");
    const limit = DEFAULT_PAGE_LIMIT;
    const nextCall = `notes.revisions(${noteIdOf(parsed.id)}, offset=${limit})`;
    const note = this.noteRow(parsed.id);
    if (note === null) return { items: [], total: 0, limit, nextCall };
    const rows = this.db
      .prepare(
        `SELECT note, revision, title, summary, time, window, anchor, refs FROM note_revisions
         WHERE note = ? ORDER BY revision LIMIT ?`,
      )
      .all(parsed.id, limit) as unknown as RevisionRow[];
    return { items: rows.map(toNoteRevision), total: note.revision, limit, nextCall };
  }

  async search(query: NoteQuery = {}): Promise<Page<NoteSummary>> {
    this.ensureOpen();
    const limit = clampLimit(query.limit);
    const offset = Math.max(0, Math.floor(query.offset ?? 0));
    const text = (query.query ?? "").trim();

    // `about` and `linked` bound the result to the notes the journal resolved,
    // in weight order; a text match narrows that set.
    if (query.about !== undefined || query.linked !== undefined) {
      const ordered = await this.linkedNoteIds(query.about, query.linked);
      const holding = text === "" ? null : new Set(holdingIds(this.db, text, ordered));
      const chosen = holding === null ? ordered : ordered.filter((id) => holding.has(id));
      const page = this.summaryPageByIds(chosen, query, limit, offset);
      return { ...page, nextCall: searchCall(query, offset, limit) };
    }

    const match = text === "" ? null : substringClause(text);
    const page = this.summaryPageBySql(query, limit, offset, match);
    return { ...page, nextCall: searchCall(query, offset, limit) };
  }

  async active(): Promise<Page<NoteSummary>> {
    const snapshot = await this.snapshot();
    return {
      items: [...snapshot.items],
      total: snapshot.total,
      limit: snapshot.budget.count,
      nextCall: `notes.active(offset=${snapshot.total})`,
    };
  }

  async context(ref: NoteRef): Promise<NoteContext | null> {
    this.ensureOpen();
    const parsed = parseOrThrow(ref, "context");
    const note = this.noteRow(parsed.id);
    if (note === null) return null;
    const row = this.revisionRow(parsed.id, parsed.revision ?? note.revision);
    if (row === null) return null;

    const anchor = row.anchor === null ? undefined : (JSON.parse(row.anchor) as Anchor);
    // The surroundings of a revision are the events around the one its anchor
    // names, or around the write's own event when it names none.
    const at = anchor?.event ?? storedEventRef(row.event) ?? undefined;
    const events: string[] = [];
    if (at !== undefined) {
      const around = await this.journal.around(at, { before: 5, after: 5 });
      events.push(...around.map((event) => event.ref));
    }
    return {
      ref: noteRefOf(parsed.id, toNumber(row.revision)),
      revision: toNumber(row.revision),
      ...(anchor === undefined ? {} : { anchor }),
      events,
      evidence: anchor?.evidence ?? [],
    };
  }

  // --- the active set and its epochs -------------------------------------

  async snapshot(options: SnapshotOptions = {}): Promise<NotesSnapshot> {
    this.ensureOpen();
    const now = this.clock();
    const minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
    const budget = options.budget ?? DEFAULT_ACTIVE_BUDGET;
    const judgeShare = options.judgeShare ?? DEFAULT_JUDGE_SHARE;
    return inTransaction(this.db, (): NotesSnapshot => {
      const epoch = this.epochAt(now, minIntervalMs, budget, options.judgeKeep ?? [], judgeShare);
      const items = this.epochSummaries(epoch.epoch);
      return {
        epoch: epoch.epoch,
        time: epoch.time,
        items,
        total: items.length,
        limit: items.length,
        nextCall: `notes.delta(${epoch.epoch})`,
        budget,
      };
    });
  }

  async delta(since: number, options?: { limit?: number; offset?: number }): Promise<NoteDelta> {
    this.ensureOpen();
    const limit = clampLimit(options?.limit);
    const offset = Math.max(0, Math.floor(options?.offset ?? 0));
    const epoch = since === 0 ? null : this.epochRow(since);
    if (since !== 0 && epoch === null) {
      throw arborError({
        code: "invalid_input",
        rule: "note.delta.epoch",
        message: `note.delta: epoch ${since} is not in the notes`,
        nextAction: "pass the epoch the window froze, or 0 for every note",
        details: { since },
      });
    }
    const after = epoch?.wseq ?? 0;
    const rows = this.db
      .prepare(
        `SELECT n.id AS id, n.revision AS revision, n.title AS title, n.summary AS summary,
                n.updated AS updated, n.window AS window, n.status AS status,
                r.wseq AS wseq,
                (SELECT MIN(r2.wseq) FROM note_revisions r2 WHERE r2.note = n.id) AS created_wseq
         FROM notes n JOIN note_revisions r ON r.note = n.id AND r.revision = n.revision
         WHERE r.wseq > ? ORDER BY r.wseq LIMIT ? OFFSET ?`,
      )
      .all(after, limit, offset) as unknown as DeltaRow[];
    const total = toNumber(
      (
        this.db
          .prepare(
            `SELECT count(*) AS n FROM notes n
             JOIN note_revisions r ON r.note = n.id AND r.revision = n.revision
             WHERE r.wseq > ?`,
          )
          .get(after) as { n: number }
      ).n,
    );
    const items: NoteDeltaItem[] = rows.map((row) => ({
      ref: noteRefOf(toNumber(row.id), toNumber(row.revision)),
      id: noteIdOf(toNumber(row.id)),
      revision: toNumber(row.revision),
      title: row.title,
      summary: row.summary,
      // A note written after the epoch is new to a window that froze it; one
      // written before it and changed since has been revised.
      change:
        toNumber(row.created_wseq) > after
          ? "created"
          : row.status === "deleted"
            ? "deleted"
            : "revised",
      window: storedWindowRef(row.window),
      time: toNumber(row.updated),
    }));
    const current = this.latestEpoch();
    return {
      since,
      epoch: current?.epoch ?? 0,
      items,
      total,
      limit,
      nextCall: `notes.delta(${since}, offset=${offset + limit})`,
    };
  }

  async score(options?: { limit?: number; offset?: number }): Promise<Page<ActiveCandidate>> {
    this.ensureOpen();
    const limit = clampLimit(options?.limit);
    const offset = Math.max(0, Math.floor(options?.offset ?? 0));
    const scored = scoreNotes(this.db, this.clock(), this.halfLifeMs);
    const page = scored.slice(offset, offset + limit);
    const states = this.noteStatesFor(page.map((item) => item.note));
    const items: ActiveCandidate[] = page.map((item) => ({
      ref: noteRefOf(item.note, states.get(item.note)?.revision ?? 0),
      id: noteIdOf(item.note),
      summary: states.get(item.note)?.summary ?? "",
      score: item.score,
    }));
    return {
      items,
      total: scored.length,
      limit,
      nextCall: `notes.score(offset=${offset + limit})`,
    };
  }

  async recordUse(input: NoteUseInput): Promise<void> {
    this.ensureOpen();
    const parsed = parseOrThrow(input.ref, "recordUse");
    // A use of a note that is not there names a ref that does not resolve; the
    // host's own append must not fail for it.
    if (this.noteRow(parsed.id) === null) return;
    const time = input.time ?? this.clock();
    const weight = input.weight ?? (input.kind === "read" ? USE_WEIGHTS.read : 1);
    inTransaction(this.db, () => {
      if (input.event !== undefined) {
        const existing = this.db
          .prepare("SELECT rowid FROM note_usage WHERE note = ? AND kind = ? AND event = ?")
          .get(parsed.id, input.kind, input.event) as { rowid: number } | undefined;
        if (existing !== undefined) {
          this.db
            .prepare("UPDATE note_usage SET weight = ?, window = ?, time = ? WHERE rowid = ?")
            .run(weight, input.window ?? null, time, toNumber(existing.rowid));
          return;
        }
      }
      this.db
        .prepare("INSERT INTO note_usage (note, kind, weight, window, event, time) VALUES (?, ?, ?, ?, ?, ?)")
        .run(parsed.id, input.kind, weight, input.window ?? null, input.event ?? null, time);
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.writeQueue;
    this.db.close();
  }

  // --- internals ---------------------------------------------------------

  private ensureOpen(): void {
    if (this.closed) {
      throw arborError({
        code: "unavailable",
        rule: "note.closed",
        message: "notes: the note store is closed",
        nextAction: "open a note store before reading or writing",
      });
    }
  }

  private noteRow(id: number): NoteRow | null {
    const row = this.db
      .prepare(
        `SELECT id, created, updated, revision, title, summary, body, visibility, status, window, anchor, event
         FROM notes WHERE id = ?`,
      )
      .get(id) as NoteRow | undefined;
    return row === undefined ? null : row;
  }

  private revisionRow(note: number, revision: number): RevisionRow | null {
    const row = this.db
      .prepare(
        `SELECT wseq, note, revision, title, summary, body, visibility, deleted, time, window, event, anchor, refs
         FROM note_revisions WHERE note = ? AND revision = ?`,
      )
      .get(note, revision) as RevisionRow | undefined;
    return row === undefined ? null : row;
  }

  private latestRevisionRow(note: number): RevisionRow | null {
    const current = this.noteRow(note);
    if (current === null || current.status === "deleted") return null;
    return this.revisionRow(note, current.revision);
  }

  private recordRead(note: number): void {
    this.db
      .prepare(
        `INSERT INTO note_usage (note, kind, weight, window, event, time)
         VALUES (?, 'read', ?, NULL, NULL, ?)`,
      )
      .run(note, USE_WEIGHTS.read, this.clock());
  }

  /** The current summary and revision of several notes, in one read. */
  private noteStatesFor(ids: readonly number[]): Map<number, { summary: string; revision: number }> {
    const states = new Map<number, { summary: string; revision: number }>();
    if (ids.length === 0) return states;
    const rows = this.db
      .prepare(`SELECT id, summary, revision FROM notes WHERE id IN (${ids.map(() => "?").join(", ")})`)
      .all(...ids) as unknown as Array<{ id: number; summary: string; revision: number }>;
    for (const row of rows) {
      states.set(toNumber(row.id), { summary: row.summary, revision: toNumber(row.revision) });
    }
    return states;
  }

  private summaryPageBySql(
    query: NoteQuery,
    limit: number,
    offset: number,
    match: SubstringClause | null,
  ): { items: NoteSummary[]; total: number; limit: number } {
    const clauses: string[] = [];
    const params: SQLInputValue[] = [];
    if (match !== null) {
      clauses.push(match.sql);
      params.push(...match.params);
    }
    if (query.status !== undefined) {
      clauses.push("n.status = ?");
      params.push(query.status);
    }
    if (query.visibility !== undefined) {
      clauses.push("n.visibility = ?");
      params.push(query.visibility);
    }
    const where = clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`;
    const rows = this.db
      .prepare(
        `SELECT n.id AS id, n.revision AS revision, n.title AS title, n.summary AS summary,
                n.visibility AS visibility, n.status AS status, n.updated AS updated
         FROM notes n${where} ORDER BY n.id LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as unknown as SummaryRow[];
    const total = toNumber(
      (
        this.db
          .prepare(`SELECT count(*) AS n FROM notes n${where}`)
          .get(...params) as { n: number }
      ).n,
    );
    return { items: rows.map(toSummary), total, limit };
  }

  private summaryPageByIds(
    ordered: readonly number[],
    query: NoteQuery,
    limit: number,
    offset: number,
  ): { items: NoteSummary[]; total: number; limit: number } {
    if (ordered.length === 0) return { items: [], total: 0, limit };
    const clauses: string[] = [`id IN (${ordered.map(() => "?").join(", ")})`];
    const params: Array<string | number> = [...ordered];
    if (query.status !== undefined) {
      clauses.push("status = ?");
      params.push(query.status);
    }
    if (query.visibility !== undefined) {
      clauses.push("visibility = ?");
      params.push(query.visibility);
    }
    const rows = this.db
      .prepare(
        `SELECT id, revision, title, summary, visibility, status, updated FROM notes
         WHERE ${clauses.join(" AND ")}`,
      )
      .all(...params) as unknown as SummaryRow[];
    const rank = new Map(ordered.map((id, index) => [id, index]));
    const sorted = [...rows].sort(
      (a, b) => (rank.get(toNumber(a.id)) ?? 0) - (rank.get(toNumber(b.id)) ?? 0),
    );
    return { items: sorted.slice(offset, offset + limit).map(toSummary), total: sorted.length, limit };
  }

  /**
   * The notes about a target, or linked to a ref: the notes the events on that
   * target name, and the notes whose revisions name that ref. A note the store
   * has never heard of is skipped, so a hallucinated ref costs nothing.
   */
  private async linkedNoteIds(about: Target | undefined, linked: Ref | undefined): Promise<number[]> {
    const aboutIds = about === undefined ? null : await this.notesAbout(about);
    const linkedIds = linked === undefined ? null : this.notesLinkedTo(linked);
    if (aboutIds !== null && linkedIds !== null) {
      const keep = new Set(linkedIds);
      return aboutIds.filter((id) => keep.has(id));
    }
    return aboutIds ?? linkedIds ?? [];
  }

  /** The notes the events on a target name, strongest link first. */
  private async notesAbout(target: Target): Promise<number[]> {
    const page = await this.journal.list({ targets: [target], limit: ABOUT_EVENT_LIMIT });
    const weights = new Map<number, number>();
    const add = (ref: string, weight: number): void => {
      const id = parseNoteId(ref);
      if (id === null) return;
      if (weight > (weights.get(id) ?? 0)) weights.set(id, weight);
    };
    for (const event of page.items) {
      for (const link of event.links) add(link.to, link.weight);
    }
    return [...weights.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).map(([id]) => id);
  }

  /** The notes whose revisions name a ref, whichever revision named it. */
  private notesLinkedTo(ref: Ref): number[] {
    // A note is named under the revision it was cited at, and under its bare id.
    const forms = noteRefForms(ref);
    const rows = this.db
      .prepare(
        `SELECT note, MAX(weight) AS weight FROM note_refs
         WHERE ref IN (${forms.map(() => "?").join(", ")})
         GROUP BY note ORDER BY weight DESC, note`,
      )
      .all(...forms) as unknown as Array<{ note: number; weight: number }>;
    return rows.map((row) => toNumber(row.note));
  }

  private latestEpoch(): EpochRow | null {
    const row = this.db
      .prepare(
        "SELECT epoch, time, wseq, budget_count, budget_tokens FROM note_epochs ORDER BY epoch DESC LIMIT 1",
      )
      .get() as EpochRow | undefined;
    return row === undefined ? null : row;
  }

  private epochRow(epoch: number): EpochRow | null {
    const row = this.db
      .prepare("SELECT epoch, time, wseq, budget_count, budget_tokens FROM note_epochs WHERE epoch = ?")
      .get(epoch) as EpochRow | undefined;
    return row === undefined ? null : row;
  }

  private newestWriteSeq(): number {
    const row = this.db.prepare("SELECT MAX(wseq) AS wseq FROM note_revisions").get() as
      | { wseq: number | null }
      | undefined;
    return row?.wseq == null ? 0 : toNumber(row.wseq);
  }

  /**
   * The epoch a window freezes its prefix at. A new one is built at most every
   * `minIntervalMs`, and only when a note was written since the last one or the
   * budget changed, so every window opened in one epoch has the same prefix and
   * the changes since reach it as a delta.
   */
  private epochAt(
    now: number,
    minIntervalMs: number,
    budget: ActiveSetBudget,
    judgeKeep: readonly NoteRef[],
    judgeShare: number,
  ): EpochRow {
    const last = this.latestEpoch();
    const newest = this.newestWriteSeq();
    const changed =
      last === null ||
      newest > last.wseq ||
      last.budget_count !== budget.count ||
      last.budget_tokens !== budget.tokens;
    if (last !== null && (!changed || now - last.time < minIntervalMs)) return last;

    const scored = scoreNotes(this.db, now, this.halfLifeMs);
    const picked = pickByBudget(scored, budget);
    const chosen = applyJudgeShare(
      picked,
      new Map(scored.map((item): [number, ScoredNote] => [item.note, item])),
      judgeKeep,
      judgeShare,
      budget,
    );
    const info = this.db
      .prepare(
        "INSERT INTO note_epochs (time, wseq, budget_count, budget_tokens) VALUES (?, ?, ?, ?)",
      )
      .run(now, newest, budget.count, budget.tokens);
    const epoch = toNumber(info.lastInsertRowid);
    const insertItem = this.db.prepare(
      `INSERT INTO note_epoch_items (epoch, note, revision, title, summary, tokens, time)
       SELECT ?, n.id, n.revision, n.title, n.summary, ?, n.updated FROM notes n WHERE n.id = ?`,
    );
    for (const item of chosen) insertItem.run(epoch, item.tokens, item.note);
    this.db.prepare("UPDATE notes SET status = 'archived' WHERE status = 'active'").run();
    const activate = this.db.prepare("UPDATE notes SET status = 'active' WHERE id = ?");
    for (const item of chosen) activate.run(item.note);
    return this.epochRow(epoch) as EpochRow;
  }

  /** The active notes one epoch froze, by summary, sorted by id. */
  private epochSummaries(epoch: number): NoteSummary[] {
    const rows = this.db
      .prepare(
        `SELECT i.note AS note, i.revision AS revision, i.title AS title, i.summary AS summary,
                i.time AS time, n.visibility AS visibility, n.status AS status
         FROM note_epoch_items i JOIN notes n ON n.id = i.note
         WHERE i.epoch = ? AND n.status != 'deleted'
         ORDER BY i.note`,
      )
      .all(epoch) as unknown as Array<{
      note: number;
      revision: number;
      title: string;
      summary: string;
      time: number;
      visibility: string;
      status: string;
    }>;
    return rows.map((row) => {
      const note = toNumber(row.note);
      const revision = toNumber(row.revision);
      return {
        ref: noteRefOf(note, revision),
        id: noteIdOf(note),
        title: row.title,
        summary: row.summary,
        visibility: row.visibility as NoteVisibility,
        status: row.status as NoteStatus,
        revision,
        time: toNumber(row.time),
      };
    });
  }
}
