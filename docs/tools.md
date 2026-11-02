# Tools

The model has two tiers of tools. **Decisions and plain commands are direct
tools**, declared to the model and called in the turn. **Everything else is a
module function**, called from a script in `code_exec`. There is no CLI.
Operators, consoles and adapters use the host API, which calls the same
service layer ([architecture.md](architecture.md#layers)).

## Direct tools

| Tool | What it does |
| --- | --- |
| `send(to, content, reply_to?, cites)` | an effect to a target, through the effect queue |
| `note_write`, `note_replace`, `note_delete` | write memory ([memory.md](memory.md)) |
| `end(handoff?)` | end the run; with a handoff, continue in a new window ([windows.md](windows.md#ending-and-continuing)) |
| `search(query, scope?)` | the journal, notes and the board in one query |
| `bash`, `bash_output`, `bash_stop`, `read`, `write`, `edit` | the window's workspace ([workspaces.md](workspaces.md)) |
| `code_exec`, `tool_search` | the entry points to the modules |

Adapters add their own tools (a chat bot's send variants). A deployment may
move a function into or out of the direct set through configuration, guided by
how often the logs show it used.

## Modules

| Module | Functions |
| --- | --- |
| `journal` | `search`, `show(ref)`, `around(ref, before?, after?)`, `trace(ref)`, `links(ref, offset?)` |
| `windows` | `list`, `show(c…)`, `send(to, text, reply_to?)`, `yield(to, note?)`, `inbox` |
| `board` | `list`, `set(line)`, `expect(item? \| description?)`, `unexpect(ref)` |
| `notes` | `search(query?, status?, about?, visibility?, linked?)`, `read(ref)`, `context(ref)`, `active` |
| `channels` | `list`, `get(ref)` |
| `tasks` | `list`, `show(t…)` |
| `schedule` | `list`, `create`, `update`, `cancel` |
| `workspace` | `snapshots(ws?)`, `mount(ws@ref)`, `diff(from, to)`, `grep`, `find`, `ls` |

A module whose backing feature is not configured is absent. Adapters and MCP
servers add modules of their own.

## Rules

- **Decisions stay direct.** Anything that speaks, ends a window or writes
  memory is a direct call. A script that names one is refused
  with the rule and never reaches the host.
- **A plain command is a direct call, a chain is a script.**
- **One behaviour per tool.** A command that outlives `bash`'s wait window is
  followed with `bash_output` and stopped with `bash_stop`.
- **Same path.** Calls from a script go through the same hooks as direct
  calls, so anchors, watermarks, quotas, validation and logging behave the
  same.
- **Two lookups.** `tool_search` (direct tool and script global) takes
  keywords, an exact `module.function` name, or nothing for every module;
  `tool_describe("module.function")` (script global) returns one signature.
  Both read the catalog frozen with the window.
- **The prompt names modules, not functions.** The system prompt lists the
  direct tools one per line and the modules one per line; a module's line
  describes what it can do and never names a function.
- **Errors name the next action.** Every refusal states the rule that refused
  the call and what to do instead. Guard rules live only in those errors, not
  in descriptions or the prompt.
- Every ref in any result can be passed to another call
  ([journal.md](journal.md#refs)).
