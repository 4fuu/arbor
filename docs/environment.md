# Environment

The environment is what a window can use beyond its built-in tools: skills
and MCP servers. The model changes it itself, and the change reaches every
live window as a delta, without rebuilding any context.

## What the model can change

The model can extend what it is able to do; it cannot loosen what bounds it.

| The model changes | Only an operator changes |
| --- | --- |
| skills: add, change, remove | identity and general rules (the system prompt) |
| MCP servers: add, change, remove, enable, disable | credentials and secrets; a configuration names a secret, never holds its value |
| | egress rules, quotas, rate limits |
| | judge modes, thresholds and criteria |
| | the model, the channels |

Project rules and guidance files are ordinary files in a workspace. The
framework does not manage or restrict them.

## Layout

The environment is one shared directory per project, mounted read-only into
every window at `/env`:

```text
/env/skills/<name>/SKILL.md     a skill, with any scripts and files beside it
/env/mcp/<name>.json            one MCP server's configuration
```

Each item - one skill, one server - has its own revision, so changes to
different items never conflict. A window without a workspace still reads
`/env` through `read`; changing it needs a workspace.

## Using a skill or a server

- The system prompt and every delta list an item by one line: its name, its
  description and, for a skill, its path. Nothing more enters the prompt.
- **Detailed use comes from `tool_search`.** A skill's name or keywords
  return its path and how to read it; a server's name returns its functions,
  which are called from `code_exec` like any module
  ([tools.md](tools.md#rules)). How to change the environment is in the
  description `tool_search` returns for `reload`, not in the prompt.
- A skill is used by reading it: `read /env/skills/deploy/SKILL.md`. Its
  scripts run with `bash` from `/env/skills/deploy/`, with the window's own
  rights.
- Every read records the revision it read, `sk:deploy@4`, so a trace shows
  which version of a skill a piece of work used.

## Changing the environment

Every change is the same three steps: copy, edit, `reload`.

1. **Draft in the workspace.** For a new item, create its directory or file;
   for an existing one, copy it: `cp -r /env/skills/deploy .`. Edit and test
   it with `write`, `edit` and `bash`.
2. **`reload(install?, remove?)`.** `install` names drafts in the workspace,
   `reload({ install: ["./deploy"] })`; `remove` names items,
   `reload({ remove: ["skill:deploy"] })`. `reload` is a direct tool. The
   host:
   - validates each item: a skill parses, an MCP server starts and lists its
     functions;
   - checks each item's revision against the one the draft was copied from;
     when another window installed a newer one, the call is refused with the
     differences, and the model merges them and calls again
     ([memory.md](memory.md#conflicts) works the same way);
   - on success replaces each item as a whole, records an environment
     revision `e7`, and broadcasts the delta
     ([coordination.md](coordination.md#broadcasts)).
3. A refused `reload` changes nothing.

`env.list` shows the items and their revisions, `env.history(item?)` their
changes. Reverting is installing an older revision again.

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
- A call to a removed function, or a read of a removed skill, is refused with
  the ref of the change that removed it.
- An item is replaced as a whole, so a window never reads a half-installed
  skill. A window in the middle of using the old version gets the delta and
  reads the new one next time.
- **New windows.** At each snapshot epoch the system prompt is rebuilt with
  the environment folded in, so windows opened in one epoch share a prefix.
  Changes since the epoch go into the first input as a delta
  ([windows.md](windows.md#prompt-layout)).
- Operator changes to the identity or general rules are not deltas: they
  apply from the next epoch.
