# Tools

The model has two tiers of tools. **Decisions and plain commands are direct
tools**, declared to the model and called in the turn. **Everything else is a
module function**, called from a script in `code_exec`. There is no CLI.
Operators, consoles and plugins use the host API, which calls the same
service layer ([architecture.md](architecture.md#layers)).

## Direct tools

| Tool | What it does |
| --- | --- |
| `send(to, content, reply_to?, cites)` | an effect to a target, through the effect queue |
| `note_write`, `note_replace`, `note_delete` | write memory ([memory.md](memory.md)) |
| `end(handoff?)` | end the run; with a handoff, continue in a new window ([windows.md](windows.md#ending-and-continuing)) |
| `reload(install?, remove?)` | change the environment and broadcast the delta ([environment.md](environment.md#changing-the-environment)) |
| `search(query, scope?)` | the journal, notes and the board in one query |
| `bash`, `bash_output`, `bash_stop`, `read`, `write`, `edit` | the window's workspace ([workspaces.md](workspaces.md)) |
| `code_exec`, `tool_search` | the entry points to the modules |

Plugins add no tools; their abilities are MCP servers
([architecture.md](architecture.md#plugins)). A deployment may move a
function into or out of the direct set through configuration, guided by how
often the logs show it used.

## Modules

| Module | Functions |
| --- | --- |
| `journal` | `search`, `show(ref)`, `around(ref, before?, after?)`, `trace(ref)`, `links(ref, offset?)` |
| `windows` | `list`, `show(c…)`, `send(to, text, reply_to?)`, `broadcast(text)`, `inbox` |
| `env` | `list`, `history(item?)` |
| `services` | `list`, `status(name)`, `logs(name)` |
| `board` | `list`, `set(line)`, `expect(item? \| description?)`, `unexpect(ref)` |
| `notes` | `search(query?, status?, about?, linked?)`, `read(ref)`, `context(ref)`, `active` |
| `channels` | `list`, `get(ref)` |
| `tasks` | `list`, `show(t…)` |
| `schedule` | `list`, `create`, `update`, `cancel` |
| `workspace` | `grep`, `find`, `ls`, and `path(window)` where the implementation answers another window's directory |

A module whose backing feature is not configured is absent: `env` and
`services` appear only when the host has an environment and a supervisor, and
`channels` only when a plugin registered a channel.
Every MCP server - a plugin's or one the model installed - is a module of its
own, declared with the functions it listed when it was validated, and arrives
through an environment delta
([environment.md](environment.md#deltas-in-a-window)). A call into a function a
delta removed is refused with the rule and the ref of the change that removed
it.

## Rules

- **Decisions stay direct.** Anything that speaks, ends a window, writes
  memory or changes the environment is a direct call. A script that names one
  is refused with the rule and never reaches the host.
- **A plain command is a direct call, a chain is a script.**
- **One behaviour per tool.** A command that outlives `bash`'s wait window is
  followed with `bash_output` and stopped with `bash_stop`.
- **Same path.** Calls from a script go through the same hooks as direct
  calls, so anchors, watermarks, quotas, validation and logging behave the
  same.
- **Two lookups.** `tool_search` (direct tool and script global) takes
  keywords, an exact `module.function` name, or nothing for every module;
  `tool_describe("module.function")` (script global) returns one signature.
  Both read the catalog frozen with the window plus the environment deltas
  since. `tool_search` also answers skills by name or keyword with their path
  and how to read them, and an MCP server's name with the functions it lists.
- **The prompt names modules, not functions.** The system prompt lists the
  direct tools one per line and the modules one per line; a module's line
  describes what it can do and never names a function.
- **Low noise, layered, closed loop.** How every description, result and
  error is written is in [prompting.md](prompting.md).
- **Errors name the next action.** Every refusal states the rule that refused
  the call and what to do instead. Guard rules live only in those errors, not
  in descriptions or the prompt.
- Every ref in any result can be passed to another call
  ([journal.md](journal.md#refs)).
