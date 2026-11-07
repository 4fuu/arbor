/**
 * The default `Journal`: SQLite (docs/journal.md).
 *
 * What this implementation owns:
 *
 * - the one global order: `seq`, assigned at append and only growing, with the
 *   ref `r<seq>`;
 * - targets, native ids with a unique index, refs and the links the host
 *   records between them;
 * - media held by id, with the bytes in a blob store beside the database;
 * - lexical search: a word index with BM25, a trigram index for exact
 *   substrings, and a substring scan for one- and two-character queries,
 *   merged with exact substring hits first;
 * - watermarks per window and target, and the targets a window is behind on;
 * - redaction, the one thing that erases content.
 *
 * It is synchronous inside: one `DatabaseSync`, one transaction per append, so
 * the sequence an append assigns is atomic. The interface is asynchronous
 * because a `Journal` may live behind a process boundary.
 */

import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { arborError } from "@4fu/arbor-errors";
import { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT } from "@4fu/arbor-interfaces";
import type {
  AroundOptions,
  BlobStore,
  Event,
  EventInput,
  EventPage,
  EventRef,
  Journal,
  Link,
  LinkInput,
  LinkPage,
  LinksOptions,
  ListOptions,
  Ref,
  RelatedItem,
  SearchHit,
  SearchOptions,
  SearchPage,
  Segmenter,
  SemanticFilters,
  SemanticIndex,
  Target,
  TargetGap,
  TraceNode,
  TraceOptions,
  WindowRef,
} from "@4fu/arbor-interfaces";
import type { BlobRegistry } from "./blob-store.ts";
import { FsBlobStore, blobIdOf } from "./blob-store.ts";
import { indexText, mergeHits, resolveSegmenter, MIN_TRIGRAM_CHARS } from "@4fu/arbor-lexical";
import type { MergedHit, Ranked } from "@4fu/arbor-lexical";
import { resolveSemanticIndex } from "./semantic.ts";
import { IMPLICIT_CITE_WEIGHT, TRIGRAM_TABLE, WORD_TABLE, createSchema } from "./schema.ts";
import { buildFilters, likePattern, ranked, substring, trigramMatch, wordMatch } from "./search.ts";
import type { SearchFilters } from "./search.ts";
import { storedBlobRef, storedExternalRef, storedRef, storedWindowRef } from "./stored.ts";

export { MIN_TRIGRAM_CHARS };

/**
 * The fewest candidates the semantic channel is asked for. A page of one still
 * fuses the channels over a handful of candidates, so a hit the word index
 * ranked first is not lost to a semantic hit the channel would have ranked
 * second.
 */
const MIN_SEMANTIC_CANDIDATES = 10;

/** How many related items one read appends (docs/prompting.md). */
const RELATED_LIMIT = 3;

const AROUND_BEFORE = 5;
const AROUND_AFTER = 5;

interface EventRow {
  seq: number;
  window: string | null;
  time: number;
  kind: string;
  external: string | null;
  body: string | null;
  redacted: string | null;
}

interface LinkRow {
  seq: number;
  from_ref: string;
  to_ref: string;
  kind: string;
  weight: number;
  time: number;
}

export interface SqliteJournalOptions {
  /** A file path, or `:memory:`. */
  path?: string;
  /** Media storage. Defaults to a directory beside the database. */
  blobs?: BlobStore;
  /** Word segmentation for the word index. */
  segmenter?: Segmenter;
  /**
   * The semantic channel: event text embedded and searched by meaning
   * (docs/journal.md#search). Omitted, the zvec channel is used when
   * `@4fu/arbor-search-zvec` is installed and its store opens, and there is no
   * channel otherwise. `null` forces lexical search even when the package is
   * installed.
   */
  semantic?: SemanticIndex | null;
  /** The clock. Tests pass a fixed one. */
  now?: () => number;
}

function toNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  throw arborError({
    code: "internal",
    rule: "journal.storage.value",
    message: "journal: storage returned a value that is not a number",
    details: { value: String(value) },
  });
}

/** One transaction: every append is one atomic step of the one global order. */
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

export function parseEventRef(ref: string): number | null {
  const match = /^r(\d+)$/.exec(ref);
  return match === null ? null : Number(match[1]);
}

export function eventRefOf(seq: number): EventRef {
  return `r${seq}`;
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_PAGE_LIMIT;
  return Math.min(Math.max(1, Math.floor(limit)), MAX_PAGE_LIMIT);
}

/** The opening words of a body, for a one-line result. */
export function summaryOf(body: string | null, max = 80): string {
  if (body === null || body === "") return "";
  const flat = body.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

/** The blob id space, kept in the journal's own database. */
class SqlBlobRegistry implements BlobRegistry {
  private readonly db: DatabaseSync;
  private readonly directory: string;

  constructor(db: DatabaseSync, directory: string) {
    this.db = db;
    this.directory = directory;
  }

  idFor(sha256: string): number | null {
    const row = this.db.prepare("SELECT id FROM blobs WHERE sha256 = ?").get(sha256) as
      | { id: number }
      | undefined;
    return row === undefined ? null : toNumber(row.id);
  }

  allocate(sha256: string, size: number, mime?: string, time?: number): number {
    const info = this.db
      .prepare("INSERT INTO blobs (sha256, size, mime, path, time) VALUES (?, ?, ?, ?, ?)")
      .run(sha256, size, mime ?? null, join(this.directory, sha256), time ?? Date.now());
    return toNumber(info.lastInsertRowid);
  }

  entryFor(id: number): { path: string; size: number; mime?: string; time: number } | null {
    const row = this.db
      .prepare("SELECT path, size, mime, time FROM blobs WHERE id = ?")
      .get(id) as { path: string; size: number; mime: string | null; time: number } | undefined;
    if (row === undefined) return null;
    return {
      path: row.path,
      size: toNumber(row.size),
      time: toNumber(row.time),
      ...(row.mime === null ? {} : { mime: row.mime }),
    };
  }

  forget(id: number): void {
    this.db.prepare("DELETE FROM blobs WHERE id = ?").run(id);
  }
}

export class SqliteJournal implements Journal {
  readonly blobs: BlobStore;
  readonly path: string;

  private readonly db: DatabaseSync;
  private readonly segmenter: Segmenter;
  private readonly semantic: SemanticIndex | null;
  private readonly clock: () => number;
  private readonly ownedBlobDirectory: string | null;
  private semanticReady = false;
  private semanticCaughtUp = false;
  private closed = false;

  constructor(options: SqliteJournalOptions = {}) {
    this.path = options.path ?? ":memory:";
    this.db = new DatabaseSync(this.path);
    createSchema(this.db);
    this.segmenter = options.segmenter ?? resolveSegmenter();
    this.clock = options.now ?? (() => Date.now());

    // An in-memory journal has no directory of its own; give it a temporary one
    // and take it away on close. The blob store and the semantic channel's own
    // store both live under it.
    const root = this.path === ":memory:" ? join(tmpdir(), `arbor-journal-${randomUUID()}`) : null;
    if (options.blobs !== undefined) {
      this.blobs = options.blobs;
      this.ownedBlobDirectory = root;
    } else if (root !== null) {
      this.blobs = new FsBlobStore(join(root, "blobs"), new SqlBlobRegistry(this.db, join(root, "blobs")));
      this.ownedBlobDirectory = root;
    } else {
      const directory = `${this.path}.blobs`;
      this.blobs = new FsBlobStore(directory, new SqlBlobRegistry(this.db, directory));
      this.ownedBlobDirectory = null;
    }

    this.semantic =
      options.semantic === undefined
        ? resolveSemanticIndex(root === null ? `${this.path}.vectors` : join(root, "vectors"))
        : options.semantic;
  }

  async append(input: EventInput): Promise<Event> {
    this.ensureOpen();
    const time = input.time ?? this.clock();
    const external = input.external ?? null;

    // One transaction decides both whether the outside message is already
    // stored and what the next sequence number is, so a redelivery that races
    // another append is still stored once.
    const seq = inTransaction(this.db, (): number => {
      if (external !== null) {
        const stored = this.db
          .prepare("SELECT seq FROM events WHERE external = ?")
          .get(external) as { seq: number } | undefined;
        if (stored !== undefined) return toNumber(stored.seq);
      }
      const info = this.db
        .prepare(
          `INSERT INTO events (window, time, kind, external, body, redacted)
           VALUES (?, ?, ?, ?, ?, NULL)`,
        )
        .run(
          input.window ?? null,
          time,
          input.kind,
          external,
          input.body ?? null,
        );
      const assigned = toNumber(info.lastInsertRowid);
      this.insertChildren(
        assigned,
        input,
        deriveLinks(input.links, input.refs, eventRefOf(assigned), time),
      );
      return assigned;
    });

    // The semantic channel is asynchronous, so it is indexed once the event is
    // committed: an append never waits on a model, and a channel that is not
    // ready yet holds the text until it is. With no channel there is nothing to
    // wait for, and the append takes the path it always did.
    const body = input.body;
    if (this.semantic !== null && body !== null && body !== undefined && body !== "") {
      await this.addToSemantic(seq, body, input.kind, input.window ?? null);
    }
    return this.readEvent(seq) as Event;
  }

  async get(ref: EventRef): Promise<Event | null> {
    this.ensureOpen();
    const seq = parseEventRef(ref);
    if (seq === null) throw invalidEventRef("journal.get", ref);
    return this.readEvent(seq);
  }

  async getMany(refs: readonly EventRef[]): Promise<Event[]> {
    this.ensureOpen();
    const events: Event[] = [];
    for (const ref of refs) {
      const seq = parseEventRef(ref);
      if (seq === null) throw invalidEventRef("journal.getMany", ref);
      const event = this.readEvent(seq);
      if (event !== null) events.push(event);
    }
    return events;
  }

  async list(options: ListOptions = {}): Promise<EventPage> {
    this.ensureOpen();
    const limit = clampLimit(options.limit);
    const offset = Math.max(0, options.offset ?? 0);
    const filters = filtersOf(options);
    const built = buildFilters(filters);
    const rows = this.db
      .prepare(`SELECT e.seq AS seq FROM events e WHERE 1 = 1${built.sql} ORDER BY e.seq LIMIT ? OFFSET ?`)
      .all(...built.params, limit, offset) as Array<{ seq: number }>;
    const events: Event[] = [];
    for (const row of rows) {
      const event = this.readEvent(toNumber(row.seq));
      if (event !== null) events.push(event);
    }
    return {
      items: events,
      total: this.countEvents(filters),
      limit,
      nextCall: listCall(options, offset, limit),
    };
  }

  async around(ref: EventRef, options: AroundOptions = {}): Promise<Event[]> {
    this.ensureOpen();
    const seq = parseEventRef(ref);
    if (seq === null) throw invalidEventRef("journal.around", ref);
    const before = options.before ?? AROUND_BEFORE;
    const after = options.after ?? AROUND_AFTER;
    const rows = this.db
      .prepare("SELECT seq FROM events WHERE seq >= ? AND seq <= ? ORDER BY seq")
      .all(Math.max(1, seq - before), seq + after) as Array<{ seq: number }>;
    const events: Event[] = [];
    for (const row of rows) {
      const event = this.readEvent(toNumber(row.seq));
      if (event !== null) events.push(event);
    }
    return events;
  }

  async search(query: string, options: SearchOptions = {}): Promise<SearchPage> {
    this.ensureOpen();
    const limit = clampLimit(options.limit);
    const offset = Math.max(0, options.offset ?? 0);
    const trimmed = query.trim();
    if (trimmed === "") {
      return { items: [], total: 0, limit, nextCall: searchCall(trimmed, offset, limit) };
    }

    const filters = filtersOf(options);
    const codepoints = Array.from(trimmed).length;
    let substrings: Ranked[] = [];
    let words: Ranked[] = [];

    if (codepoints >= MIN_TRIGRAM_CHARS) {
      substrings = ranked(this.db, TRIGRAM_TABLE, trigramMatch(trimmed), filters);
      const tokens = this.segmenter.segment(trimmed);
      if (tokens.length > 0) {
        words = ranked(this.db, WORD_TABLE, wordMatch(tokens), filters);
      }
    } else {
      // A one- or two-character query has no trigram of its own; the substring
      // scan is its fallback.
      substrings = substring(this.db, likePattern(trimmed), filters);
    }

    const semantic =
      this.semantic === null ? [] : await this.semanticHits(trimmed, limit, filters);
    // Exact substring hits first, then word hits, then the hits only the
    // semantic channel found: the vector channel adds what the lexical indexes
    // missed and never moves what they found (docs/journal.md#search).
    const merged = mergeHits(
      { channel: "substring", hits: substrings },
      { channel: "word", hits: words },
      { channel: "semantic", hits: semantic },
    );
    const page = merged.slice(offset, offset + limit);
    const items = page.map((hit) => this.toSearchHit(hit));
    return {
      items,
      total: merged.length,
      limit,
      nextCall: searchCall(trimmed, offset, limit),
    };
  }

  async links(ref: Ref, options: LinksOptions = {}): Promise<LinkPage> {
    this.ensureOpen();
    const limit = Math.min(Math.max(1, Math.floor(options.limit ?? RELATED_LIMIT)), MAX_PAGE_LIMIT);
    const offset = Math.max(0, options.offset ?? 0);
    const rows = this.db
      .prepare(
        `SELECT seq, from_ref, to_ref, kind, weight, time FROM links
         WHERE to_ref = ? OR from_ref = ?
         ORDER BY weight DESC, time DESC, seq DESC`,
      )
      .all(ref, ref) as unknown as LinkRow[];

    const strongest = new Map<Ref, RelatedItem>();
    for (const row of rows) {
      const outgoing = row.from_ref === ref;
      const other = storedRef(outgoing ? row.to_ref : row.from_ref);
      const weight = toNumber(row.weight);
      const previous = strongest.get(other);
      if (previous !== undefined && previous.weight >= weight) continue;
      const resolved = this.resolveRelated(other, toNumber(row.time));
      strongest.set(other, {
        ref: other,
        kind: row.kind,
        weight,
        direction: outgoing ? "out" : "in",
        window: resolved.window,
        time: resolved.time,
        summary: resolved.summary,
      });
    }

    const all = [...strongest.values()].sort(
      (a, b) => b.weight - a.weight || b.time - a.time,
    );
    return {
      items: all.slice(offset, offset + limit),
      total: all.length,
      limit,
      nextCall: `journal.links(${ref}, offset=${offset + limit})`,
    };
  }

  async trace(ref: Ref, options: TraceOptions = {}): Promise<TraceNode> {
    this.ensureOpen();
    const maxHops = Math.max(0, Math.floor(options.maxHops ?? 8));
    const maxNodes = Math.max(1, Math.floor(options.maxNodes ?? 64));
    const visited = new Set<Ref>();
    let budget = maxNodes;

    const build = (current: Ref, hopsLeft: number): TraceNode => {
      if (visited.has(current) || budget <= 0) {
        return { ref: current, window: null, time: 0, summary: "", origin: false, from: [] };
      }
      visited.add(current);
      budget -= 1;
      const event = this.readEventByRef(current);
      const sources = budget > 0 && hopsLeft > 0 ? this.sourcesOf(current) : [];
      return {
        ref: current,
        ...(event === null ? {} : { kind: event.kind }),
        window: event?.window ?? null,
        time: event?.time ?? 0,
        summary: summaryOf(event?.body ?? null),
        // An outside message is where a chain came from; so is a ref the walk
        // stopped on because it is not an event.
        origin: event === null || event.external !== null,
        from: sources
          .map((source) => build(source, hopsLeft - 1))
          .filter((node) => node.ref !== current),
      };
    };

    return build(ref, maxHops);
  }

  async watermark(window: WindowRef, target: Target): Promise<number | null> {
    this.ensureOpen();
    const row = this.db
      .prepare("SELECT seq FROM watermarks WHERE window = ? AND target = ?")
      .get(window, target) as { seq: number } | undefined;
    return row === undefined ? null : toNumber(row.seq);
  }

  async advanceWatermark(window: WindowRef, target: Target, seq: number): Promise<number> {
    this.ensureOpen();
    this.db
      .prepare(
        `INSERT INTO watermarks (window, target, seq) VALUES (?, ?, ?)
         ON CONFLICT (window, target) DO UPDATE SET seq = MAX(seq, excluded.seq)`,
      )
      .run(window, target, seq);
    return (await this.watermark(window, target)) ?? seq;
  }

  async targetsBehind(window: WindowRef): Promise<TargetGap[]> {
    this.ensureOpen();
    const touched = this.db
      .prepare(
        `SELECT et.target AS target FROM event_targets et
         JOIN events e ON e.seq = et.seq
         WHERE e.window = ?
         GROUP BY et.target`,
      )
      .all(window) as Array<{ target: string }>;

    const openedAt = await this.openedAt(window);
    const gaps: TargetGap[] = [];
    for (const row of touched) {
      // What a window is behind on is what arrived after it opened and what
      // another window wrote: the task and the outside events it was opened
      // for, and the window's own `window_start`, are not open work
      // (docs/windows.md#ending-and-continuing).
      const latest = this.latestOn(row.target, window, openedAt);
      const watermark = (await this.watermark(window, row.target)) ?? 0;
      if (latest <= watermark) continue;
      const behind = this.db
        .prepare(
          `SELECT count(*) AS n FROM event_targets et JOIN events e ON e.seq = et.seq
           WHERE et.target = ? AND et.seq > ? AND et.seq > ? AND e.window IS NOT ?`,
        )
        .get(row.target, watermark, openedAt, window) as { n: number };
      gaps.push({
        target: row.target,
        latest,
        watermark,
        count: toNumber(behind.n),
      });
    }
    return gaps.sort((a, b) => b.latest - a.latest || a.target.localeCompare(b.target));
  }

  async redact(ref: EventRef, reason: string): Promise<Event> {
    this.ensureOpen();
    const seq = parseEventRef(ref);
    if (seq === null) throw invalidEventRef("journal.redact", ref);
    const covered = this.readEvent(seq);
    if (covered === null) {
      throw arborError({
        code: "not_found",
        rule: "journal.redact.event",
        message: `journal.redact: ${ref} is not in the journal`,
        nextAction: "check the ref with journal.get, or search for the event",
      });
    }

    const time = this.clock();
    const redaction = inTransaction(this.db, () => {
      const info = this.db
        .prepare(
          `INSERT INTO events (window, time, kind, external, body, redacted)
           VALUES (?, ?, 'redaction', NULL, ?, NULL)`,
        )
        .run(null, time, reason);
      const by = toNumber(info.lastInsertRowid);
      // The redaction names the event it covers, but records no link: a trace
      // walks back to where something came from, not to what erased it.
      this.db.prepare("INSERT OR IGNORE INTO event_refs (seq, ref) VALUES (?, ?)").run(by, ref);

      this.db.prepare(`DELETE FROM ${TRIGRAM_TABLE} WHERE rowid = ?`).run(seq);
      this.db.prepare(`DELETE FROM ${WORD_TABLE} WHERE rowid = ?`).run(seq);
      this.db
        .prepare("UPDATE events SET body = NULL, redacted = ? WHERE seq = ?")
        .run(JSON.stringify({ by: eventRefOf(by), reason, time }), seq);
      this.db
        .prepare("INSERT OR REPLACE INTO redactions (covers, by, reason, time) VALUES (?, ?, ?, ?)")
        .run(seq, by, reason, time);

      // Media the event held are erased with it, unless another event holds
      // the same content.
      const held = this.db
        .prepare("SELECT blob FROM event_blobs WHERE seq = ?")
        .all(seq) as Array<{ blob: string }>;
      this.db.prepare("DELETE FROM event_blobs WHERE seq = ?").run(seq);
      const erased: string[] = [];
      for (const row of held) {
        const shared = this.db
          .prepare("SELECT count(*) AS n FROM event_blobs WHERE blob = ?")
          .get(row.blob) as { n: number };
        if (toNumber(shared.n) > 0) continue;
        this.db.prepare("DELETE FROM blobs WHERE id = ?").run(blobIdOf(row.blob));
        erased.push(row.blob);
      }
      return { by, erased };
    });

    for (const blob of redaction.erased) await this.blobs.delete(storedBlobRef(blob));
    // The vector the event left behind goes with its content: a redaction erases
    // what the journal holds, and the semantic channel is one of those places.
    if (this.semantic !== null) await this.removeFromSemantic(seq);
    return this.readEvent(redaction.by) as Event;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
    if (this.semantic !== null) await this.semantic.close();
    if (this.ownedBlobDirectory !== null) {
      await rm(this.ownedBlobDirectory, { recursive: true, force: true });
    }
  }

  /**
   * Index the events the semantic channel does not hold yet, and say how many.
   *
   * A restart over an existing database, a channel that was not ready when the
   * events arrived, and an append whose indexing failed all leave events to
   * catch up on. A channel that is not ready yet holds what it was given and
   * indexes that itself, so this answers 0 until it is.
   */
  async catchUpSemantic(): Promise<number> {
    this.ensureOpen();
    if (this.semantic === null || !(await this.semantic.ready())) return 0;
    const held = await this.semantic.held();
    const rows = this.db
      .prepare(
        `SELECT seq, kind, window, body FROM events
         WHERE body IS NOT NULL AND redacted IS NULL ORDER BY seq`,
      )
      .all() as Array<{ seq: number; kind: string; window: string | null; body: string }>;
    let indexed = 0;
    for (const row of rows) {
      const seq = toNumber(row.seq);
      if (held.has(eventRefOf(seq))) continue;
      await this.addToSemantic(seq, row.body, row.kind, storedWindowRef(row.window));
      indexed += 1;
    }
    return indexed;
  }

  // --- internals ---------------------------------------------------------

  /** Hand one event's text to the semantic channel, when there is one. */
  private async addToSemantic(
    seq: number,
    body: string,
    kind: string,
    window: WindowRef | null,
  ): Promise<void> {
    if (this.semantic === null) return;
    try {
      await this.semantic.add(eventRefOf(seq), body, { kind, window });
    } catch {
      // An optional channel that refuses leaves the event searchable lexically;
      // a catch-up indexes it once the channel answers again.
    }
  }

  /** Take one event's text back out of the semantic channel, when there is one. */
  private async removeFromSemantic(seq: number): Promise<void> {
    if (this.semantic === null) return;
    try {
      await this.semantic.remove(eventRefOf(seq));
    } catch {
      // As with an append: the channel is optional, and the event is gone from
      // every index the journal owns.
    }
  }

  /**
   * The semantic channel's candidates, as ranks in the order it gave them.
   *
   * An absent channel, one that is not ready yet, and one that refuses all
   * answer with nothing, and the search is exactly the lexical one. The
   * journal's own filters decide which candidates count, so a channel that
   * filters less than the journal does still answers the read it was asked for.
   */
  private async semanticHits(
    query: string,
    limit: number,
    filters: SearchFilters,
  ): Promise<Ranked[]> {
    if (this.semantic === null) return [];
    const ready = await this.semantic.ready();
    if (ready !== this.semanticReady) {
      // The channel just became usable, or stopped being: index what it missed
      // while it was not.
      this.semanticReady = ready;
      this.semanticCaughtUp = false;
    }
    if (!this.semanticCaughtUp) {
      this.semanticCaughtUp = true;
      await this.catchUpSemantic();
    }
    if (!ready) return [];

    const asked: SemanticFilters = {
      ...(filters.kinds === undefined ? {} : { kinds: filters.kinds }),
      ...(filters.window === undefined ? {} : { window: filters.window }),
      ...(filters.afterSeq === undefined ? {} : { afterSeq: filters.afterSeq }),
      ...(filters.beforeSeq === undefined ? {} : { beforeSeq: filters.beforeSeq }),
    };
    const refs = await this.semantic.search(query, Math.max(limit, MIN_SEMANTIC_CANDIDATES), asked);
    const allowed = this.allowedSeqs(refs, filters);
    // The channel's order, as ranks the shared merge reads: the nearest hit
    // carries the most negative rank, so it normalizes to the best score.
    return allowed.map((rowid, index) => ({ rowid, rank: index - allowed.length }));
  }

  /**
   * The sequences among `refs` the journal's own filters allow, in the order
   * given. A redacted event and one with no text are not among them, so a
   * vector that outlived its content never reaches a page.
   */
  private allowedSeqs(refs: readonly EventRef[], filters: SearchFilters): number[] {
    const seqs: number[] = [];
    for (const ref of refs) {
      const seq = parseEventRef(ref);
      if (seq !== null) seqs.push(seq);
    }
    if (seqs.length === 0) return [];
    const built = buildFilters(filters);
    const placeholders = seqs.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT e.seq AS seq FROM events e
         WHERE e.seq IN (${placeholders}) AND e.body IS NOT NULL AND e.redacted IS NULL${built.sql}`,
      )
      .all(...seqs, ...built.params) as Array<{ seq: number }>;
    const allowed = new Set(rows.map((row) => toNumber(row.seq)));
    return seqs.filter((seq) => allowed.has(seq));
  }

  private ensureOpen(): void {
    if (this.closed) {
      throw arborError({
        code: "unavailable",
        rule: "journal.closed",
        message: "journal: the journal is closed",
        nextAction: "open a journal before reading or appending",
      });
    }
  }

  private insertChildren(seq: number, input: EventInput, links: readonly Link[]): void {
    const insertTarget = this.db.prepare(
      "INSERT OR IGNORE INTO event_targets (seq, target) VALUES (?, ?)",
    );
    for (const target of input.targets ?? []) insertTarget.run(seq, target);

    const insertRef = this.db.prepare("INSERT OR IGNORE INTO event_refs (seq, ref) VALUES (?, ?)");
    for (const ref of input.refs ?? []) insertRef.run(seq, ref);

    const insertBlob = this.db.prepare("INSERT OR IGNORE INTO event_blobs (seq, blob) VALUES (?, ?)");
    for (const blob of input.blobs ?? []) insertBlob.run(seq, blob);

    const insertLink = this.db.prepare(
      `INSERT OR IGNORE INTO links (seq, from_ref, to_ref, kind, weight, time)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const link of links) {
      insertLink.run(seq, link.from, link.to, link.kind, link.weight, link.time);
    }

    if (input.body !== null && input.body !== undefined && input.body !== "") {
      this.db
        .prepare(`INSERT INTO ${TRIGRAM_TABLE} (rowid, body) VALUES (?, ?)`)
        .run(seq, input.body);
      this.db
        .prepare(`INSERT INTO ${WORD_TABLE} (rowid, body) VALUES (?, ?)`)
        .run(seq, indexText(input.body, this.segmenter));
    }
  }

  private readEvent(seq: number): Event | null {
    const row = this.db
      .prepare(
        `SELECT seq, window, time, kind, external, body, redacted
         FROM events WHERE seq = ?`,
      )
      .get(seq) as EventRow | undefined;
    if (row === undefined) return null;

    const targets = this.strings("event_targets", "target", seq);
    const refs = this.strings("event_refs", "ref", seq);
    const blobs = this.strings("event_blobs", "blob", seq);
    const linkRows = this.db
      .prepare("SELECT kind, from_ref, to_ref, weight, time FROM links WHERE seq = ?")
      .all(seq) as unknown as LinkRow[];

    return {
      ref: eventRefOf(toNumber(row.seq)),
      seq: toNumber(row.seq),
      window: storedWindowRef(row.window),
      time: toNumber(row.time),
      kind: row.kind,
      targets,
      refs: refs.map(storedRef),
      links: linkRows.map((link) => ({
        kind: link.kind,
        from: storedRef(link.from_ref),
        to: storedRef(link.to_ref),
        weight: toNumber(link.weight),
        time: toNumber(link.time),
      })),
      external: storedExternalRef(row.external),
      blobs: blobs.map(storedBlobRef),
      body: row.body,
      redacted: row.redacted === null ? null : (JSON.parse(row.redacted) as Event["redacted"]),
    };
  }

  private readEventByRef(ref: Ref): Event | null {
    const seq = parseEventRef(ref);
    return seq === null ? null : this.readEvent(seq);
  }

  /** One column of one table, for the child rows of an event. */
  private strings(table: string, column: string, seq: number): string[] {
    const rows = this.db
      .prepare(`SELECT ${column} AS value FROM ${table} WHERE seq = ?`)
      .all(seq) as Array<{ value: string }>;
    return rows.map((row) => row.value);
  }

  private countEvents(filters: SearchFilters): number {
    const built = buildFilters(filters);
    const row = this.db
      .prepare(`SELECT count(*) AS n FROM events e WHERE 1 = 1${built.sql}`)
      .get(...built.params) as { n: number };
    return toNumber(row.n);
  }

  /**
   * The newest event on a target that another window wrote after one window
   * opened: what that window can still be behind on.
   */
  private latestOn(target: string, window: WindowRef, after: number): number {
    const row = this.db
      .prepare(
        `SELECT MAX(et.seq) AS latest FROM event_targets et
         JOIN events e ON e.seq = et.seq
         WHERE et.target = ? AND et.seq > ? AND e.window IS NOT ?`,
      )
      .get(target, after, window) as { latest: number | null } | undefined;
    return row?.latest == null ? 0 : toNumber(row.latest);
  }

  /** The sequence of one window's own `window_start`, or 0 before it opened. */
  private async openedAt(window: WindowRef): Promise<number> {
    const row = this.db
      .prepare("SELECT MIN(seq) AS seq FROM events WHERE window = ? AND kind = 'window_start'")
      .get(window) as { seq: number | null } | undefined;
    return row?.seq == null ? 0 : toNumber(row.seq);
  }

  /** Where a ref came from: the links that go out of it, strongest first. */
  private sourcesOf(ref: Ref): Ref[] {
    const rows = this.db
      .prepare(
        `SELECT to_ref, weight, time FROM links WHERE from_ref = ?
         ORDER BY weight DESC, time DESC LIMIT 8`,
      )
      .all(ref) as unknown as Array<{ to_ref: string }>;
    return rows.map((row) => storedRef(row.to_ref));
  }

  private resolveRelated(
    ref: Ref,
    fallbackTime: number,
  ): { window: WindowRef | null; time: number; summary: string } {
    const event = this.readEventByRef(ref);
    if (event === null) return { window: null, time: fallbackTime, summary: "" };
    return { window: event.window, time: event.time, summary: summaryOf(event.body) };
  }

  private toSearchHit(hit: MergedHit): SearchHit {
    const event = this.readEvent(hit.rowid);
    if (event === null) {
      throw arborError({
        code: "internal",
        rule: "journal.search.hit",
        message: "journal.search: a matched event cannot be read",
        nextAction: "run the search again; the journal may have been rebuilt",
      });
    }
    return {
      ref: event.ref,
      seq: event.seq,
      window: event.window,
      kind: event.kind,
      time: event.time,
      match: hit.channel,
      score: hit.score,
      summary: summaryOf(event.body),
    };
  }
}

/** The links one append records: what it declared, plus a bare cite per ref. */
export function deriveLinks(
  declared: readonly LinkInput[] | undefined,
  refs: readonly Ref[] | undefined,
  from: EventRef,
  time: number,
): Link[] {
  const links: Link[] = [];
  const seen = new Set<string>();
  for (const link of declared ?? []) {
    if (seen.has(link.to)) continue;
    seen.add(link.to);
    links.push({
      kind: link.kind,
      from,
      to: link.to,
      weight: link.weight ?? 1,
      time,
    });
  }
  for (const ref of refs ?? []) {
    if (seen.has(ref)) continue;
    seen.add(ref);
    links.push({ kind: "cite", from, to: ref, weight: IMPLICIT_CITE_WEIGHT, time });
  }
  return links;
}

function filtersOf(options: ListOptions | SearchOptions): SearchFilters {
  return {
    kinds: options.kinds?.map(String),
    window: options.window ?? undefined,
    targets: options.targets?.map(String),
    external: options.external ?? undefined,
    afterSeq: options.afterSeq,
    beforeSeq: options.beforeSeq,
  };
}

function invalidEventRef(rule: string, ref: string): Error {
  return arborError({
    code: "invalid_input",
    rule,
    message: `journal: ${ref} is not an event ref`,
    nextAction: "pass a ref an event carries, such as r902",
    details: { ref },
  });
}

function listCall(options: ListOptions, offset: number, limit: number): string {
  const parts: string[] = [];
  if (options.window !== undefined) parts.push(`window=${options.window}`);
  if (options.kinds !== undefined && options.kinds.length > 0) parts.push(`kinds=${options.kinds.join(",")}`);
  if (options.targets !== undefined && options.targets.length > 0) {
    parts.push(`targets=${options.targets.join(",")}`);
  }
  if (options.afterSeq !== undefined) parts.push(`afterSeq=r${options.afterSeq}`);
  if (options.beforeSeq !== undefined) parts.push(`beforeSeq=r${options.beforeSeq}`);
  parts.push(`offset=${offset + limit}`);
  return `journal.list(${parts.join(", ")})`;
}

function searchCall(query: string, offset: number, limit: number): string {
  return `journal.search(${JSON.stringify(query)}, offset=${offset + limit})`;
}

export { FsBlobStore, blobIdOf } from "./blob-store.ts";
