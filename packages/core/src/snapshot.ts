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

import type {
  ActiveSetBudget,
  BlockKindSpec,
  EnvRef,
  NoteRef,
  NoteSummary,
  Settings,
  TextTable,
} from "@4fu/arbor-interfaces";
import type { NoteStore } from "@4fu/arbor-interfaces";
import { Renderer, renderMemorySnapshot, renderSystemPrompt } from "@4fu/arbor-prompt";
import type { DirectToolSpec, EnvItem, ModuleSpec, PromptSection } from "@4fu/arbor-interfaces";

/** The default: the prefix is rebuilt at most every ten minutes. */
export const DEFAULT_MIN_INTERVAL_MS = 600000;

/** How many notes the active set may hold, and the tokens it may cost. */
export const DEFAULT_ACTIVE_BUDGET: ActiveSetBudget = { count: 40, tokens: 8000 };

/** The bounded share of the active-set score the judge may add. */
export const DEFAULT_ACTIVE_SET_SHARE = 0.15;

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
  settings?: Settings | (() => Settings | undefined);
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
  /** Extra block kinds, from a plugin. */
  kinds?: readonly BlockKindSpec[];
  /**
   * The one renderer, shared with the host and the backend, so a plugin's kinds
   * and its fixed strings reach every layer. Built when absent.
   */
  renderer?: Renderer;
  /**
   * The judge's bounded share of the active set: which notes are still needed,
   * within a share of the budget the rule score did not pick
   * (docs/memory.md#the-active-set). The judge never outweighs the rule score.
   */
  activeSet?: (
    candidates: readonly { ref: NoteRef; summary: string; score: number }[],
    budget: ActiveSetBudget,
    judgeShare: number,
  ) => Promise<readonly NoteRef[]>;
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
    this.renderer =
      options.renderer ??
      new Renderer({
        ...(options.table === undefined ? {} : { table: options.table }),
        ...(options.kinds === undefined ? {} : { kinds: options.kinds }),
      });
  }

  /** The settings the prefix is built from, read per epoch. */
  private settings(): Settings | undefined {
    const settings = this.options.settings;
    if (typeof settings === "function") return settings();
    return settings;
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
          settings: this.settings(),
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
    const budget = this.activeBudget();
    const judgeShare = this.activeSetShare();
    const candidates = (await notes.score()).items.map((note) => ({
      ref: note.ref,
      summary: note.summary,
      score: note.score,
    }));
    // The judge adds a bounded share and never drops a note the rule score
    // picked, so its answer is passed to the snapshot rather than applied here.
    const judgeKeep = await this.options.activeSet?.(candidates, budget, judgeShare);
    const snapshot = await notes.snapshot({
      budget,
      judgeShare,
      ...(judgeKeep === undefined || judgeKeep.length === 0 ? {} : { judgeKeep }),
    });
    return snapshot.items;
  }

  /** The active set's budget: how many notes, and how many tokens. */
  private activeBudget(): ActiveSetBudget {
    const configured = this.settings()?.notes;
    return {
      count: configured?.activeCount ?? DEFAULT_ACTIVE_BUDGET.count,
      tokens: configured?.activeTokenBudget ?? DEFAULT_ACTIVE_BUDGET.tokens,
    };
  }

  /** The bounded share of the active set the judge may add. */
  private activeSetShare(): number {
    return this.settings()?.judge?.activeSetJudgeShare ?? DEFAULT_ACTIVE_SET_SHARE;
  }

  /** Force the next `epoch()` to rebuild. */
  invalidate(): void {
    this.current = undefined;
  }
}
