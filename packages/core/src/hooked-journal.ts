/**
 * The journal a host with hooks appends through: every event goes through
 * `beforeAppend` and `afterAppend`, and nothing else changes
 * (docs/architecture.md#hooks).
 *
 * A refusal throws in the core's error shape, so a caller that appends - a tool
 * call, a note write, a delivery - answers with the rule that refused it. Every
 * read delegates untouched: a hook sees what is written, never what is read.
 */

import type {
  AroundOptions,
  BlobStore,
  Event,
  EventInput,
  EventPage,
  EventRef,
  LinkPage,
  LinksOptions,
  ListOptions,
  Ref,
  SearchOptions,
  SearchPage,
  Target,
  TargetGap,
  TraceNode,
  TraceOptions,
  WindowRef,
} from "@arbor/interfaces";
import type { Journal } from "@arbor/interfaces";
import type { HookRunner } from "./hooks.ts";

export class HookedJournal implements Journal {
  private readonly journal: Journal;
  private readonly hooks: HookRunner;

  constructor(journal: Journal, hooks: HookRunner) {
    this.journal = journal;
    this.hooks = hooks;
  }

  /**
   * One append, through `beforeAppend` and `afterAppend`. With no hook
   * registered this is the underlying append itself, not a promise wrapped
   * around one, so a host without a plugin pays nothing for the seam.
   */
  append(input: EventInput): Promise<Event> {
    if (this.hooks.empty) return this.journal.append(input);
    return this.hooks.append(input, (allowed) => this.journal.append(allowed));
  }

  get(ref: EventRef): Promise<Event | null> {
    return this.journal.get(ref);
  }

  getMany(refs: readonly EventRef[]): Promise<Event[]> {
    return this.journal.getMany(refs);
  }

  list(options?: ListOptions): Promise<EventPage> {
    return this.journal.list(options);
  }

  around(ref: EventRef, options?: AroundOptions): Promise<Event[]> {
    return this.journal.around(ref, options);
  }

  search(query: string, options?: SearchOptions): Promise<SearchPage> {
    return this.journal.search(query, options);
  }

  links(ref: Ref, options?: LinksOptions): Promise<LinkPage> {
    return this.journal.links(ref, options);
  }

  trace(ref: Ref, options?: TraceOptions): Promise<TraceNode> {
    return this.journal.trace(ref, options);
  }

  watermark(window: WindowRef, target: Target): Promise<number | null> {
    return this.journal.watermark(window, target);
  }

  advanceWatermark(window: WindowRef, target: Target, seq: number): Promise<number> {
    return this.journal.advanceWatermark(window, target, seq);
  }

  targetsBehind(window: WindowRef): Promise<TargetGap[]> {
    return this.journal.targetsBehind(window);
  }

  redact(ref: EventRef, reason: string): Promise<Event> {
    return this.journal.redact(ref, reason);
  }

  get blobs(): BlobStore {
    return this.journal.blobs;
  }

  async close(): Promise<void> {
    await this.journal.close();
  }
}
