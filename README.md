# arbor

arbor is a framework for an agent without sessions: many context windows run
at once over one shared record, so work moves in parallel, replies come fast,
and every window can find everything that was ever done.

- **No sessions to manage.** Work runs in disposable context windows. Any
  number run at the same time; none of them owns anything, and a window that
  ends loses nothing. The model looks up what it needs instead of carrying it.
- **One record, shared live.** Every input, tool call, result, send and note
  revision goes into one journal and is visible to every window as
  soon as it is written. Records never merge and are never lost.
- **Dispatch by a judge.** A judge (Jev by default, replaceable) decides which
  live window takes a new input, or opens a new one. There is no router
  session and no main line.
- **Current without locks.** Windows run in parallel. New events on a
  conversation a window is in are steered into it as they arrive; only a note
  write is checked against the revision the window read.
- **Mechanisms in the framework, policy in the agent.** The framework
  guarantees what an agent cannot guarantee for itself - the record, isolation,
  exactly-once effects, the checks, dispatch. Everything that takes judgment,
  such as git, merges and conflicts, is the agent's.
- **A directory per window.** Each window gets its own directory on
  [LayerFS](https://github.com/Ephemeral-AI-Lab/layerfs), with forks for
  continuations and snapshots for every change. It is not bound to a
  repository; the agent clones and pushes what it needs.
- **A self-changing environment.** The model adds and changes skills, MCP
  servers and resident services itself; a `reload` validates the change and
  broadcasts it to every live window as a delta of names and descriptions.
- **Minimal limits.** The framework sets no policy. Permissions, privacy
  review, budgets and approvals belong to deployments built on it, through
  hooks.
- **Direct tools plus code mode.** Decisions are direct tools; everything else
  is a module called from `code_exec`. There is no CLI.
- **Every module is replaceable.** The agent backend (pi by default), the
  journal, notes, workspaces, the judge, channels and the rest are interfaces.

Status: stage 1. One window runs end to end: the pi backend, the prompt
layers, the direct tools and code mode modules, and the window lifecycle
with its continuations. Dispatch, notes, the environment and the host API
come next.

> The design grows out of the context, window and notes mechanisms built for
> [qqnt-gui-driver](https://github.com/4fuu/qqnt-gui-driver). This link is
> temporary and will be removed once arbor is built.

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
| [docs/workspaces.md](docs/workspaces.md) | per-window directories: isolation, forks, snapshots, what the agent does |
| [docs/tools.md](docs/tools.md) | direct tools and code mode modules |
| [docs/prompting.md](docs/prompting.md) | how every model-facing text is written: layers, notes, deliveries, errors, judge questions, terms |

## Repository layout

Node runs the TypeScript sources directly, so there is no build step: `pnpm
check` typechecks and tests every package.

| Path | Layer |
| --- | --- |
| `packages/interfaces` | the interfaces layer: every replaceable interface, plus the core's own shapes. Types only. |
| `packages/errors` | the error shape every refusal uses: the rule and the next action |
| `packages/journal-sqlite` | the default `Journal` and `BlobStore` on SQLite |
| `packages/segmenter-jieba` | the default `Segmenter`: jieba's dictionary segmentation for the word index, optional |
| `packages/notes-sqlite` | the default `NoteStore` on SQLite, beside the journal |
| `packages/workspace-layerfs` | the default `Workspace` on LayerFS: a directory per window, forks, snapshots, read-only mounts |
| `packages/judge-jev` | the default `Judge`: Jev, TypeSafe AI's System One classifier, answering the dispatch decisions |
| `packages/workspace-dir` | a plain-directory `Workspace`, for a deployment that never works with files |
| `packages/prompt` | typed blocks, the one deterministic renderer and the replaceable text table |
| `packages/agent-pi` | the default `AgentBackend`: pi-agent-core in process |
| `packages/tools` | the entry points: direct tools, code mode modules, the host API |
| `packages/core` | the service layer: one implementation of every operation |

`mise.toml` pins the toolchain - Node, pnpm and the Rust the LayerFS engine
builds with - installed under `~/.local/share/mise`, and `.agents/setup`
prepares a machine from it, or from system packages and rustup on an apt host.
`packages/workspace-layerfs/sandbox.Dockerfile` builds the image a LayerFS
Sandbox runs, from the pinned LayerFS commit, on the machine that has the
Docker Engine.
