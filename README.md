# arbor

arbor is a framework for an agent without sessions: many context windows run
at once over one shared record, so work moves in parallel, replies come fast,
and every window can find everything that was ever done.

A deployment composes the pieces it wants and registers plugins for the domains
it serves. The framework guarantees what an agent cannot guarantee for itself -
the record, isolation, exactly-once effects, the checks, dispatch - and leaves
everything that takes judgment, such as git, merges and conflicts, to the agent.

## Status

Stage 7. Many windows run at once: dispatch decides for every task whether a
live window takes it or a new one opens, the judge (Jev by default) answers
what the rules leave open, and parallel windows stay current with each other
through the board, notices, broadcasts and window messages. The host also runs
the environment the model changes itself: `/env` with skills, MCP servers,
services and the settings, `reload` as one revision broadcast to every live
window, the services under a supervisor, and plugins as the one unit of
extension - hooks, prompt blocks, skills and MCP servers. One plugin runs the
whole host end to end: the HTTP test channel takes a webhook in, carries a
window's sends out, and serves the page a person drives it from. The host API
comes next.

No release is published yet. The first one follows the repository going public
and uses calendar versions under the `@4fu` scope
([docs/release.md](docs/release.md)).

## Core ideas

- **No sessions to manage.** Work runs in disposable context windows. Any
  number run at the same time; none of them owns anything, and a window that
  ends loses nothing. The model looks up what it needs instead of carrying it.
- **One record, shared live.** Every input, tool call, result, send and note
  revision goes into one journal and is visible to every window as
  soon as it is written. Records never merge and are never lost.
- **Dispatch by a judge.** A judge (Jev by default, replaceable) decides which
  live window takes a new input, or opens a new one. There is no router session
  and no main line.
- **Current without locks.** Windows run in parallel. New events on a
  conversation a window is in are steered into it as they arrive; only a note
  write is checked against the revision the window read.
- **Mechanisms in the framework, policy in the agent.** The framework
  guarantees what an agent cannot guarantee for itself - the record, isolation,
  exactly-once effects, the checks, dispatch. Everything that takes judgment,
  such as git, merges and conflicts, is the agent's.
- **A directory per window.** Each window gets its own directory, and a
  continuation keeps working in its predecessor's directory in place. It is not
  bound to a repository; the agent clones and pushes what it needs.
- **A self-changing environment.** The model adds and changes skills, MCP
  servers and resident services itself; a `reload` validates the change and
  broadcasts it to every live window as a delta of names and descriptions.
- **Minimal limits.** The framework sets no policy. Permissions, privacy
  review, budgets and approvals belong to deployments built on it, through
  hooks.
- **Direct tools plus code mode.** Decisions are direct tools; everything else
  is a module called from `code_exec`. There is no CLI.
- **Every module is replaceable.** The agent backend (pi by default), the
  journal, notes, workspaces, the judge, channels and the rest are interfaces
  ([docs/architecture.md](docs/architecture.md#interfaces)).

## Install

Node 24 or newer. Every package is published separately, so a deployment
installs the core and the defaults it wants:

```sh
npm install @4fu/arbor-core @4fu/arbor-journal-sqlite @4fu/arbor-notes-sqlite \
  @4fu/arbor-environment-dir @4fu/arbor-supervisor-process @4fu/arbor-agent-pi \
  @4fu/arbor-workspace-dir
```

`@4fu/arbor-plugin-http` is optional; it is the example plugin below.
`@4fu/arbor-segmenter-jieba` is an optional peer of the journal.

## A minimal host

The smallest host needs a journal and a backend. Adding the defaults and one
plugin is what a deployment usually starts from:

```js
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Arbor } from "@4fu/arbor-core";
import { DirectoryEnvironment } from "@4fu/arbor-environment-dir";
import { SqliteJournal } from "@4fu/arbor-journal-sqlite";
import { SqliteNoteStore } from "@4fu/arbor-notes-sqlite";
import { ProcessSupervisor } from "@4fu/arbor-supervisor-process";
import { DirectoryWorkspace } from "@4fu/arbor-workspace-dir";
import { PiAgentBackend } from "@4fu/arbor-agent-pi";
import { HttpChannel, httpPlugin } from "@4fu/arbor-plugin-http";

const root = await mkdtemp(join(tmpdir(), "arbor-"));

// Every module below is a default implementation of an interface. Replace any
// one by passing your own; the host does not change.
const journal = new SqliteJournal({ path: join(root, "journal.sqlite") });
const notes = new SqliteNoteStore({ path: join(root, "notes.sqlite"), journal });
const supervisor = new ProcessSupervisor({ root: join(root, "services") });
const environment = new DirectoryEnvironment({ root: join(root, "env"), supervisor });
const workspace = new DirectoryWorkspace({ root: join(root, "workspaces") });

// A plugin adds; it never patches the core. This one is a chat channel: a
// webhook in, a window's sends out, and a page that drives the whole host.
let arbor;
const channel = new HttpChannel({ host: "127.0.0.1", port: 8787, board: () => arbor.boardLines() });
arbor = new Arbor({
  journal,
  notes,
  backend: new PiAgentBackend(),
  workspace,
  environment,
  supervisor,
  plugins: [httpPlugin({ channel })],
});

await arbor.start();
await channel.listen();
```

`arbor.open(task)` dispatches one task, and the journal is where everything that
happened can be read back ([docs/journal.md](docs/journal.md)). The workspace a
window gets, and how a continuation keeps working in it, are in
[docs/workspaces.md](docs/workspaces.md).

## Packages

| Package | What it is |
| --- | --- |
| [`@4fu/arbor-interfaces`](packages/interfaces) | every replaceable interface, plus the core's own shapes. Types only. |
| [`@4fu/arbor-errors`](packages/errors) | the error shape every refusal uses: the rule and the next action |
| [`@4fu/arbor-prompt`](packages/prompt) | typed blocks, the one deterministic renderer and the replaceable text table |
| [`@4fu/arbor-tools`](packages/tools) | the entry points: direct tools, code mode modules, the host API |
| [`@4fu/arbor-journal-sqlite`](packages/journal-sqlite) | the default `Journal` and `BlobStore` on SQLite |
| [`@4fu/arbor-notes-sqlite`](packages/notes-sqlite) | the default `NoteStore` on SQLite, beside the journal |
| [`@4fu/arbor-segmenter-jieba`](packages/segmenter-jieba) | the default `Segmenter`: jieba's dictionary segmentation for the word index, optional |
| [`@4fu/arbor-workspace-dir`](packages/workspace-dir) | the default `Workspace`: one directory per window, with a continuation working in its predecessor's directory in place |
| [`@4fu/arbor-environment-dir`](packages/environment-dir) | the default `Environment`: one `/env` directory, a revision per item, validation and deltas |
| [`@4fu/arbor-supervisor-process`](packages/supervisor-process) | the default `Supervisor`: one host process per service, restart with backoff, logs |
| [`@4fu/arbor-judge-jev`](packages/judge-jev) | the default `Judge`: Jev, TypeSafe AI's System One classifier, answering the dispatch decisions |
| [`@4fu/arbor-agent-pi`](packages/agent-pi) | the default `AgentBackend`: pi-agent-core in process |
| [`@4fu/arbor-plugin-http`](packages/plugin-http) | the HTTP test channel: a webhook in, sends out, a page that drives the whole host |
| [`@4fu/arbor-core`](packages/core) | the service layer: one implementation of every operation - the window lifecycle, dispatch, coordination, the board, notes access, workspaces, effects and schedules |

### Defaults are examples

Every default above is a reference implementation of its interface, written to
be read and replaced. A real deployment is expected to swap out the ones that do
not fit: the SQLite journal and notes, the directory workspace, the process
supervisor, the environment directory, the HTTP test plugin and the Jev judge
are all examples of what an interface can be satisfied by, not commitments.
What a deployment keeps is its own choice, and the interfaces are the contract
([docs/architecture.md](docs/architecture.md#interfaces)).

Each package's own documentation holds the limits of that default, so a
deployment can see what it would be taking on before it adopts one.

## Documents

| Page | Contents |
| --- | --- |
| [docs/overview.md](docs/overview.md) | goals, concepts, principles, routes considered |
| [docs/architecture.md](docs/architecture.md) | layers, interfaces, stack, models, plugins, hooks, data placement |
| [docs/journal.md](docs/journal.md) | events and their order, targets, watermarks, external ids, refs, tracing, media, redaction |
| [docs/windows.md](docs/windows.md) | window lifecycle, prompt layout, reminders, continuation |
| [docs/dispatch.md](docs/dispatch.md) | task sources, judge decisions, insertion timing, backpressure, scheduled tasks |
| [docs/coordination.md](docs/coordination.md) | the board, expectations, deliveries and broadcasts, staying current, effects |
| [docs/environment.md](docs/environment.md) | skills, MCP servers and services: using, changing, reload, built-in skills, deltas |
| [docs/memory.md](docs/memory.md) | notes, the active set, anchors, links |
| [docs/workspaces.md](docs/workspaces.md) | per-window directories: isolation, continuity, what the agent does |
| [docs/tools.md](docs/tools.md) | direct tools and code mode modules |
| [docs/prompting.md](docs/prompting.md) | how every model-facing text is written: layers, notes, deliveries, errors, judge questions, terms |
| [docs/release.md](docs/release.md) | calendar versioning, the release workflow, how a package is published |

## Repository layout

`pnpm check` typechecks and tests every package on its TypeScript sources.
`pnpm build` emits the `dist` publishing needs, and `pnpm pack` shows what each
tarball would contain ([docs/release.md](docs/release.md)).

| Path | Layer |
| --- | --- |
| `packages/interfaces` | the interfaces layer: every replaceable interface, plus the core's own shapes. Types only. |
| `packages/errors` | the error shape every refusal uses: the rule and the next action |
| `packages/journal-sqlite` | the default `Journal` and `BlobStore` on SQLite |
| `packages/segmenter-jieba` | the default `Segmenter`: jieba's dictionary segmentation for the word index, optional |
| `packages/notes-sqlite` | the default `NoteStore` on SQLite, beside the journal |
| `packages/judge-jev` | the default `Judge`: Jev, TypeSafe AI's System One classifier, answering the dispatch decisions |
| `packages/workspace-dir` | the default `Workspace`: one directory per window, with a continuation working in its predecessor's directory in place, and the lookup of another window's directory it contributes to the catalog |
| `packages/environment-dir` | the default `Environment`: one `/env` directory, a revision per item, validation and deltas |
| `packages/supervisor-process` | the default `Supervisor`: one host process per service, restart with backoff, logs |
| `packages/plugin-http` | the HTTP test channel: a webhook in, sends out, a page that drives the whole host |
| `packages/prompt` | typed blocks, the one deterministic renderer and the replaceable text table |
| `packages/agent-pi` | the default `AgentBackend`: pi-agent-core in process |
| `packages/tools` | the entry points: direct tools, code mode modules, the host API |
| `packages/core` | the service layer: one implementation of every operation - the window lifecycle, dispatch, coordination, the board, notes access, workspaces, effects, schedules and the snapshot epochs |

`mise.toml` pins the toolchain - Node and pnpm - installed under
`~/.local/share/mise`, and `.agents/setup` prepares a machine from it. A machine
without mise is expected to carry Node 24 or newer and pnpm 12 already.

## License

MIT. The `LICENSE` file lands with the first release.
