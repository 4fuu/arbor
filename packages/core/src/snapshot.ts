/**
 * Snapshot epochs: the frozen prefix every window opened in one epoch shares
 * (docs/windows.md#prompt-layout, docs/memory.md#the-active-set).
 *
 * The system prompt and the memory snapshot are rebuilt at most every
 * `snapshot.min_interval_ms`, and only when notes or the environment changed.
 * Rendering is deterministic: no timestamps or counters reach the prefix, and
 * the notes are sorted by id. What changed since the epoch goes into the first
 * input instead.
 */

import type { EnvRef, NoteSummary, Settings, TextTable } from "@arbor/interfaces";
import type { NoteStore } from "@arbor/interfaces";
import { Renderer, memoryBlocks, renderMemorySnapshot, renderSystemPrompt } from "@arbor/prompt";
import type { DirectToolSpec, EnvItem, ModuleSpec, PromptSection } from "@arbor/interfaces";

/** The default: the prefix is rebuilt at most every ten minutes. */
export const DEFAULT_MIN_INTERVAL_MS = 600000;

/** One frozen prefix. */
export interface PromptEpoch {
  system: string;
  memory: string;
  envRevision: EnvRef;
  /** The epoch's version, so a later window can ask what changed since. */
  version: number;
  /** When the epoch was built. */
  time: number;
}

export interface SnapshotBuilderOptions {
  settings?: Settings;
  table?: TextTable;
  notes?: NoteStore;
  /** The environment items the `<env>` section lists. */
  env?: () => readonly EnvItem[] | Promise<readonly EnvItem[]>;
  /** The direct tools the `<tools>` section lists, one line each. */
  tools?: () => readonly DirectToolSpec[];
  /** The modules the `<modules>` section lists, one line each. */
  modules?: () => readonly ModuleSpec[];
  envRevision?: () => EnvRef | Promise<EnvRef>;
  /** The plugin sections, one per plugin that registered one. */
  plugins?: () => readonly PromptSection[];
  minIntervalMs?: number;
  now?: () => number;
  kinds?: readonly import("@arbor/interfaces").BlockKindSpec[];
}

/**
 * Builds and caches the prefix. A caller asks for the current epoch; the
 * builder decides whether the last one still holds.
 */
export class SnapshotBuilder {
  private readonly options: SnapshotBuilderOptions;
  private readonly renderer: Renderer;
  private current: PromptEpoch | undefined;
  private version = 0;

  constructor(options: SnapshotBuilderOptions = {}) {
    this.options = options;
    this.renderer = new Renderer({ ...(options.table === undefined ? {} : { table: options.table }) });
  }

  /** The frozen prefix of the current epoch. */
  async epoch(): Promise<PromptEpoch> {
    const now = this.options.now?.() ?? Date.now();
    const minInterval = this.options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
    if (this.current !== undefined && now - this.current.time < minInterval) return this.current;
    this.version += 1;
    const notes = await this.activeNotes();
    const env = this.options.env === undefined ? [] : await this.options.env();
    const envRevision =
      this.options.envRevision === undefined ? ("e0" as EnvRef) : await this.options.envRevision();
    const plugins = this.options.plugins === undefined ? [] : this.options.plugins();
    const epoch: PromptEpoch = {
      system: await renderSystemPrompt(
        {
          settings: this.options.settings,
          tools: this.options.tools === undefined ? [] : this.options.tools(),
          modules: this.options.modules === undefined ? [] : this.options.modules(),
          env,
          plugins,
        },
        this.renderer,
      ),
      memory: renderMemorySnapshot(notes, this.renderer),
      envRevision,
      version: this.version,
      time: now,
    };
    this.current = epoch;
    return epoch;
  }

  /** The notes the memory snapshot carries, sorted by id. */
  private async activeNotes(): Promise<readonly NoteSummary[]> {
    const notes = this.options.notes;
    if (notes === undefined) return [];
    const snapshot = await notes.snapshot();
    return snapshot.items;
  }

  /** The blocks the memory snapshot renders as, for the first input's delta. */
  memoryBlocksOf(notes: readonly NoteSummary[]) {
    return memoryBlocks(notes);
  }

  /** Force the next `epoch()` to rebuild, after an environment change. */
  invalidate(): void {
    this.current = undefined;
  }
}
