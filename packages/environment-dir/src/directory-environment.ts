/**
 * The default `Environment`: one shared directory, read-only for every window
 * at `/env` (docs/environment.md).
 *
 * ```text
 * <root>/env/skills/<name>/            a skill, with its scripts beside it
 * <root>/env/mcp/<name>.json           an MCP server's configuration
 * <root>/env/mcp/<name>/<name>.json    an MCP server that brought its own code
 * <root>/env/services/<name>/svc.json  a service, beside its files
 * <root>/env/settings.json             identity, rules, judge, model tiers
 * <root>/revisions/<kind>/<name>/<n>/  one copy of every installed revision
 * <root>/index.json                    the items and their revisions
 * ```
 *
 * Each item has its own revision, so two windows changing different items never
 * conflict. A draft is staged and validated before anything is replaced, so a
 * refused `reload` changes nothing: an item is replaced as a whole, and a
 * service that fails its health check is rolled back to the revision it had.
 *
 * The built-in skills ship with the framework and are seeded on first use. They
 * are read-only: the model writes its own skills beside them.
 */

import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { arborError, type ArborErrorInfo } from "@4fu/arbor-errors";
import type {
  EnvDelta,
  EnvDraft,
  EnvItem,
  EnvItemKind,
  EnvItemName,
  EnvItemRef,
  EnvRef,
  EnvRevision,
  EnvValidation,
  Environment,
  FunctionSpec,
  ServiceSpec,
  Settings,
  Supervisor,
} from "@4fu/arbor-interfaces";
import { StdioMcpServer } from "./mcp.ts";
import { textOf, zhTextTable } from "@4fu/arbor-prompt";

/** What a window reads the environment at, which is read-only for it. */
const ENV_PREFIX = "/env";

/** The built-in skills, seeded read-only on first use. */
export const BUILTIN_SKILLS = ["arbor-skill", "arbor-mcp", "arbor-service", "arbor-settings"] as const;

/** The built-in skill that covers each kind, which every refusal names. */
export const BUILTIN_SKILL_PATH: Record<EnvItemKind, string> = {
  skill: "/env/skills/arbor-skill/SKILL.md",
  mcp: "/env/skills/arbor-mcp/SKILL.md",
  service: "/env/skills/arbor-service/SKILL.md",
  settings: "/env/skills/arbor-settings/SKILL.md",
};

/** The one line an MCP server's item carries when its configuration says nothing. */
const MCP_DESCRIPTION = "一个 MCP 服务器，它的函数在 code_exec 中调用。";

/** The one line the settings item carries. */
const SETTINGS_DESCRIPTION = "身份、通用规则、judge、模型分层和各项阈值。";

/** The prefix an item's ref carries, one per kind. */
const KIND_PREFIX = {
  skill: "sk",
  mcp: "mcp",
  service: "svc",
  settings: "set",
} as const satisfies Record<EnvItemKind, string>;

/** The spellings a model may use for a kind: `skill:deploy`, `sk:deploy`. */
const KIND_ALIASES: Record<string, EnvItemKind> = {
  skill: "skill",
  sk: "skill",
  mcp: "mcp",
  server: "mcp",
  service: "service",
  svc: "service",
  settings: "settings",
  set: "settings",
};

/** One item, as the index keeps it. */
interface IndexEntry {
  ref: EnvItemRef;
  kind: EnvItemKind;
  name: string;
  description: string;
  /** The path a window reads the item at, under the mount. */
  path?: string;
  revision: number;
  time: number;
  builtin?: boolean;
  /** An MCP server's functions, listed when it was last validated. */
  functions?: readonly FunctionSpec[];
  /** The item's own file or directory, relative to the root. */
  target: string;
  /** The configuration the item was last installed with. */
  spec?: ServiceSpec;
}

/** What the index file holds. */
interface IndexFile {
  revision: number;
  items: IndexEntry[];
}

/** One draft, copied into the staging area. */
interface StagedDraft extends EnvDraft {
  /** True when the draft was a directory, which decides an item's layout. */
  directory: boolean;
}

/** One staged draft that passed validation. */
interface CheckedDraft {
  draft: StagedDraft;
  description: string;
  functions?: readonly FunctionSpec[];
  spec?: ServiceSpec;
}

/** What a draft is worth once it parses. */
type Checked = Omit<CheckedDraft, "draft">;

/** One draft's outcome: what it is worth, or the rule that refused it. */
type Outcome = { ok: true; value: Checked } | { ok: false; error: ArborErrorInfo };

export interface DirectoryEnvironmentOptions {
  /** The directory the environment lives in. */
  root: string;
  /** What a window reads the environment at. Defaults to `<root>/env`. */
  mount?: string;
  /** The service supervisor. Absent when no service may run. */
  supervisor?: Supervisor;
  /** Where a secret's value comes from. A configuration names one, never holds it. */
  secretOf?: (name: string) => string | undefined;
  /**
   * One fixed string from the deployment's text table, so this implementation
   * writes none of its own (docs/prompting.md#language-and-the-text-table).
   * Defaults to the framework's own Chinese table.
   */
  text?: (key: string, args?: Record<string, string | number>) => string;
  /**
   * Extra built-in skills to seed read-only on first use, each a name and the
   * directory its `SKILL.md` lives in. The workspace implementation contributes
   * its own this way - the ovnfs workspace seeds the `ovnfs` skill
   * (docs/workspaces.md).
   */
  builtinSkills?: readonly { name: string; source: string }[];
  /** The clock. Tests pass a fixed one. */
  now?: () => number;
}

export class DirectoryEnvironment implements Environment {
  /** What a window reads the environment at. */
  readonly mount: string;
  /** The directory the environment lives in, which the host reads. */
  readonly directory: string;

  private readonly root: string;
  private readonly supervisor: Supervisor | undefined;
  private readonly secretOf: ((name: string) => string | undefined) | undefined;
  /** The table every refusal this implementation raises is written from. */
  private readonly text: (key: string, args?: Record<string, string | number>) => string;
  private readonly clock: () => number;
  /** Extra built-in skills an implementation seeds, name and source directory. */
  private readonly extraSkills: readonly { name: string; source: string }[];
  private index: IndexFile = { revision: 0, items: [] };
  /** Every environment revision, oldest first. */
  private log: EnvRevision[] = [];
  private ready: Promise<void> | undefined;

  constructor(options: DirectoryEnvironmentOptions) {
    this.root = options.root;
    this.mount = options.mount ?? ENV_PREFIX;
    this.directory = join(options.root, "env");
    this.supervisor = options.supervisor;
    this.secretOf = options.secretOf;
    this.text = options.text ?? ((key, args) => textOf(zhTextTable, key, args));
    this.clock = options.now ?? (() => Date.now());
    this.extraSkills = options.builtinSkills ?? [];
  }

  async revision(): Promise<EnvRef> {
    return `e${(await this.read()).revision}` as EnvRef;
  }

  async list(): Promise<readonly EnvItem[]> {
    return (await this.read()).items.map((entry) => itemOf(entry));
  }

  async history(item?: EnvItemRef | EnvItemName): Promise<readonly EnvRevision[]> {
    await this.read();
    if (item === undefined) return [...this.log];
    const wanted = itemKey(item);
    return this.log.filter((revision) => revision.changes.some((change) => itemKey(change.item.ref) === wanted));
  }

  async settings(): Promise<Settings | undefined> {
    const index = await this.read();
    const entry = index.items.find((one) => one.kind === "settings");
    if (entry === undefined) return undefined;
    const text = await readText(join(this.root, entry.target));
    if (text === null) return undefined;
    return JSON.parse(text) as Settings;
  }

  async validate(drafts: readonly EnvDraft[]): Promise<EnvValidation> {
    await this.read();
    const staged = await this.stage(drafts);
    const items: { name: string; ok: boolean; error?: ArborErrorInfo }[] = [];
    for (const draft of staged) {
      const outcome = await this.check(draft);
      items.push({ name: draft.name, ok: outcome.ok, ...(outcome.ok ? {} : { error: outcome.error }) });
      await discard(draft);
    }
    return { ok: items.every((item) => item.ok), items };
  }

  async install(drafts: readonly EnvDraft[], remove?: readonly (EnvItemRef | EnvItemName)[]): Promise<EnvRevision> {
    const index = await this.read();
    const removals: readonly (EnvItemRef | EnvItemName)[] = [...(remove ?? [])];
    if (drafts.length === 0 && removals.length === 0) {
      throw arborError({
        code: "invalid_input",
        rule: "env.empty",
        message: this.text("refused.env.empty"),
        nextAction: this.text("next.env.empty"),
      });
    }
    // Everything is staged and checked before anything is replaced, so a refusal
    // leaves the environment exactly as it was.
    const staged = await this.stage(drafts);
    const checked = await this.checkAll(staged);
    const leaving = this.leaving(removals, index);
    this.checkRevisions(checked, index);

    const time = this.clock();
    const changes: { change: "added" | "changed" | "removed"; item: EnvItem }[] = [];
    for (const draft of checked) {
      const previous = index.items.find((entry) => entry.kind === draft.draft.kind && entry.name === draft.draft.name);
      const entry = await this.apply(draft, previous, time);
      const at = index.items.findIndex((one) => one.kind === entry.kind && one.name === entry.name);
      if (at === -1) index.items.push(entry);
      else index.items[at] = entry;
      changes.push({
        change: previous === undefined ? "added" : "changed",
        item: itemOf(entry),
      });
    }
    for (const entry of leaving) {
      await this.removeItem(entry);
      index.items = index.items.filter((one) => one.ref !== entry.ref);
      changes.push({ change: "removed", item: itemOf(entry) });
    }

    index.revision += 1;
    const revision: EnvRevision = {
      ref: `e${index.revision}` as EnvRef,
      previous: this.log.at(-1)?.ref ?? null,
      time,
      window: null,
      changes,
    };
    this.log.push(revision);
    await this.write(index);
    return revision;
  }

  async remove(items: readonly (EnvItemRef | EnvItemName)[]): Promise<EnvRevision> {
    return this.install([], items);
  }

  async delta(since: EnvRef): Promise<EnvDelta> {
    const index = await this.read();
    const from = revisionNumber(since);
    const current = `e${index.revision}` as EnvRef;
    if (from >= index.revision) return { revision: current, previous: since, items: [] };
    // What the window had when it opened, walked from the log rather than
    // guessed: an item revision and an environment revision are different
    // numbers.
    const had = new Set<string>();
    const latest = new Map<string, { change: EnvDelta["items"][number]["change"]; item: EnvItem }>();
    for (const revision of this.log) {
      const at = revisionNumber(revision.ref);
      for (const change of revision.changes) {
        const key = itemKey(change.item.ref);
        if (at <= from) {
          if (change.change === "removed") had.delete(key);
          else had.add(key);
          continue;
        }
        latest.set(key, { change: change.change, item: change.item });
      }
    }
    const items: { change: "added" | "changed" | "removed"; item: EnvItem }[] = [];
    for (const key of [...latest.keys()].sort()) {
      const change = latest.get(key);
      if (change === undefined) continue;
      const now = index.items.find((entry) => itemKey(entry.ref) === key);
      const was = had.has(key);
      // An item added and removed again inside the window never reached it, so
      // it is not named at all.
      if (now === undefined && !was) continue;
      if (now === undefined) {
        items.push({ change: "removed", item: change.item });
        continue;
      }
      if (was && change.change === "added") continue;
      items.push({ change: was ? "changed" : "added", item: itemOf(now) });
    }
    return { revision: current, previous: since, items };
  }

  /** Start every installed service again, after a host restart. */
  async resume(): Promise<void> {
    const index = await this.read();
    if (this.supervisor === undefined) return;
    for (const entry of index.items) {
      if (entry.kind !== "service" || entry.spec === undefined) continue;
      await this.supervisor.start(entry.spec).catch(() => {});
    }
  }

  async call(server: string, fn: string, args: Record<string, unknown>): Promise<string> {
    const index = await this.read();
    const entry = index.items.find((one) => one.kind === "mcp" && one.name === server);
    if (entry === undefined) {
      throw arborError({
        code: "not_found",
        rule: "env.mcp.notfound",
        message: this.text("refused.env.mcp.notfound", { name: server }),
        nextAction: this.text("next.env.mcp.notfound"),
        details: { server },
      });
    }
    const spec = entry.spec;
    if (spec === undefined || spec.command === "" || spec.dir === undefined) {
      throw arborError({
        code: "unavailable",
        rule: "mcp.url.unsupported",
        message: this.text("refused.mcp.url.unsupported", { name: server }),
        nextAction: this.text("next.mcp.url.unsupported"),
        details: { server },
      });
    }
    // A server is started for the call and stopped after it: an MCP server is a
    // capability, not a resident service, so it holds no pipe open on the host
    // between calls. A server that died is started again by the next call.
    const running = await this.serve(entry.name, spec);
    try {
      return await running.call(fn, args);
    } finally {
      await running.close();
    }
  }

  /** Start one MCP server for one call. */
  private async serve(name: string, spec: ServiceSpec): Promise<StdioMcpServer> {
    return StdioMcpServer.start({
      name,
      dir: spec.dir as string,
      command: spec.command,
      ...(spec.args === undefined ? {} : { args: spec.args }),
      ...(spec.secrets === undefined ? {} : { secrets: spec.secrets }),
      ...(spec.env === undefined ? {} : { env: spec.env }),
      ...(this.secretOf === undefined ? {} : { secretOf: this.secretOf }),
    });
  }

  // ---- staging and validation --------------------------------------------

  /** Copy every draft into the staging area, so nothing is read in place. */
  private async stage(drafts: readonly EnvDraft[]): Promise<StagedDraft[]> {
    const staged: StagedDraft[] = [];
    for (const draft of drafts) {
      const from = isAbsolute(draft.path) ? draft.path : resolve(process.cwd(), draft.path);
      const info = await stat(from).catch(() => null);
      if (info === null) {
        throw arborError({
          code: "not_found",
          rule: "env.draft.missing",
          message: this.text("refused.env.draft.missing", { path: draft.path }),
          nextAction: this.text("next.env.draft.missing"),
          details: { path: draft.path },
        });
      }
      const target = join(this.root, "staging", `${staged.length}-${draft.kind}-${safeName(draft.name)}`);
      await rm(target, { recursive: true, force: true });
      if (info.isDirectory()) {
        await cp(from, target, { recursive: true });
        staged.push({ ...draft, path: target, directory: true });
        continue;
      }
      await mkdir(target, { recursive: true });
      await cp(from, join(target, `${draft.name}.json`));
      staged.push({ ...draft, path: target, directory: false });
    }
    return staged;
  }

  /** Validate every staged draft, or refuse with the first one that failed. */
  private async checkAll(staged: readonly StagedDraft[]): Promise<CheckedDraft[]> {
    const checked: CheckedDraft[] = [];
    for (const draft of staged) {
      const outcome = await this.check(draft);
      if (outcome.ok) {
        checked.push({ draft, ...outcome.value });
        continue;
      }
      for (const one of staged) await discard(one);
      throw arborError({
        code: outcome.error.code,
        rule: outcome.error.rule,
        message: outcome.error.message,
        ...(outcome.error.nextAction === undefined ? {} : { nextAction: outcome.error.nextAction }),
        ...(outcome.error.details === undefined ? {} : { details: outcome.error.details }),
      });
    }
    return checked;
  }

  /** One staged draft: its description, and what its kind needs beyond that. */
  private async check(draft: StagedDraft): Promise<Outcome> {
    try {
      if (draft.kind === "skill") return { ok: true, value: { description: await this.checkSkill(draft) } };
      if (draft.kind === "settings") {
        await this.checkSettings(draft);
        return { ok: true, value: { description: SETTINGS_DESCRIPTION } };
      }
      if (draft.kind === "mcp") return { ok: true, value: await this.checkMcp(draft) };
      return { ok: true, value: await this.checkService(draft) };
    } catch (error: unknown) {
      return { ok: false, error: errorInfo(this.text, error, draft) };
    }
  }

  /** A skill parses: a title, then one line that says what it is for. */
  private async checkSkill(draft: StagedDraft): Promise<string> {
    const text = await readText(join(draft.path, "SKILL.md"));
    if (text === null) {
      throw arborError({
        code: "invalid_input",
        rule: "env.draft.skill",
        message: this.text("refused.env.draft.skill", { name: draft.name }),
        nextAction: this.text("next.env.draft.skill"),
        details: { name: draft.name },
      });
    }
    const lines = text.split("\n").map((line) => line.trim());
    if (lines[0]?.startsWith("# ") !== true) {
      throw arborError({
        code: "invalid_input",
        rule: "env.draft.skill.title",
        message: this.text("refused.env.draft.skill.title", { name: draft.name }),
        nextAction: this.text("next.env.draft.skill.title"),
        details: { name: draft.name },
      });
    }
    const description = lines.slice(1).find((line) => line !== "") ?? "";
    if (description === "") {
      throw arborError({
        code: "invalid_input",
        rule: "env.draft.skill.line",
        message: this.text("refused.env.draft.skill.line", { name: draft.name }),
        nextAction: this.text("next.env.draft.skill.line"),
        details: { name: draft.name },
      });
    }
    return description;
  }

  /** The settings parse into the settings shape. */
  private async checkSettings(draft: StagedDraft): Promise<void> {
    const text = await readText(join(draft.path, `${draft.name}.json`));
    if (text === null) {
      throw arborError({
        code: "invalid_input",
        rule: "env.draft.settings.missing",
        message: this.text("refused.env.draft.settings.missing", { path: draft.path, name: draft.name }),
        nextAction: this.text("next.env.draft.settings.missing"),
        details: { name: draft.name },
      });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error: unknown) {
      throw arborError({
        code: "invalid_input",
        rule: "env.draft.settings",
        message: this.text("refused.env.draft.settings", {
          message: error instanceof Error ? error.message : String(error),
        }),
        nextAction: this.text("next.env.draft.settings"),
      });
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw arborError({
        code: "invalid_input",
        rule: "env.draft.settings.shape",
        message: this.text("refused.env.draft.settings.shape"),
        nextAction: this.text("next.env.draft.settings.shape"),
      });
    }
  }

  /**
   * An MCP server starts and lists its functions. It runs from the staged
   * directory, so a draft that brought its own code is validated exactly as it
   * will run once installed.
   */
  private async checkMcp(draft: StagedDraft): Promise<Checked> {
    const config = await readJson(join(draft.path, `${draft.name}.json`));
    if (config === null) {
      throw arborError({
        code: "invalid_input",
        rule: "env.draft.mcp",
        message: this.text("refused.env.draft.mcp", { name: draft.name }),
        nextAction: this.text("next.env.draft.mcp"),
        details: { name: draft.name },
      });
    }
    const command = stringField(config, "command");
    const description = stringField(config, "description") || MCP_DESCRIPTION;
    if (command === "" && stringField(config, "url") === "") {
      throw arborError({
        code: "invalid_input",
        rule: "env.draft.mcp.command",
        message: this.text("refused.env.draft.mcp.command", { name: draft.name }),
        nextAction: this.text("next.env.draft.mcp.command"),
        details: { name: draft.name },
      });
    }
    const spec: ServiceSpec = {
      name: draft.name,
      command,
      ...(stringsField(config, "args") === undefined ? {} : { args: stringsField(config, "args") }),
      ...(stringsField(config, "secrets") === undefined ? {} : { secrets: stringsField(config, "secrets") }),
      ...(objectField(config, "env") === undefined ? {} : { env: objectField(config, "env") }),
    };
    if (command === "") {
      // A server already running elsewhere: its shape is all this
      // implementation can check without reaching the network.
      return { description, spec };
    }
    const server = await StdioMcpServer.start({
      dir: draft.path,
      ...spec,
      ...(this.secretOf === undefined ? {} : { secretOf: this.secretOf }),
    }).catch((error: unknown) => {
      throw arborError({
        code: "unavailable",
        rule: "env.draft.mcp.start",
        message: this.text("refused.env.draft.mcp.start", { name: draft.name }),
        nextAction: this.text("next.env.draft.mcp.start"),
        details: { name: draft.name, upstream: error instanceof Error ? error.message : String(error) },
        cause: error,
      });
    });
    try {
      return { description, functions: await server.functions(), spec };
    } finally {
      await server.close();
    }
  }

  /** A service's configuration parses, and it is started when it installs. */
  private async checkService(draft: StagedDraft): Promise<Checked> {
    const config = await readJson(join(draft.path, "svc.json"));
    if (config === null) {
      throw arborError({
        code: "invalid_input",
        rule: "env.draft.service",
        message: this.text("refused.env.draft.service", { name: draft.name }),
        nextAction: this.text("next.env.draft.service"),
        details: { name: draft.name },
      });
    }
    const command = stringField(config, "command");
    if (command === "") {
      throw arborError({
        code: "invalid_input",
        rule: "env.draft.service.command",
        message: this.text("refused.env.draft.service.command", { name: draft.name }),
        nextAction: this.text("next.env.draft.service.command"),
        details: { name: draft.name },
      });
    }
    if (this.supervisor === undefined) {
      throw arborError({
        code: "unavailable",
        rule: "env.supervisor.absent",
        message: this.text("refused.env.supervisor", { name: draft.name }),
        nextAction: this.text("next.env.supervisor"),
        details: { name: draft.name },
      });
    }
    const healthCheck = config.healthCheck as ServiceSpec["healthCheck"] | undefined;
    const restart = config.restart as ServiceSpec["restart"] | undefined;
    const quota = config.quota as ServiceSpec["quota"] | undefined;
    const args = stringsField(config, "args");
    const ports = numbersField(config, "ports");
    const secrets = stringsField(config, "secrets");
    const env = objectField(config, "env");
    return {
      description: stringField(config, "description") || `一个常驻服务：${command}`,
      spec: {
        name: draft.name,
        command,
        ...(args === undefined ? {} : { args }),
        ...(ports === undefined ? {} : { ports }),
        ...(healthCheck === undefined ? {} : { healthCheck }),
        ...(secrets === undefined ? {} : { secrets }),
        ...(restart === undefined ? {} : { restart }),
        ...(quota === undefined ? {} : { quota }),
        ...(env === undefined ? {} : { env }),
      },
    };
  }

  // ---- applying a change --------------------------------------------------

  /**
   * Replace one item as a whole, then start a service and wait for its health
   * check. A service that never becomes healthy is rolled back to the revision
   * it had, so a refused `reload` changes nothing.
   */
  private async apply(draft: CheckedDraft, previous: IndexEntry | undefined, time: number): Promise<IndexEntry> {
    const revision = (previous?.revision ?? 0) + 1;
    const entry: IndexEntry = {
      ref: `${KIND_PREFIX[draft.draft.kind]}:${draft.draft.name}@${revision}` as EnvItemRef,
      kind: draft.draft.kind,
      name: draft.draft.name,
      description: draft.description,
      revision,
      time,
      ...(draft.functions === undefined ? {} : { functions: draft.functions }),
      target: targetOf(draft.draft),
    };
    if (draft.draft.kind === "skill") entry.path = `${this.mount}/skills/${draft.draft.name}`;
    if (draft.draft.kind === "mcp") {
      entry.path = draft.draft.directory
        ? `${this.mount}/mcp/${draft.draft.name}/${draft.draft.name}.json`
        : `${this.mount}/mcp/${draft.draft.name}.json`;
    }
    if (draft.draft.kind === "service") {
      entry.path = `${this.mount}/services/${draft.draft.name}/svc.json`;
      entry.spec = { ...(draft.spec as ServiceSpec), dir: join(this.root, entry.target) };
    }
    if (draft.draft.kind === "settings") entry.path = `${this.mount}/settings.json`;
    if (draft.draft.kind === "mcp" && draft.spec !== undefined) {
      entry.spec = {
        ...draft.spec,
        // The command runs in the item's own directory, so a server that brought
        // its code finds it where it installed it.
        dir: draft.draft.directory
          ? join(this.root, entry.target)
          : dirname(join(this.root, entry.target)),
      };
    }

    // The revision the item had is kept before it is replaced, so a failed
    // install can put it back.
    if (previous !== undefined) await this.keepRevision(previous);
    await copyTree(configOf(draft.draft), join(this.root, entry.target));

    if (draft.draft.kind === "service" && this.supervisor !== undefined && entry.spec !== undefined) {
      try {
        await this.supervisor.start(entry.spec);
      } catch (error: unknown) {
        await this.rollback(entry, previous);
        throw arborError({
          code: "unavailable",
          rule: "env.draft.service.health",
          message: this.text("refused.env.draft.service.health", { name: draft.draft.name }),
          nextAction: this.text("next.env.draft.service.health"),
          details: { name: draft.draft.name, upstream: error instanceof Error ? error.message : String(error) },
          cause: error,
        });
      }
    }
    await this.keepRevision(entry);
    return entry;
  }

  /** Put the revision an item had back, after a failed install. */
  private async rollback(entry: IndexEntry, previous: IndexEntry | undefined): Promise<void> {
    const target = join(this.root, entry.target);
    await rm(target, { recursive: true, force: true });
    if (previous === undefined) return;
    await copyTree(join(this.root, "revisions", KIND_PREFIX[previous.kind], previous.name, `${previous.revision}`), target);
  }

  /** Stop a service and remove its files. */
  private async removeItem(entry: IndexEntry): Promise<void> {
    if (entry.kind === "service" && this.supervisor !== undefined) {
      await this.supervisor.stop(entry.name).catch(() => {});
    }
    await rm(join(this.root, entry.target), { recursive: true, force: true });
  }

  /** Keep one copy of an installed revision, so a revert can install it again. */
  private async keepRevision(entry: IndexEntry): Promise<void> {
    await copyTree(join(this.root, entry.target), join(this.root, "revisions", KIND_PREFIX[entry.kind], entry.name, `${entry.revision}`));
  }

  /**
   * The revision check (docs/environment.md#changing-the-environment): a draft
   * is based on the revision its window read, and another window that installed
   * a newer one since refuses the call, so the model merges and calls again.
   */
  private checkRevisions(checked: readonly CheckedDraft[], index: IndexFile): void {
    for (const draft of checked) {
      const installed = index.items.find(
        (entry) => entry.kind === draft.draft.kind && entry.name === draft.draft.name,
      );
      const read = draft.draft.copiedFrom;
      if (installed === undefined || read === undefined || installed.revision <= read) continue;
      throw arborError({
        code: "conflict",
        rule: "env.draft.stale",
        message: this.text("refused.env.stale", {
          item: installed.ref,
          revision: installed.revision,
          read,
        }),
        nextAction: this.text("next.env.stale", { skill: BUILTIN_SKILL_PATH[draft.draft.kind] }),
        details: { item: installed.ref, revision: installed.revision, read },
      });
    }
  }

  /** The items a `reload({ remove })` names, or a refusal naming what is missing. */
  private leaving(removals: readonly (EnvItemRef | EnvItemName)[], index: IndexFile): IndexEntry[] {
    const leaving: IndexEntry[] = [];
    for (const wanted of removals) {
      const key = itemKey(wanted);
      const entry = index.items.find((one) => itemKey(one.ref) === key);
      if (entry === undefined) {
        throw arborError({
          code: "not_found",
          rule: "env.notfound",
          message: this.text("refused.env.notfound", { item: wanted }),
          nextAction: this.text("next.env.notfound"),
          details: { item: wanted },
        });
      }
      if (entry.builtin === true) {
        throw arborError({
          code: "refused",
          rule: "env.readonly",
          message: this.text("refused.env.readonly", { item: entry.ref }),
          nextAction: this.text("next.env.readonly"),
          details: { item: entry.ref },
        });
      }
      if (!leaving.includes(entry)) leaving.push(entry);
    }
    return leaving;
  }

  // ---- the index ----------------------------------------------------------

  /** The index, seeded with the built-in skills on first use. */
  private async read(): Promise<IndexFile> {
    if (this.ready === undefined) {
      this.ready = this.load().catch((error: unknown) => {
        this.ready = undefined;
        throw error;
      });
    }
    await this.ready;
    return this.index;
  }

  private async load(): Promise<void> {
    const text = await readText(join(this.root, "index.json"));
    if (text !== null) {
      const parsed = JSON.parse(text) as IndexFile;
      this.index = { revision: parsed.revision ?? 0, items: parsed.items ?? [] };
      const log = await readText(join(this.root, "revisions.json"));
      this.log = log === null ? [] : (JSON.parse(log) as EnvRevision[]);
    }
    await this.seedBuiltins();
    await this.write(this.index);
  }

  /** Copy the built-in skills in, read-only, when they are not there yet. */
  private async seedBuiltins(): Promise<void> {
    const here = fileURLToPath(new URL(".", import.meta.url));
    const shipped = BUILTIN_SKILLS.map((name) => ({ name, source: join(here, "skills", name) }));
    for (const { name, source } of [...shipped, ...this.extraSkills]) {
      if (this.index.items.some((entry) => entry.name === name)) continue;
      const target = join(this.root, "env", "skills", name);
      await mkdir(dirname(target), { recursive: true });
      await cp(source, target, { recursive: true });
      const text = await readText(join(target, "SKILL.md"));
      const lines = (text ?? "").split("\n").map((line) => line.trim());
      const entry: IndexEntry = {
        ref: `sk:${name}@1` as EnvItemRef,
        kind: "skill",
        name,
        description: lines.slice(1).find((line) => line !== "") ?? "",
        path: `${this.mount}/skills/${name}`,
        revision: 1,
        time: this.clock(),
        builtin: true,
        target: join("env", "skills", name),
      };
      this.index.items.push(entry);
      await this.keepRevision(entry);
    }
  }

  private async write(index: IndexFile): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await writeFile(join(this.root, "index.json"), `${JSON.stringify(index, null, 2)}\n`, "utf8");
    await writeFile(join(this.root, "revisions.json"), `${JSON.stringify(this.log, null, 2)}\n`, "utf8");
  }
}

/** One index entry as every other layer sees it. */
function itemOf(entry: IndexEntry): EnvItem {
  return {
    ref: entry.ref,
    kind: entry.kind,
    name: entry.name,
    description: entry.description,
    ...(entry.path === undefined ? {} : { path: entry.path }),
    revision: entry.revision,
    time: entry.time,
    ...(entry.builtin === undefined ? {} : { builtin: entry.builtin }),
    ...(entry.functions === undefined ? {} : { functions: entry.functions }),
  };
}

/** `sk:deploy@4` and `skill:deploy` both address the item `sk:deploy`. */
function itemKey(ref: string): string {
  const match = /^(sk|mcp|svc|set|skill|server|service|settings):([^@]+)/.exec(ref);
  if (match === null) return ref;
  const kind = KIND_ALIASES[match[1] ?? ""] ?? "skill";
  return `${KIND_PREFIX[kind]}:${match[2] ?? ""}`;
}

/** An environment revision's number, so the log can be walked. */
function revisionNumber(ref: string): number {
  return Number(/^e(\d+)$/.exec(ref)?.[1] ?? 0);
}

/**
 * Where an item's own files live, relative to the root. An MCP server that
 * brought its own code keeps the whole directory, so its command runs beside it.
 */
function targetOf(draft: StagedDraft): string {
  if (draft.kind === "settings") return join("env", `${draft.name}.json`);
  if (draft.kind === "skill") return join("env", "skills", draft.name);
  if (draft.kind === "service") return join("env", "services", draft.name);
  return draft.directory ? join("env", "mcp", draft.name) : join("env", "mcp", `${draft.name}.json`);
}

/** The file a staged draft holds its configuration in. */
function configOf(draft: StagedDraft): string {
  return draft.directory ? draft.path : join(draft.path, `${draft.name}.json`);
}

/** Copy a file or a whole directory onto a path, replacing what was there. */
async function copyTree(from: string, to: string): Promise<void> {
  const info = await stat(from).catch(() => null);
  if (info === null) return;
  if (info.isDirectory()) {
    await rm(to, { recursive: true, force: true });
    await mkdir(dirname(to), { recursive: true });
    await cp(from, to, { recursive: true });
    return;
  }
  await mkdir(dirname(to), { recursive: true });
  await cp(from, to);
}

/** Clean up one staged draft, whether it was installed or refused. */
async function discard(draft: StagedDraft): Promise<void> {
  await rm(draft.path, { recursive: true, force: true }).catch(() => {});
}

function errorInfo(
  text: (key: string, args?: Record<string, string | number>) => string,
  error: unknown,
  draft: StagedDraft,
): ArborErrorInfo {
  const info = error as { code?: string; rule?: string; message?: string; nextAction?: string; details?: Record<string, unknown> };
  if (info.rule === undefined) {
    return {
      code: "invalid_input",
      rule: "env.draft",
      message: text("refused.env.draft", {
        path: draft.path,
        kind: draft.kind,
        message: error instanceof Error ? error.message : String(error),
      }),
      nextAction: text("next.env.draft"),
    };
  }
  return {
    code: info.code ?? "invalid_input",
    rule: info.rule,
    message: info.message ?? "",
    ...(info.nextAction === undefined ? {} : { nextAction: info.nextAction }),
    ...(info.details === undefined ? {} : { details: info.details }),
  };
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  const text = await readText(path);
  if (text === null) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function stringField(config: Record<string, unknown>, key: string): string {
  const value = config[key];
  return typeof value === "string" ? value : "";
}

function stringsField(config: Record<string, unknown>, key: string): string[] | undefined {
  const value = config[key];
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === "string");
}

function numbersField(config: Record<string, unknown>, key: string): number[] | undefined {
  const value = config[key];
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is number => typeof item === "number" && Number.isFinite(item));
}

function objectField(config: Record<string, unknown>, key: string): Record<string, string> | undefined {
  const value = config[key];
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, string>;
}

function safeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}
