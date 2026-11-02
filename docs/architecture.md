# Architecture

## Layers

```text
┌ entry points ─────────────────────────────────────────────────┐
│ direct tools (the model) · code mode modules (the model)       │
│ host API (operators, consoles, adapters)                       │
├ service layer ─────────── the one implementation ─────────────┤
│ journal · windows · dispatch · board · notes · workspaces      │
│ effects · schedules                                            │
├ interfaces ───────────────── every one replaceable ───────────┤
│ AgentBackend · Journal · NoteStore · Workspace · Judge         │
│ Channel · TaskSource · EffectExecutor · ToolGroup · Scheduler  │
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
| `AgentBackend` | run one window: send the prompt and tools to a model, stream tool calls, accept inputs inserted between tool calls, report token usage | [pi](https://github.com/badlogic/pi-mono) (pi-agent-core, with its code mode) |
| `Journal` | append events, read, search, walk refs and links, keep watermarks | SQLite |
| `NoteStore` | notes: revisions, summaries, anchors, the active set | SQLite beside the journal |
| `Workspace` | a directory per window: create, fork, snapshot, mount read-only, reclaim | [LayerFS](https://github.com/Ephemeral-AI-Lab/layerfs) |
| `Judge` | answer the host's decisions: filter, route, notice, active set ([dispatch.md](dispatch.md#judge-decisions)) | Jev |
| `Channel` | an outside source and sink: look up a message by its native id, list what is connected, report online state | none; adapters provide them |
| `TaskSource` | turn outside events into tasks, batching them | the host API |
| `EffectExecutor` | carry out effects from the effect queue | none; adapters provide them |
| `ToolGroup` | a set of direct tools and code mode modules | the built-in groups ([tools.md](tools.md)) |
| `Scheduler` | insertion timing, backpressure, scheduled tasks | simple rules ([dispatch.md](dispatch.md)) |

Rules for every interface:

- **No backend leaks.** No pi type, LayerFS id or SQL row crosses an
  interface; the core only sees its own shapes.
- **Errors name the next action.** An implementation returns errors in the
  core's error shape, so the model always reads the same kind of refusal.
- **Adapters add, they do not patch.** A domain (a chat bot, a coding agent)
  is an adapter: channels, task sources, effect executors and tool groups. It
  does not change the core.

## Data placement

| Data | Where |
| --- | --- |
| events, watermarks, links | `Journal` |
| notes | `NoteStore` |
| files | `Workspace`: one directory per window, with its snapshots |
| an event that changed files | the journal, with the snapshot id |
| effect queue, schedules, settings | host database |

Multiple projects share one host. Each project has its own journal, notes
and LayerFS project.

## Room for many machines

For now one host runs on one machine. LayerFS requires every process that
opens a Store to share one Linux kernel and one local filesystem, so one
project's workspaces stay on one machine. To leave room for more:

- Tools and adapters reach the host only through the host API, never through
  local files or the database.
- Ids and refs do not depend on a machine.
- `Journal` and `NoteStore` are interfaces, not tied to SQLite.

The first step out is placing different projects on different machines.
