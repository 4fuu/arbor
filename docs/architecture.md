# Architecture

## Layers

```text
┌ entry points ─────────────────────────────────────────────────┐
│ arbor CLI (people, scripts, the model through bash)            │
│ direct tools (the model)  ·  host API (consoles, adapters)     │
├ command layer ─────────── the one implementation ─────────────┤
│ branch · context · note · history · links · message · task     │
├ core ─────────────────────────────────────────────────────────┤
│ event DAG · branches and contexts · trunk · budget · effects   │
├ interfaces ───────────────── every one replaceable ───────────┤
│ AgentBackend · Storage · NoteStore · EventStore · Scheduler    │
│ Scorer · TaskSource · EffectExecutor · ToolGroup · Judge       │
├ defaults ─────────────────────────────────────────────────────┤
│ pi · LayerFS · SQLite events · simple scheduler · bash tools   │
└───────────────────────────────────────────────────────────────┘
```

**One command layer.** Every operation is implemented once. A direct tool is a
thin wrapper of one command: same arguments, same behaviour, same errors. The
CLI and the host API call the same layer. There is no second code path that a
tool or a script could take around it.

## Interfaces

Each interface ships with a default. Replacing a module means implementing its
interface and registering it; nothing else changes.

| Interface | Responsibility | Default |
| --- | --- | --- |
| `AgentBackend` | run one context: send the prompt and tools to a model, stream tool calls, accept inputs inserted between tool calls, report token usage | [pi](https://github.com/badlogic/pi-mono) (pi-agent-core) |
| `Storage` | branch files: fork, read, write, commit, merge, publish, diff, mount a workspace for a command | [LayerFS](https://github.com/Ephemeral-AI-Lab/layerfs) |
| `EventStore` | the event DAG: append, read, search, walk by parent | SQLite beside the LayerFS Store |
| `NoteStore` | notes: revisions, summaries, anchors, the active set | files in a fixed directory of the project, on `Storage` |
| `Scheduler` | choose a branch for a task, or open one | activity, context share, cache warmth ([scheduling.md](scheduling.md)) |
| `Scorer` | one score of a task against a branch profile, for the scheduler | none beyond the default's own terms |
| `TaskSource` | turn outside events into tasks with ownership keys | the CLI (`arbor task add`) |
| `EffectExecutor` | carry out effects from the effect queue | none; adapters provide them |
| `ToolGroup` | a set of model tools and their CLI commands | context and notes, history, branch, workspace ([cli.md](cli.md)) |
| `Judge` | optional model-based answers the host asks (relevance, active-note choice) | none |

Rules for every interface:

- **No backend leaks.** No pi type, LayerFS id or SQL row crosses an
  interface; the core only sees its own shapes.
- **Errors name the next action.** An implementation returns errors in the
  core's error shape, so the model always reads the same kind of refusal.
- **Adapters add, they do not patch.** A domain (a chat bot, a coding agent)
  is an adapter: task sources, effect executors, tool groups and judges. It
  does not change the core.

## Data placement

| Data | Where |
| --- | --- |
| files of a branch | LayerFS branch |
| trunk files | LayerFS `main` |
| notes | LayerFS, under the project's note directory, written only through `NoteStore` |
| events | `EventStore`; an event that changed files records the LayerFS commit id |
| effect queue, schedules, settings | host database |

Multiple projects share one host. Each project is one LayerFS project with its
own Store, its own trunk and its own events. LayerFS requires every process
that opens a Store to share one Linux kernel and one local filesystem, so one
project's branches run on one machine.
