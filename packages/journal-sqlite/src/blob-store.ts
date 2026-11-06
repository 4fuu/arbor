/**
 * Media and files are stored once by content beside the journal; events hold
 * their refs (docs/journal.md#media). The journal never keeps the bytes.
 *
 * `FsBlobStore` keeps the bytes in one directory. Which id a piece of content
 * has is the journal's business - the ref an event carries is `b7`, and the
 * content hash decides whether two writes are the same content - so the store
 * takes a registry that the journal implements against its own database. A
 * deployment that keeps media elsewhere implements `BlobStore` itself.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BlobContent, BlobInfo, BlobInput, BlobRef, BlobStore } from "@4fu/arbor-interfaces";

/** What a store needs to know about one stored blob. */
export interface BlobEntry {
  path: string;
  size: number;
  mime?: string;
  time: number;
}

/** The id space, owned by the journal's database. */
export interface BlobRegistry {
  /** The id this content hash already has, when it is stored. */
  idFor(sha256: string): number | null;
  /** Record a new blob and return its id. */
  allocate(sha256: string, size: number, mime?: string, time?: number): number;
  /** The stored entry for an id. */
  entryFor(id: number): BlobEntry | null;
  /** Forget an id, so the bytes may be erased. */
  forget(id: number): void;
}

export function blobRefOf(id: number): BlobRef {
  return `b${id}`;
}

export function blobIdOf(ref: string): number | null {
  const match = /^b(\d+)$/.exec(ref);
  return match === null ? null : Number(match[1]);
}

function toBuffer(data: Uint8Array | string): Buffer {
  if (typeof data === "string") return Buffer.from(data, "utf8");
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

export class FsBlobStore implements BlobStore {
  private readonly directory: string;
  private readonly registry: BlobRegistry;
  /** One write at a time, so two writes of the same content share one id. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(directory: string, registry: BlobRegistry) {
    this.directory = directory;
    this.registry = registry;
  }

  async put(input: BlobInput): Promise<BlobRef> {
    const run = this.queue.then(() => this.write(input));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async write(input: BlobInput): Promise<BlobRef> {
    const data = toBuffer(input.data);
    const sha256 = createHash("sha256").update(data).digest("hex");
    const existing = this.registry.idFor(sha256);
    if (existing !== null) return blobRefOf(existing);

    await mkdir(this.directory, { recursive: true });
    const id = this.registry.allocate(sha256, data.byteLength, input.mime);
    const entry = this.registry.entryFor(id);
    const path = entry?.path ?? this.pathFor(id);
    await writeFile(path, data);
    return blobRefOf(id);
  }

  async get(ref: BlobRef): Promise<BlobContent | null> {
    const id = blobIdOf(ref);
    if (id === null) return null;
    const entry = this.registry.entryFor(id);
    if (entry === null) return null;
    try {
      const data = await readFile(entry.path);
      return { data: new Uint8Array(data), ...(entry.mime === undefined ? {} : { mime: entry.mime }) };
    } catch {
      return null;
    }
  }

  async has(ref: BlobRef): Promise<boolean> {
    const id = blobIdOf(ref);
    return id !== null && this.registry.entryFor(id) !== null;
  }

  async stat(ref: BlobRef): Promise<BlobInfo | null> {
    const id = blobIdOf(ref);
    if (id === null) return null;
    const entry = this.registry.entryFor(id);
    if (entry === null) return null;
    return {
      ref: blobRefOf(id),
      size: entry.size,
      time: entry.time,
      ...(entry.mime === undefined ? {} : { mime: entry.mime }),
    };
  }

  async delete(ref: BlobRef): Promise<void> {
    const id = blobIdOf(ref);
    if (id === null) return;
    const entry = this.registry.entryFor(id);
    if (entry === null) return;
    this.registry.forget(id);
    try {
      await unlink(entry.path);
    } catch {
      // The bytes are already gone; the id is what an event holds.
    }
  }

  private pathFor(id: number): string {
    return join(this.directory, String(id));
  }
}
