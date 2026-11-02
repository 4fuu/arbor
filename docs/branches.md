# Branches

A branch is a line of work. It holds a chain of events, a LayerFS branch for
its files, the tasks assigned to it, and a sequence of contexts
([context.md](context.md)). Branches run in parallel; there is no cap on how
many.

## Lifecycle

1. **Open.** The scheduler opens a branch for a task no idle branch should
   take ([scheduling.md](scheduling.md)). The branch forks from the trunk's
   latest merge point; a LayerFS fork copies no files.
2. **Work.** Tasks and branch messages arrive as input blocks. The model works
   on its files, notes and effects.
3. **Idle.** No task in hand. The branch stays open with its context and can
   take the next task.
4. **Close.** The host closes a branch that is idle and fully merged. A closed
   branch's history stays queryable.

## Operations

The operations are independent. None of them implies another.

| Operation | What it does | Ends | Started by |
| --- | --- | --- | --- |
| **pull** | merges the trunk into the branch | nothing | the model; the host at every rotation |
| **merge** | publishes the branch's events and file changes since its last merge to the trunk, with a progress summary; incremental, any number of times | nothing; the branch keeps working | the model at a milestone; the host when the branch goes idle and merges cleanly |
| **rotate** | gives the branch a new context ([context.md](context.md#rotation)) | the current context only | the model, pushed by reminders; the host at the hard limit |
| **send** | sends a message to another live branch | nothing | the model |
| **close** | stops the branch from taking tasks | the branch | the host |

Typical flows:

- **Share progress mid-task:** `merge`, keep working.
- **Context full, work unfinished:** `rotate`, keep working; the files and
  unmerged changes are untouched.
- **Done:** `merge`, then go idle. The host closes the branch later or gives it
  the next task.

A merge onto a trunk that moved is refused the way `git push` is when behind,
with the next action named: `pull` first. The host's own merges follow the same
rule and leave a branch with conflicts to its model.

## Conflicts

The model resolves conflicts itself, the way it would with git.

1. `pull` merges the trunk in. Files changed on one side only, files with equal
   bytes, and compatible text edits merge by themselves (LayerFS does a
   three-way merge).
2. When LayerFS refuses a file as a `Conflict`, the CLI writes that file into
   the branch with conflict markers (`<<<<<<<`, `=======`, `>>>>>>>`) built from
   the common base and the two sides, and puts the branch in a merging state.
3. The model edits the files, then runs `arbor add <paths>` and
   `arbor pull --continue`; `arbor pull --abort` gives up the pull.
4. Paths configured last-writer-wins (LayerFS `.lww`) never conflict.

Notes are files, so a note conflict is resolved the same way. Reading a note in
conflict shows the markers; one `note replace` resolves it.

While a branch has an unfinished merge, `arbor status`, every usage reminder
and the refusal of `merge` say so and name the commands that finish it.

## Seeing other branches

Every branch can read everything: the trunk, merged branches and other
branches' unmerged work. History and note queries cover all branches by default
and mark each result with its branch and whether it is merged
([cli.md](cli.md)). Unmerged work is for reference; its file and note changes
count only once merged.

## Branch messages

- **Addressing:** by branch id, or by ownership key, which the host routes to
  the branch that holds the key. Only live branches can receive. A message to a
  closed branch, or to a key no branch holds, is refused with the next action
  named (query the branch's history, or address another branch).
- **Delivery:** an idle branch is woken by the message; a running one receives
  it as an input block at a tool-call boundary under the insertion rules
  ([scheduling.md](scheduling.md#insertion-timing)).
- **Replies:** a message may name `reply_to`; the reply is routed back as an
  input block. A sender never blocks waiting for one.
- **Records:** the send and the delivery are events on both branches, linked to
  each other.
- **Loops:** a chain of replies has a hop limit, and each branch has a send
  rate limit; both refusals name the reason and the next action.

## External effects

An effect takes place when it is made; it cannot wait for a merge and cannot be
rolled back. So:

- Every effect goes through one effect queue per host, which paces them and
  executes each exactly once, in the order made. The effect is recorded as an
  event; merges, rotations and continuations never repeat it.
- Together with ownership keys (one key, one branch at a time), effects on one
  target are serial by construction.
