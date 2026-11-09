# Tools

The model has two tiers of tools. **Decisions and plain commands are direct
tools**, declared to the model and called in the turn. **Everything else is a
module function**, called from a script in `code_exec`. There is no CLI.
Operators, consoles and plugins use the host API, which calls the same
service layer ([architecture.md](architecture.md#layers)).

## Direct tools

| Tool | What it does |
| --- | --- |
| `send(to, content, reply_to?, cites)` | an effect to a target, through the effect queue; the channel decides whether it arrives; a target no executor owns is refused at the call |
| `note_write(title, summary?, body, refs?)`, `note_replace(id, revision, …, refs?)`, `note_delete(id, revision)` | write memory ([memory.md](memory.md)) |
| `end(handoff?)` | end the run; with a handoff, continue in a new window ([windows.md](windows.md#ending-and-continuing)) |
| `reload(install?, remove?)` | change the environment and broadcast the delta ([environment.md](environment.md#changing-the-environment)) |
| `search(query, scope?)` | the journal, notes and the board in one query |
| `bash`, `bash_output`, `bash_stop`, `read`, `write`, `edit` | the window's workspace ([workspaces.md](workspaces.md)) |
| `code_exec`, `tool_search` | the entry points to the modules |

Plugins add no module of their own; their abilities are MCP servers
([architecture.md](architecture.md#plugins)). A deployment may move a
function into or out of the direct set through configuration, guided by how
often the logs show it used.

## External tools

A **plugin or a backend may declare direct tools of its own** - a name, a
description, a JSON schema and the `execute` that runs the call. Both take one
shape, `ExternalTool`, so a plugin and a backend share one path rather than two:
a plugin lists them in its `tools`, and a backend answers `externalTools()` with
them, which is how a host embedded in another harness - DeepSeek Harness, for
instance - hands in the tools that harness's own plugins registered. They are
called under their original names.

Nothing about them is special after registration. The host registers them as a
group like any other, and from then on a call is an ordinary direct tool: the
same `beforeToolCall` and `afterToolCall` hooks, the same journaling, the same
secret scrub, the same one result cut at `ToolCatalog.call`, and the same
`tool_result` block the renderer writes. The core knows nothing about what they
do.

- **The model is told whose a tool is.** The `<tools>` list writes a tool
  declared from outside the core with its source - the plugin's name, or the
  backend's - after its description, and `tool_search` answers with the same
  line. `tool_search` finds them like any direct tool: an exact name first, then
  a prefix, then a description.
- **The schema is carried whole.** An outside harness already has a JSON Schema
  for its tool, and that schema is what the model reads: the tool declares
  `schema`, and the host passes it through untouched - `enum`, `items`, `oneOf`,
  `additionalProperties`, a nested object's own properties. The backend hands it
  to the model in the tool declaration, and `tool_search` shows it on the tool's
  line, escaped like every other string from outside the framework; the
  `<tools>` line does not repeat it, because the declaration already carries it. A tool that declares no schema
  declares `parameters` in arbor's own shape instead, which is what arbor's own
  tools do. `ParameterSpec` is not grown to hold a schema: JSON Schema is
  open-ended, arbor's own tools never need it, and deriving one from a summary is
  what dropped `todo_write`'s item shape and its status enum in the first place.
- **A core tool always wins.** A name the model already has - a core tool's, or
  a module's - is not registered for an external tool, and neither is a name
  another external tool took first. The collision is **recorded, not thrown**:
  one `tool_registration` event per tool that was left out, carrying the source,
  the tool and the rule `tool.name_taken`, so an operator sees which tool of
  which plugin the model will not get. The colliding plugin tool simply does not
  exist for the model, and the window keeps working. The rule runs on **every**
  registration, not only the first one.
- **A script may call one.** The guard in `code_exec` refuses a script that
  names one of arbor's own direct tools, because a decision or a plain command
  belongs in the turn, where the prompt and the record see it as the model's own
  call. A tool declared from outside the core is not one of those: it is a
  capability of its own, like a module function, so a script reaches it as a
  global of the same name and it runs through the same path. Called from a
  script it is recorded as part of the one `code_exec` call, exactly as a module
  function is.

### External tools that change

A harness around the host registers and unregisters its tools at runtime - a
plugin of its own is loaded, upgraded or removed while the host runs. The set is
therefore **refreshable**, and the host reads it again:

- before every window opens, so the window's request and its prefix carry the
  set as it stands then;
- at every step boundary of a running window, the same place the host asks a
  plugin's prompt section for its revision - one read per step, and a read that
  changed nothing is delivered to nobody;
- whenever a deployment calls `Arbor.refreshExternalTools()`, for a harness that
  knows its own registry moved and wants the change to land now rather than at
  the next boundary.

A plugin's `tools` may be a list or a source the host calls again, so a plugin
whose set changes answers with what stands now.

A running window learns the change **the way it learns an environment change**: a
`tools_delta` delivery at its next tool-call boundary, naming what was added
(`+ todo_write（来自dsh）`) and what was removed. Its prefix is never rebuilt for
it. A backend that can change a running window's declared tools does it through
`WindowSession.refreshTools`, so a tool that appeared is callable in the window
that is already running and one that was removed is not; a backend that cannot
leaves its declaration alone, and a call still runs through the host's catalog,
which holds the current set. A window that opens after the change carries the new
set in its own request and gets no delta of its own opening, and the next
snapshot epoch lists it in `<tools>`.

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
| `workspace` | `grep`, `find`, `ls`, and, for the ovnfs workspace, `checkout(name, dir?)`, `list(window?)`, `diff(name)`, `apply(name, branch?)`, `rm(name)` and `path(window)` |

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
  memory or changes the environment is a direct call. A script that names one of
  arbor's own direct tools is refused with the rule and never reaches the host. A
  tool a plugin or a backend declared is not one of arbor's, so a script may call
  it ([above](#external-tools)).
- **A plain command is a direct call, a chain is a script.**
- **One behaviour per tool.** A command that outlives `bash`'s wait window is
  followed with `bash_output` and stopped with `bash_stop`.
- **Same path.** Calls from a script go through the same hooks as direct
  calls, so anchors, watermarks, quotas, validation and logging behave the
  same.
- **Two lookups.** `tool_search` (direct tool and script global) takes
  keywords, an exact `module.function` or tool name, or nothing for every
  module; `tool_describe("module.function")` (script global) returns one
  signature. Both read the catalog frozen with the window plus the environment
  deltas since. `tool_search` also answers skills by name or keyword with their
  path and how to read them, an MCP server's name with the functions it lists,
  and a direct tool by name with its description - a name is matched exactly
  first, then by prefix, then by description. Its answer leads with how a
  function is called and closes with how to read one signature, and says when
  it left matches out.
- **The prompt names modules, not functions.** The system prompt lists the
  direct tools one per line and the modules one per line; a module's line
  describes what it can do and never names a function. A tool declared from
  outside the core carries its source on its line
  ([above](#external-tools)).
- **Low noise, layered, closed loop.** How every description, result and
  error is written is in [prompting.md](prompting.md).
- **Errors name the next action.** Every refusal states the rule that refused
  the call and what to do instead. Guard rules live only in those errors, not
  in descriptions or the prompt.
- Every ref in any result can be passed to another call
  ([journal.md](journal.md#refs)).
