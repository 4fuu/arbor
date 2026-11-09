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
| `AgentBackend` | run one window: send the prompt and tools to a model, stream tool calls and what the model is writing ([windows.md](windows.md#streaming)), accept inputs inserted once a turn's tool calls finish (steering), each marked context or input ([dispatch.md](dispatch.md#context-and-input)), report token usage and rate limits; list the models it can run and log in to their providers; declare the tools the harness around it registered, and answer again whenever the host asks for them ([tools.md](tools.md#external-tools)) ([below](#models)) | [pi](https://github.com/earendil-works/pi) (pi-agent-core in process, with its code mode and model runtime) |
| `Journal` | append events, read, search, walk refs and links, keep watermarks | SQLite |
| `NoteStore` | notes: revisions, summaries, anchors, the active set | SQLite beside the journal |
| `Workspace` | a directory per window: create it on first use, mount it, reclaim it - or say it is not the host's to reclaim ([workspaces.md](workspaces.md#lifecycle)) | a plain directory ([@4fu/arbor-workspace-dir](../packages/workspace-dir)) |
| `Judge` | answer the host's decisions: filter, route, model tier, notice, broadcast, active set ([dispatch.md](dispatch.md#judge-decisions)) | Jev |
| `Channel` | an outside source and sink: look up a message by its native id, list what is connected, report online state | none; plugins provide them ([@4fu/arbor-plugin-http](../packages/plugin-http)) |
| `TaskSource` | turn outside events into tasks, batching them ([dispatch.md](dispatch.md#tasks)) | the host API |
| `EffectExecutor` | carry out effects from the effect queue; a target no registered executor owns is refused before the effect is recorded ([coordination.md](coordination.md#effects)) | none; plugins provide them |
| `ToolGroup` | a set of direct tools and code mode modules | the built-in groups ([tools.md](tools.md)) |
| `Environment` | skills, MCP servers and services: revisions, validation, the shared `/env` mount, deltas ([environment.md](environment.md)) | a directory ([@4fu/arbor-environment-dir](../packages/environment-dir)) |
| `Supervisor` | run services: start, health checks, restart with backoff, logs, quotas ([environment.md](environment.md#services)) | a host process supervisor ([@4fu/arbor-supervisor-process](../packages/supervisor-process)) |
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
| adapters | connections to the outside world: channels with their native ids ([journal.md](journal.md#external-ids)), task sources with their batching ([dispatch.md](dispatch.md#tasks)), effect executors |
| MCP servers | capabilities the model calls, installed into `/env` under the plugin's name ([environment.md](environment.md)) |
| skills | procedures, installed into `/env` under the plugin's name |
| direct tools | tools of the plugin's own, declared to the model and called in the turn ([tools.md](tools.md#external-tools)) |
| hooks | any of the hooks below |
| prompt blocks | a system prompt section - which may be material from outside the framework, and may change while a window runs - and the block kinds its inputs use, which the renderer maps to text ([prompting.md](prompting.md#blocks-and-the-renderer)) |
| tool groups | direct tools and code mode modules of its own, registered through the host's `groups` option |
| judge questions | extra criteria or decisions for its own inputs |

- **Capabilities are MCP servers, not tools.** What the model can do with a
  plugin is an MCP server and skills in `/env`, not a module of the plugin's
  own. The model reads, changes and reinstalls them with `reload` like any
  item, so it can improve a plugin's abilities itself. A plugin upgrade
  installs a new revision on top; the model's changes stay in the item's
  history.
- **A tool of its own is the exception.** A plugin whose behaviour is code
  rather than an item in `/env` - a tool the harness around arbor registered,
  for instance - declares it as an `ExternalTool`: a name, a description, a JSON
  schema and its `execute`. A backend injects the same shape through
  `AgentBackend.externalTools()`, so a plugin and a backend share one path and
  not two. Both are ordinary direct tools from registration on: same hooks,
  same journaling, same scrub, same result cut, and the tools list says where
  each one comes from ([tools.md](tools.md#external-tools)). A name the model
  already has is not registered; the collision is recorded with
  `tool.name_taken` rather than thrown, on every registration and not only the
  first. The set is refreshable: a plugin's `tools` may be a source the host
  reads again, and the backend's set is read again before every window opens and
  at every step boundary, so a tool a harness registers while the host runs
  reaches the model as a delta instead of waiting for a restart
  ([tools.md](tools.md#external-tools-that-change)).
- **An implementation may still add its own.** A `Workspace` implementation
  that can do something the core does not name - showing another window's
  directory, for instance - declares its own module function or tool and its
  own prompt text through `groups`, and a host whose implementation declares
  nothing shows the model nothing about it
  ([workspaces.md](workspaces.md#another-windows-directory)). The core knows
  no such capability of its own.
- **Plugging in** is an environment change: its items arrive in live windows
  as a delta, and its prompt section applies from the next epoch. A prompt
  section whose own content changes later reaches live windows as a delta of
  the changed lines, without rebuilding any window's prefix
  ([prompting.md](prompting.md#plugin-sections-that-change)).
- **Unplugging never changes a prompt.** Open windows keep the system prompt
  and catalog they were built with. A call into a removed capability is
  refused with the rule and the ref of the change that removed it, and live
  windows get the removal as a delta. The next epoch leaves it out. Events
  the plugin recorded stay in the journal and their refs keep resolving.

The first plugin is the HTTP test channel
([@4fu/arbor-plugin-http](../packages/plugin-http)): a webhook in, sends out, and a
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

A plugin that wants a window's live output on a surface of its own - a console,
a chat bridge, a DeepSeek Harness - registers the `windowStream` hook and turns
each delta into what that surface speaks
([windows.md](windows.md#streaming)). No pi type and no journal event is
involved: the deltas are the core's own shapes, and they stay out of the record.
An embedding host that drives one window - the driver that runs arbor inside
another harness - takes that window's stream instead, with
`Arbor.stream(window, onEvent)`, and registers no hook and filters nothing.

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
| live output | one delta of what a window is writing, observation only and best-effort ([windows.md](windows.md#streaming)) |
| before and after a tool call | around every direct tool and module call |
| before an effect | when an effect leaves the queue; it can hold the effect for approval and release or drop it later |
| before and after a note write | around every note revision |
| before and after `reload` | around every environment change |
| service state change | when a service starts, fails or stops |

The hooks run in the order their plugins registered, each seeing what the one
before it changed, and the first refusal stops the rest. What a refusal does is
the point's own: around an append, a note write, a reload or a tool call it
throws, so the caller answers with the rule; before a delivery it drops the
delivery; before an effect it holds it for an approval; before a window start,
a dispatch or a judge request it stops what was about to happen - the window
never opens, the task is answered as `route: "refused"` with the rule recorded
as an event, or the decision falls back on its own documented default - and a
push source never sees an error for a refusal. Before a model request the
window never opens. The live-output hook has nothing to refuse: it observes,
and a hook that fails loses its own deltas
([windows.md](windows.md#streaming)).

`afterToolCall` answers with an outcome whose `result` is used: a hook that
rewrites a result changes what the window records and what the model reads.
The call has already run, so a refusal there stops the hooks after it and
changes nothing else. `beforeModelRequest` runs once per window, before the
first turn, and the `inputs` it answers with are rendered into the window's
first input, so a plugin adds to what the model reads first. `beforeDispatch`
sees the decision - the task, the judge's answer and the window it went to -
and a refusal leaves the task unrouted; the decision itself is the host's, so
what a hook answers with is not applied to it.

The host API lets an operator list, pause and end windows, steer an input
into one, watch one window's live output, read the external tool sources again,
and read the board. Permissions, privacy review, budgets and approvals are built
from these.

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

### Secret values

A configuration names its secrets and never holds their values
([environment.md](environment.md#what-the-model-can-change)). A subprocess
inherits the host's whole environment, so the host's own credentials are
scrubbed too: every host variable whose name has a credential segment
(`KEY`, `APIKEY`, `TOKEN`, `SECRET`, `PASSWORD`, `PASSWD`, `PASS`,
`CREDENTIAL`, `CREDENTIALS`, split on `_`) and a value of at least eight
characters, such as `NPM_TOKEN` or `DEEPSEEK_API_KEY`. A credential under any
other name is covered by naming it in `settings.secrets`. The host resolves
each name - through `Arbor`'s `secretOf`, `process.env` by default - and
replaces every form a value can take: the raw value, its base64 and its
URL-encoded form, longest first. The replacement is the one placeholder the
text table holds, `[hidden:NAME]`, and a value shorter than four characters is
left alone, because too short a string would redact ordinary text.

The scrub is applied where a value could otherwise travel: every tool result,
before it is journaled and before it goes back to the backend; the state a
judge is asked about and every decision log; and what the model writes in its
own turn. A `send` whose content carries a secret value is refused with
`send.secret` before the effect is recorded, so nothing is queued and nothing
is carried out. The settings are the model's to change, so the scrub is
refreshed whenever they are read.

## Room for many machines

For now one host runs on one machine. To leave room for more:

- Tools and plugins reach the host only through the host API, never through
  local files or the database.
- Ids and refs do not depend on a machine.
- `Journal` and `NoteStore` are interfaces, not tied to SQLite.

How one host spreads over several machines is open.
