# Environment

The environment is what a window can use beyond its built-in tools: skills,
MCP servers and resident services. The model changes it itself, and the
change reaches every live window as a delta, without rebuilding any context.

## What the model can change

The model can change everything about itself: skills, MCP servers,
services, and the settings - identity and general rules, judge modes,
thresholds and criteria, model tiers. Two things are outside its reach: the
value of a secret, because a configuration names a secret and never holds
its value, and the built-in skills ([below](#built-in-skills)), which ship
with the framework. A deployment that wants to restrict more does it through
hooks ([architecture.md](architecture.md#hooks)).

Rules and guidance files for a piece of work are ordinary files in a
workspace. The framework does not manage or restrict them.

## Layout

The environment is one shared directory, mounted read-only into
every window at `/env`:

```text
/env/skills/<name>/SKILL.md     a skill, with any scripts and files beside it
/env/mcp/<name>.json            one MCP server's configuration
/env/mcp/<name>/<name>.json     one that brought its own code, beside it
/env/services/<name>/svc.json   one service's configuration, beside its files
/env/settings.json              identity, general rules, judge, model tiers
```

The implementation owns the directory on the host; a window reads it at `/env`,
and `read` and `bash` resolve that prefix onto it. A deployment whose workspace
can mount it for real does, and a window without a workspace still reads `/env`
through `read`; changing it needs a workspace.

A workspace that owns its execution environment cannot mount a host directory:
LayerFS's Sandbox has the project's Store as its only volume, and its command
identity is an unprivileged user that cannot write at the container's root. So
the files are staged into the Sandbox beside the mount, in its own writable
layer, and `bash` and `workspace.ls` rewrite the prefix onto where they landed.
What is staged is not the workspace's own: it sits outside its tree, so no
snapshot holds it, no fork copies it, and no diff or read-only view shows it.
It is read-only once staged, because a change goes through the environment's
own draft and `reload`. Staging is per mount and per revision: a `reload` lands
as a new revision, and the next command stages it again before it runs, so a
live window always reads what the environment holds now.

Each item - one skill, one server, one service, the settings - has its own
revision, so changes to different items never conflict. A window without a
workspace still reads `/env` through `read`; changing it needs a workspace.

## Using a skill or a server

- The system prompt and every delta list an item by one line: its name, its
  description and, for a skill, its path. Nothing more enters the prompt.
- **Detailed use comes from `tool_search`.** A skill's name or keywords
  return its path and how to read it; a server's name returns its functions,
  which are called from `code_exec` like any module
  ([tools.md](tools.md#rules)). How to change the environment is in the
  built-in skills, which `tool_search` returns for `reload`; none of it is in
  the prompt.
- **Every read records the revision it read**, `sk:deploy@4`, so a trace shows
  which version of a skill a piece of work used, and `reload` knows which
  revision a draft in that window is based on.
- A skill is used by reading it: `read /env/skills/deploy/SKILL.md`. Its
  scripts run with `bash` from `/env/skills/deploy/`, with the window's own
  rights.

## Changing the environment

Every change is the same three steps: copy, edit, `reload`.

1. **Draft in the workspace.** For a new item, create its directory or file;
   for an existing one, copy it: `cp -r /env/skills/deploy .`. Edit and test
   it with `write`, `edit` and `bash`.
2. **`reload(install?, remove?)`.** `install` names drafts in the workspace,
   `reload({ install: ["./deploy"] })`; `remove` names items,
   `reload({ remove: ["skill:deploy"] })`. `reload` is a direct tool. One call
   is one environment revision, so a call that installs and removes lands as a
   single delta. The host:
   - validates each item: a skill parses, an MCP server starts and lists its
     functions, a service starts and passes its health check;
   - checks each item's revision against the one the window read, which the
     host recorded from its reads; when another window installed a newer one,
     the call is refused with what changed since, and the model merges them and
     calls again ([memory.md](memory.md#conflicts) works the same way);
   - on success replaces each item as a whole, records an environment
     revision `e7`, and broadcasts the delta
     ([coordination.md](coordination.md#broadcasts)).
3. A refused `reload` changes nothing. Its error names the rule that refused
   it and the section of the built-in skill that covers it.

`env.list` shows the items and their revisions, `env.history(item?)` their
changes. Reverting is installing an older revision again.

## Services

A service is an application that keeps running after the window that set it
up has ended: a webhook receiver, a crawler, a bot, a worker. `bash`
background jobs end with their window chain, so anything resident is a
service.

| The framework guarantees | The agent does |
| --- | --- |
| supervision: restart with backoff after a crash, start again after a host restart, resource quotas | write the application and install its dependencies |
| a directory of its own that no window ends or reclaims | write `svc.json`: command, ports, health check, the names of the secrets it uses, restart policy |
| logs, and state changes recorded in the journal | read the logs, debug, upgrade, roll back |
| secrets injected by name, egress rules applied as for windows | decide when to stop or remove it |

- **Install.** `reload` copies the draft directory into one the service owns,
  starts it under the `Supervisor` and waits for its health check; only then is
  the item installed. A service that never becomes healthy is rolled back to the
  revision it had, so the call is refused and nothing changed.
  An upgrade is another `reload`; the host swaps to the new revision.
  Reverting installs an older one.
- **Failures are inputs.** A crash, a restart loop or a failing health check
  is a journal event with target `svc:<name>`, dispatched like any outside
  input: to a window that touched the service, or a new one
  ([dispatch.md](dispatch.md#tasks)). The host makes no repair task.
- **Writing to the journal.** A service gets a credential of its own for the
  host API and may append events with it. Its events carry its name as their
  source and are dispatched like any outside input, so a service the model
  writes can act as a task source or channel.
- **Effects.** What a service does to the outside world directly is outside
  the effect queue and its exactly-once guarantee. An action that should be
  recorded and guaranteed goes through the host API.
- **Reaching it.** Ports are reachable from windows and other services on the
  host. Exposing a service publicly is not part of the framework; a
  deployment that needs it builds it on top.

`services.list`, `services.status(name)` and `services.logs(name)` read them.
A host restart starts every installed service again from the directory it owns.

## Built-in skills

The framework ships four skills under `/env/skills/arbor-*`:
`arbor-skill`, `arbor-mcp`, `arbor-service` and `arbor-settings`, one per kind
of item, each holding how to write, test, install, change and revert that kind.
They are listed like any skill, one line each, and read on demand. They are
released with the framework and read-only; the model writes skills of its own
beside them.

They close the loop for the environment: the prompt names `reload` in one
line, `tool_search` for `reload` returns the built-in skills' paths, the
skills hold the procedure, and every refusal names the section to read.

## Deltas in a window

- A delta block names what changed by one line per item:
  `environment e7: +mcp weather (weather lookup); ~skill deploy (description
  changed); -mcp old-db`.
- New abilities always enter as modules, never as direct tools, because
  changing a window's declared tools would change its prefix. A change to the
  direct tool set applies to new windows only.
- `tool_search` and `tool_describe` read the window's catalog: the one frozen
  when it opened plus every delta since, so the lookup and the deltas never
  disagree.
- **Removal never changes a prompt.** An open window keeps what it was built
  with. A call to a removed function, or a read of a removed skill, is
  refused with the rule and the ref of the change that removed it; the
  removal also reaches live windows as a delta, and the next epoch leaves the
  item out.
- An item is replaced as a whole, so a window never reads a half-installed
  skill. A window in the middle of using the old version gets the delta and
  reads the new one next time.
- **New windows.** At each snapshot epoch the system prompt is rebuilt with
  the environment folded in, so windows opened in one epoch share a prefix.
  Changes since the epoch go into the first input as a delta
  ([windows.md](windows.md#prompt-layout)).
- Changes to the identity or general rules are not deltas: they are part of
  the system prompt and apply from the next epoch.
