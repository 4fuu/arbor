/**
 * The runnable entry point: compose the default stack around the HTTP test
 * channel and start the server.
 *
 * ```sh
 * DEEPSEEK_API_KEY=… JEV_API_KEY=… pnpm --filter @4fu/arbor-plugin-http start
 * ```
 *
 * Every module is the default one - the SQLite journal and notes, Jev, the
 * directory environment, the workspace `openWorkspace` picks, pi as the backend
 * (docs/architecture.md#stack) - and the one plugin is the HTTP channel. Nothing
 * here is specific to this plugin: a deployment that plugs a different channel in
 * composes the same stack the same way.
 *
 * Configuration names a secret and never holds its value
 * (docs/architecture.md#data-placement). The keys pi and Jev read are
 * environment variables those two modules read themselves; the settings name
 * them, and the host's scrub keeps their values out of the journal, out of the
 * judge's requests and out of what the model reads.
 *
 * | Name | What it names | Default |
 * | --- | --- | --- |
 * | `ARBOR_DATA_DIR` | where the journal, notes, `/env` and the workspaces live | `./.arbor/http` |
 * | `ARBOR_HOST` | the host the page binds | `127.0.0.1` |
 * | `ARBOR_PORT` | the port the page binds | `8787` |
 * | `ARBOR_MODEL` | the model the `chat` tier maps to | `deepseek-flash` |
 * | `DEEPSEEK_API_KEY` | pi's key for DeepSeek | - |
 * | `JEV_API_KEY` | Jev's key | - |
 *
 * The page is a local test tool: it binds localhost by default, and visibility,
 * permissions and auth are deferred.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Arbor, openWorkspace } from "@4fu/arbor-core";
import { DirectoryEnvironment } from "@4fu/arbor-environment-dir";
import { SqliteJournal } from "@4fu/arbor-journal-sqlite";
import { SqliteNoteStore } from "@4fu/arbor-notes-sqlite";
import { ProcessSupervisor } from "@4fu/arbor-supervisor-process";
import { PiAgentBackend } from "@4fu/arbor-agent-pi";
import type { Settings } from "@4fu/arbor-interfaces";
import { HttpChannel } from "./channel.ts";
import { httpPlugin } from "./plugin.ts";

/** The environment variables this entry point reads. None of them is a secret. */
const DATA_DIR = process.env.ARBOR_DATA_DIR ?? join(tmpdir(), "arbor-http");
const HOST = process.env.ARBOR_HOST ?? "127.0.0.1";
const PORT = Number(process.env.ARBOR_PORT ?? 8787);
const MODEL = process.env.ARBOR_MODEL ?? "deepseek-flash";

/** The tier a new window runs at, and what that tier is for. */
const TIER = "chat";

/** The secrets this configuration names. Their values stay in the environment. */
const SECRETS = ["DEEPSEEK_API_KEY", "JEV_API_KEY"] as const;

const SETTINGS: Settings = {
  identity: "arbor 的 HTTP 测试频道接线员",
  generalRules: ["用中文回答", "回答要短"],
  modelTiers: { [TIER]: MODEL },
  defaultTier: TIER,
  judge: {
    tierCriteria: {
      [TIER]: "A short conversational message on the HTTP test channel, where a fast model is enough.",
    },
  },
  window: { idleSeconds: 120 },
  secrets: [...SECRETS],
};

async function main(): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  const journal = new SqliteJournal({ path: join(DATA_DIR, "journal.sqlite") });
  const notes = new SqliteNoteStore({ path: join(DATA_DIR, "notes.sqlite"), journal });
  const supervisor = new ProcessSupervisor({ root: join(DATA_DIR, "services") });

  // The workspace is chosen before the environment, because an implementation
  // seeds its own built-in skill - the ovnfs workspace seeds the `ovnfs` skill -
  // which the environment installs read-only beside its own. ovnfs is the host
  // default: it is used when its binary is found and its daemon starts, and the
  // plain directory workspace is the fallback when it is not
  // (docs/workspaces.md).
  const workspaces = SETTINGS.workspaces ?? {};
  const shared = workspaces.shared ?? join(DATA_DIR, "shared");
  await mkdir(shared, { recursive: true });
  const { workspace, backend } = await openWorkspace({
    root: join(DATA_DIR, "workspaces"),
    source: shared,
    state: workspaces.ovnfs?.state ?? join(DATA_DIR, "ovnfs", "state"),
    mount: workspaces.ovnfs?.mount ?? join(DATA_DIR, "ovnfs", "checkouts"),
    ...(workspaces.ovnfs?.bin === undefined ? {} : { bin: workspaces.ovnfs.bin }),
    journal,
    warn: (message) => console.warn(message),
  });

  const environment = new DirectoryEnvironment({
    root: join(DATA_DIR, "env"),
    supervisor,
    // A service's secret is read from the environment by name, never held here.
    secretOf: (name) => process.env[name],
    // The workspace implementation's own skill, seeded read-only.
    builtinSkills: workspace.builtinSkills?.() ?? [],
  });

  // The settings are installed, so they live in `/env` where the model changes
  // them with `reload`, and the host reads them back at every change.
  const seed = join(DATA_DIR, "seed");
  await mkdir(seed, { recursive: true });
  const settingsPath = join(seed, "settings.json");
  await writeFile(settingsPath, JSON.stringify(SETTINGS, null, 2), "utf8");
  await environment.install([{ kind: "settings", name: "settings", path: settingsPath }]);

  // The channel is created before the host and reads the board from it, so the
  // plugin holds no reference to the host and the deployment supplies one.
  let arbor: Arbor | undefined;
  const channel = new HttpChannel({
    host: HOST,
    port: PORT,
    board: () => arbor?.boardLines() ?? [],
  });
  arbor = new Arbor({
    journal,
    notes,
    backend: new PiAgentBackend(),
    workspace,
    environment,
    supervisor,
    settings: SETTINGS,
    // The judge is the default: Jev, which reads `JEV_API_KEY` per request. A
    // host without one falls back on every decision's own rule.
    plugins: [httpPlugin({ channel })],
  });
  await arbor.start();
  const address = await channel.listen();

  const models = await arbor.models();
  console.log(`arbor: HTTP test channel on ${address}`);
  console.log(`arbor: journal ${join(DATA_DIR, "journal.sqlite")}, model ${SETTINGS.modelTiers?.[TIER]}`);
  console.log(`arbor: workspace ${backend === "ovnfs" ? `ovnfs (shared ${shared})` : `plain directory ${join(DATA_DIR, "workspaces")}`}`);
  console.log(`arbor: ${models.length} models in the catalog, ${arbor.channels().length} channel plugged in`);
  console.log(`arbor: open ${address} in a browser, or POST a message to ${address}/webhook`);

  const stop = async (): Promise<void> => {
    await channel.close();
    await arbor?.close();
  };
  process.on("SIGINT", () => void stop().then(() => process.exit(0)));
  process.on("SIGTERM", () => void stop().then(() => process.exit(0)));
}

await main();
