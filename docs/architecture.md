# Architecture

## Layers

```text
┌ entry points ─────────────────────────────────────────────────┐
│ direct tools (the model) · code mode modules (the model)       │
│ host API (operators, consoles, plugins)                        │
├ service layer ─────────── the one implementation ─────────────┤
│ journal · windows · dispatch · board · notes · workspaces      │
│ effects · schedules · environment · services                   │
├ interfaces ───────────────── every one replaceable ───────────┤
│ AgentBackend · Journal · NoteStore · Workspace · Judge         │
│ Channel · TaskSource · EffectExecutor · ToolGroup · Scheduler  │
│ Environment · Supervisor                                       │
├ defaults ─────────────────────────────────────────────────────┤
│ pi · SQLite · LayerFS · Jev · simple scheduler                 │
└───────────────────────────────────────────────────────────────┘
```

**One service layer.** Every operation is implemented once. A direct tool and
a code mode function are thin wrappers of one service call: same arguments,
same behaviour, same errors. The host API calls the same layer. There is no
CLI and no second path around the layer.

## Interfaces

Each interface ships with a default. Replacing a module means implementing its
interface and registering it; nothing else changes.

| Interface | Responsibility | Default |
| --- | --- | --- |
| `AgentBackend` | run one window: send the prompt and tools to a model, stream tool calls, accept inputs inserted once a turn's tool calls finish (steering), report token usage and rate limits; list the models it can run and log in to their providers ([below](#models)) | [pi](https://github.com/earendil-works/pi) (pi-agent-core in process, with its code mode and model runtime) |
| `Journal` | append events, read, search, walk refs and links, keep watermarks | SQLite |
| `NoteStore` | notes: revisions, summaries, anchors, the active set | SQLite beside the journal |
| `Workspace` | a directory per window: create, fork, snapshot, mount read-only, reclaim | [LayerFS](https://github.com/Ephemeral-AI-Lab/layerfs) |
| `Judge` | answer the host's decisions: filter, route, model tier, notice, broadcast, active set ([dispatch.md](dispatch.md#judge-decisions)) | Jev |
| `Channel` | an outside source and sink: look up a message by its native id, list what is connected, report online state | none; plugins provide them |
| `TaskSource` | turn outside events into tasks, batching them | the host API |
| `EffectExecutor` | carry out effects from the effect queue | none; plugins provide them |
| `ToolGroup` | a set of direct tools and code mode modules | the built-in groups ([tools.md](tools.md)) |
| `Environment` | skills, MCP servers and services: revisions, validation, the shared `/env` mount, deltas ([environment.md](environment.md)) | a directory on `Workspace` |
| `Supervisor` | run services: start, health checks, restart with backoff, logs, quotas ([environment.md](environment.md#services)) | a host process supervisor |
| `Scheduler` | insertion timing, backpressure, scheduled tasks | simple rules ([dispatch.md](dispatch.md)) |

Besides the interfaces, hooks let a deployment add policy without replacing
a module ([below](#hooks)).

Rules for every interface:

- **No backend leaks.** No pi type, LayerFS id or SQL row crosses an
  interface; the core only sees its own shapes.
- **Errors name the next action.** An implementation returns errors in the
  core's error shape, so the model always reads the same kind of refusal.
- **Plugins add, they do not patch.** A domain (a chat bot, a coding agent)
  is a plugin ([below](#plugins)). It does not change the core.

## Stack

- **TypeScript on Node.js**, one host process. pi-agent-core runs every
  window in process, so steering, tool hooks and code mode are direct calls.
- **SQLite** for the journal, notes and host data.
- **LayerFS** for workspaces. Its core is Rust; TypeScript reaches it through
  its JavaScript packages (`@layerfs/agent`, `@layerfs/backend`,
  `@layerfs/runtime`) and a native binding, and `bash` runs in workspaces its
  daemon mounts over FUSE. That shapes the deployment:
  - Linux with `/dev/fuse`; macOS and Windows only through a Linux VM.
  - A Docker Engine speaking Engine API 1.48 (Docker Engine 28.0) or newer,
    because LayerFS's client refuses an older one before it sends a request.
    Podman's Docker-compatible socket is not enough: its compatibility API
    stops at 1.44, so `capabilities()` reports it unavailable with the
    version as the reason. The image a Sandbox runs is built from the pinned
    LayerFS commit with
    [`packages/workspace-layerfs/sandbox.Dockerfile`](packages/workspace-layerfs/sandbox.Dockerfile)
    and named by digest, never a tag.
  - Its Store is one SQLite file on ext4, xfs or btrfs - its own allowlist,
    because the locks that guard it live in the filesystem - and it runs
    without crash or power-loss durability, so the journal never depends on
    it: a lost snapshot loses a view of files, never a record.
  - It is young and its JavaScript API broke between 1.0 and 1.1, so its
    version is pinned behind `Workspace`.
  - pi already has a LayerFS extension, `pi-layerfs`, that backs pi's file
    and bash tools with LayerFS; it is a reference for the integration, not
    a dependency.
- **The toolchain** is project-local: `mise.toml` pins Node, pnpm and the
  Rust the LayerFS engine builds with, installed under `~/.local/share/mise`
  and never into `~/.cargo`. `.agents/setup` prepares a machine either that
  way (mise, for hosts without apt) or from system packages and rustup (apt).
  The rest of the build - a C compiler, pkg-config, fuse3 - stays a system
  package on both paths.

## Models

`AgentBackend` provides both the agent loop and the model list. The default
takes providers, models and login from pi's model runtime and the catalog
distributed through pi.dev, so a new model appears without code changes.
Only models that take images are offered. The judge picks a tier for each new
window ([dispatch.md](dispatch.md#model-tiers)), and settings map each tier
to a model.

## Plugins

A plugin is the one unit that extends the host. It bundles any of the parts
below; every part is optional, so a plugin can be only a hook, only a skill,
or a whole domain such as a chat channel or a code host:

| Part | What it gives |
| --- | --- |
| adapters | connections to the outside world: channels with their native ids ([journal.md](journal.md#external-ids)), task sources with their batching, effect executors |
| MCP servers | capabilities the model calls, installed into `/env` under the plugin's name ([environment.md](environment.md)) |
| skills | procedures, installed into `/env` under the plugin's name |
| hooks | any of the hooks below |
| prompt blocks | a system prompt section, and the block kinds its inputs use, which the renderer maps to text ([prompting.md](prompting.md#blocks-and-the-renderer)) |
| judge questions | extra criteria or decisions for its own inputs |

- **Capabilities are MCP servers, not tools.** A plugin adds no direct tool
  or module of its own; what the model can do with it is an MCP server and
  skills in `/env`. The model reads, changes and reinstalls them with
  `reload` like any item, so it can improve a plugin's abilities itself. A
  plugin upgrade installs a new revision on top; the model's changes stay in
  the item's history.
- **Plugging in** is an environment change: its items arrive in live windows
  as a delta, and its prompt section applies from the next epoch.
- **Unplugging never changes a prompt.** Open windows keep the system prompt
  and catalog they were built with. A call into a removed capability is
  refused with the rule and the ref of the change that removed it, and live
  windows get the removal as a delta. The next epoch leaves it out. Events
  the plugin recorded stay in the journal and their refs keep resolving.

## Hooks

The framework sets no policy of its own. A deployment or a plugin adds it
through hooks; each can observe, change or refuse, refusing in the core's
error shape:

| Hook | Runs |
| --- | --- |
| before and after append | around every journal event |
| before and after dispatch | around routing a task, with the judge's answer |
| before and after a judge request | around every judge decision, with its state |
| window start, end and continuation | when a window opens, ends or is continued |
| before a model request | with the rendered prompt and inputs, before they reach the backend |
| before a delivery | before a block is steered into a window |
| before and after a tool call | around every direct tool and module call |
| before an effect | when an effect leaves the queue; it can hold the effect for approval and release or drop it later |
| before and after a note write | around every note revision |
| before and after `reload` | around every environment change |
| service state change | when a service starts, fails or stops |

The host API lets an operator list, pause and end windows, steer an input
into one, and read the board. Permissions, privacy review, budgets and
approvals are built from these.

## Data placement

| Data | Where |
| --- | --- |
| events, watermarks, links | `Journal` |
| notes | `NoteStore` |
| files | `Workspace`: one directory per window, with its snapshots |
| skills, MCP and service configurations, settings | `Environment`: the `/env` directory, with revisions |
| service directories and logs | `Supervisor`, on `Workspace` |
| an event that changed files | the journal, with the snapshot id |
| effect queue, schedules, settings | host database |

There is no project boundary: a host has one journal, one set of notes and
one `/env`, and every window can read all of it.

## Room for many machines

For now one host runs on one machine. To leave room for more:

- Tools and plugins reach the host only through the host API, never through
  local files or the database.
- Ids and refs do not depend on a machine.
- `Journal` and `NoteStore` are interfaces, not tied to SQLite.

How one host spreads over several machines is open. It depends among other
things on how far a LayerFS Store can be shared across machines, which is not
yet verified.
