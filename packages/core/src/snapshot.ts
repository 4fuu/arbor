/**
 * Snapshot epochs: the frozen prefix every window opened in one epoch shares
 * (docs/windows.md#prompt-layout, docs/memory.md#the-active-set).
 *
 * The system prompt and the memory snapshot are rebuilt at most every
 * `snapshot.min_interval_ms`, and only when notes or the environment changed.
 * Rendering is deterministic: no timestamps or counters reach the prefix, and
 * the notes are sorted by id. What changed since the epoch goes into the first
 * input instead.
 *
 * A prefix is built for the window that asks for it, because a plugin section
 * may declare itself per window - one workspace per session, naming the window
 * it serves - and then the prefix is that window's own
 * (docs/prompting.md#plugin-sections-that-change). Every other window keeps
 * sharing one prefix. The active set stays frozen for its period whichever
 * prefix is built, so a per-window section costs one render rather than one
 * more read of the notes.
 */

import type {
  ActiveSetBudget,
  BlockKindSpec,
  EnvRef,
  NoteRef,
  NoteSummary,
  Settings,
  TextTable,
  WindowRef,
} from "@4fu/arbor-interfaces";
import type { NoteStore } from "@4fu/arbor-interfaces";
import { Renderer, renderMemorySnapshot, renderSystemPrompt, sectionRevision } from "@4fu/arbor-prompt";
import type { RenderedPluginSection } from "@4fu/arbor-prompt";
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
  /**
   * The plugin sections this prefix was built with, one per plugin that
   * registered one. A window that opened in this epoch diffs its own copy
   * against what a section says now, so a section that changed reaches it as a
   * delta (docs/prompting.md#plugin-sections-that-change).
   */
  sections: readonly RenderedPluginSection[];
  /**
   * The window this prefix was built for, when it was built for one. A section
   * that declares itself per window - one workspace per session, naming the
   * window it serves - makes the prefix that window's own, so an epoch is reused
   * only for the window it was built for
   * (docs/prompting.md#plugin-sections-that-change).
   */
  window?: WindowRef;
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
  /**
   * The active set of the current period, kept across the prefixes built inside
   * it: a per-window section rebuilds the prefix for each window and reads the
   * notes once per period, not once per window.
   */
  private active: { items: readonly NoteSummary[]; at: number } | undefined;
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

  /**
   * The frozen prefix of the current epoch, for the window it is asked for.
   *
   * `window` is the window the prefix is built for. A section that declares
   * itself per window - one workspace per session, naming the window it serves -
   * makes the prefix that window's own, so an epoch built for one window is
   * never handed to another; a host whose sections all say the same thing to
   * every window keeps one prefix shared by all of them. The active set stays
   * frozen for its own period either way, so a per-window section costs one
   * render and not one more read of the notes
   * (docs/memory.md#snapshot-epochs).
   *
   * `label` is the opaque label the embedding attached to what that window
   * serves, handed to a per-window section and never interpreted here
   * (docs/windows.md#what-a-window-serves).
   */
  async epoch(window?: WindowRef, label?: string): Promise<PromptEpoch> {
    const now = this.options.now?.() ?? Date.now();
    const minInterval = this.options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
    const plugins = this.options.plugins === undefined ? [] : this.options.plugins();
    // One section that renders per window is enough to make the prefix that
    // window's own, so the epoch is then reused only for the window it was built
    // for (docs/prompting.md#plugin-sections-that-change).
    const perWindow = plugins.some((section) => section.perWindow === true);
    // A plugin section that moved since this epoch was built rebuilds it at
    // once: a window opened now opens with what the section says now, rather
    // than a stale prefix plus a delta of its own opening
    // (docs/prompting.md#plugin-sections-that-change).
    if (
      this.current !== undefined &&
      (!perWindow || this.current.window === window) &&
      now - this.current.time < minInterval &&
      !(await this.sectionsMoved(this.current, plugins))
    ) {
      return this.current;
    }
    this.version += 1;
    const notes = await this.activeNotes();
    const env = this.options.env === undefined ? [] : await this.options.env();
    const envRevision =
      this.options.envRevision === undefined ? ("e0" as EnvRef) : await this.options.envRevision();
    const { system, sections } = await renderSystemPrompt(
      {
        settings: this.settings(),
        tools: this.options.tools === undefined ? [] : this.options.tools(),
        modules: this.options.modules === undefined ? [] : this.options.modules(),
        env,
        plugins,
      },
      this.renderer,
      window,
      label,
    );
    const epoch: PromptEpoch = {
      system,
      memory: renderMemorySnapshot(notes, this.renderer),
      envRevision,
      sections,
      ...(perWindow ? { window } : {}),
      version: this.version,
      time: now,
    };
    this.current = epoch;
    return epoch;
  }

  /**
   * True when any plugin section reports a revision this epoch was not built
   * with - the section's own content changed, or a section arrived or left. A
   * section that declares no revision is taken as one that never moves, so the
   * check is one cheap call per section and nothing is rendered.
   */
  private async sectionsMoved(epoch: PromptEpoch, plugins: readonly PromptSection[]): Promise<boolean> {
    const built = new Map(epoch.sections.map((section) => [section.tag, section.revision]));
    if (built.size !== plugins.length) return true;
    for (const plugin of plugins) {
      if (built.get(plugin.tag) !== (await sectionRevision(plugin))) return true;
    }
    return false;
  }

  /** The notes the memory snapshot carries, sorted by id. */
  private async activeNotes(): Promise<readonly NoteSummary[]> {
    const notes = this.options.notes;
    if (notes === undefined) return [];
    const now = this.options.now?.() ?? Date.now();
    const minInterval = this.options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
    // The active set is frozen for one period, not for one prefix: a section
    // that renders per window rebuilds the prefix for each window it serves,
    // and neither the notes nor the judge call behind them is rebuilt with it
    // (docs/memory.md#snapshot-epochs).
    if (this.active !== undefined && now - this.active.at < minInterval) return this.active.items;
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
    this.active = { items: snapshot.items, at: now };
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
