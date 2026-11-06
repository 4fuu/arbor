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
│ pi · SQLite · a directory · Jev · simple scheduler             │
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
| `Workspace` | a directory per window: create it on first use, mount it, reclaim it | a plain directory ([@arbor/workspace-dir](../packages/workspace-dir)) |
| `Judge` | answer the host's decisions: filter, route, model tier, notice, broadcast, active set ([dispatch.md](dispatch.md#judge-decisions)) | Jev |
| `Channel` | an outside source and sink: look up a message by its native id, list what is connected, report online state | none; plugins provide them ([@arbor/plugin-http](../packages/plugin-http)) |
| `TaskSource` | turn outside events into tasks, batching them | the host API |
| `EffectExecutor` | carry out effects from the effect queue | none; plugins provide them |
| `ToolGroup` | a set of direct tools and code mode modules | the built-in groups ([tools.md](tools.md)) |
| `Environment` | skills, MCP servers and services: revisions, validation, the shared `/env` mount, deltas ([environment.md](environment.md)) | a directory ([@arbor/environment-dir](../packages/environment-dir)) |
| `Supervisor` | run services: start, health checks, restart with backoff, logs, quotas ([environment.md](environment.md#services)) | a host process supervisor ([@arbor/supervisor-process](../packages/supervisor-process)) |
| `Scheduler` | insertion timing, backpressure, scheduled tasks | simple rules ([dispatch.md](dispatch.md)) |

Besides the interfaces, hooks let a deployment add policy without replacing
a module ([below](#hooks)).

Rules for every interface:

- **No backend leaks.** No pi type or SQL row crosses an interface; the core
  only sees its own shapes.
- **Errors name the next action.** An implementation returns errors in the
  core's error shape, so the model always reads the same kind of refusal.
- **Plugins add, they do not patch.** A domain (a chat bot, a coding agent)
  is a plugin ([below](#plugins)). It does not change the core.

## Stack

- **TypeScript on Node.js**, one host process. pi-agent-core runs every
  window in process, so steering, tool hooks and code mode are direct calls.
- **SQLite** for the journal, notes and host data.
- **A directory** for workspaces: one per window, under one root, on the host's
  own filesystem. Nothing is mounted and nothing is containerised, so the
  default runs the same way on Windows, Linux and macOS; a deployment that
  wants real isolation - a sandbox, a container per window - implements
  `Workspace` itself and registers it
  ([workspaces.md](workspaces.md#what-the-framework-guarantees)).
- **The toolchain** is project-local: `mise.toml` pins Node and pnpm, installed
  under `~/.local/share/mise`. `.agents/setup` prepares a machine from it; a
  machine without mise is expected to carry Node 24 or newer and pnpm 12
  already.

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

The first plugin is the HTTP test channel
([@arbor/plugin-http](../packages/plugin-http)): a webhook in, sends out, and a
page a person drives the whole host from. It registers a `Channel`, the
`EffectExecutor` that carries a window's `send` out through it, a prompt section
and one judge criterion, and adds no direct tool or code mode module of its own.
The host takes a channel's push source at `start` and ingests what arrives as
outside traffic, exactly as a task source's events are
([dispatch.md](dispatch.md#tasks)); a channel a deployment only uses as a sink
is never subscribed to. What a registered channel holds is read through the
core's own `channels` module - its connections, and a message by its native id
([tools.md](tools.md#modules)) - so a plugin adds no module and the model still
sees the outside world.

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

The hooks run in the order their plugins registered, each seeing what the one
before it changed, and the first refusal stops the rest. What a refusal does is
the point's own: around an append, a note write, a reload or a tool call it
throws, so the caller answers with the rule; before a delivery it drops the
delivery; before an effect it holds it for an approval; before a window start or
a model request the window never opens.

The host API lets an operator list, pause and end windows, steer an input
into one, and read the board. Permissions, privacy review, budgets and
approvals are built from these.

## Data placement

| Data | Where |
| --- | --- |
| events, watermarks, links | `Journal` |
| notes | `NoteStore` |
| files | `Workspace`: one directory per window |
| skills, MCP and service configurations, the settings | `Environment`: the `/env` directory, with revisions |
| service directories and logs | `Supervisor`, on `Workspace` |
| effect queue, schedules | host database |

There is no project boundary: a host has one journal, one set of notes and
one `/env`, and every window can read all of it.

## Room for many machines

For now one host runs on one machine. To leave room for more:

- Tools and plugins reach the host only through the host API, never through
  local files or the database.
- Ids and refs do not depend on a machine.
- `Journal` and `NoteStore` are interfaces, not tied to SQLite.

How one host spreads over several machines is open.
