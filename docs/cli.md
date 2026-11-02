# CLI and model tools

`arbor` is one binary that covers every operation of the framework. People,
scripts and the model use the same commands. The model also gets a small set
of direct tools; each is a thin wrapper of one command, with the same
arguments, behaviour and errors ([architecture.md](architecture.md#layers)).

## Conventions

- Branch and merge commands follow git's names, flags and flow, so a model
  that knows git needs no new vocabulary. A git command arbor does not support
  (`rebase`, `stash`, `reset --hard` on the trunk) is refused with the command
  to use instead.
- Output is plain text that a model and a person can read; `--json` gives the
  same data for scripts.
- Every ref in any output can be passed to another command
  ([context.md](context.md#references-and-links)).
- Errors state the rule that refused the call and the next action. Guard rules
  live only in those errors, not in help text or the prompt.
- Inside a branch, the current project and branch are implied; `-p <project>`
  and `-b <branch>` name others.

## Command tree

| Group | Commands |
| --- | --- |
| project | `arbor project list`, `arbor project new <name>` |
| branch | `arbor branch list [-a]`, `arbor branch show <branch>`, `arbor branch close <branch>` (host or operator) |
| state | `arbor status`, `arbor log [--all] [<branch>]`, `arbor show <ref>`, `arbor diff [<branch>] [-- <paths>]` |
| sync | `arbor pull`, `arbor add <paths>`, `arbor pull --continue`, `arbor pull --abort`, `arbor merge -m <summary>` |
| context | `arbor ctx status`, `arbor ctx rotate --handoff <text>`, `arbor ctx list`, `arbor ctx show <c…>` |
| notes | `arbor note search [query] [--status --about --visibility --linked <ref>]`, `arbor note read <n…>`, `arbor note write`, `arbor note replace <n…>`, `arbor note delete <n…>`, `arbor note context <n…@rev>`, `arbor note active` |
| links | `arbor links <ref> [--offset N]` |
| history | `arbor history search <query> [--all]`, `arbor history around <r…>` |
| messages | `arbor send <branch\|key:…> <text> [--reply-to <m…>]`, `arbor inbox` |
| tasks | `arbor task list`, `arbor task show <t…>`, `arbor task add` (operator), `arbor schedule list/create/update/cancel` |
| jobs | `arbor job list`, `arbor job output <j…>`, `arbor job stop <j…>` |
| host | `arbor serve`, `arbor pause`, `arbor resume`, `arbor config get/set` (operator) |
| help | `arbor help [command]` |

Operator commands are refused inside a model's sandbox with the reason.

## Direct tools

Kept small on purpose: decisions, and the calls the model makes in almost
every run. Everything else is `arbor` in bash.

| Tool | Command |
| --- | --- |
| `rotate(handoff)` | `arbor ctx rotate` |
| `merge(summary)` | `arbor merge` |
| `send(to, text, reply_to?)` | `arbor send` |
| `end_turn(reason?)` | - (ends the run) |
| `note_write`, `note_replace` | `arbor note write`, `arbor note replace` |
| `search(query, scope?)` | notes, history and branches in one query, all branches by default |
| `bash`, `read`, `write`, `edit` | workspace tools on the branch's LayerFS workspace |

The system prompt lists the direct tools one per line and ends with one line:
the rest of the framework is `arbor help`. Adapters add their own tool groups
(for a chat bot, its send); a deployment may move a command into or out of the
direct set through configuration, guided by how often the logs show it used.

## Workspace tools

- `read`, `write`, `edit` go to the LayerFS Store directly; every write is one
  commit on the branch.
- `bash` mounts a workspace for the branch, runs the command, commits what it
  changed and unmounts. A command that outlives its wait window keeps running
  in the background; `arbor job output <j…>` and `arbor job stop <j…>` follow
  it.
- The tools are a `ToolGroup` like any other and can be replaced as a whole.
