# arbor

arbor is a framework for running many agents on many branches of work at
once, with one shared, queryable history and a context that stays coherent
across branches and across context resets.

- **Branches, not one long session.** Each piece of work runs on its own
  branch with its own live context. Branches run in parallel, see each other's
  unmerged work, message each other, and merge into a shared trunk.
- **Coherent context.** Context windows rotate by token budget, hand off to
  the next window, and keep notes that the host curates. Everything ever done
  stays queryable.
- **Files on LayerFS.** Every branch is a [LayerFS](https://github.com/Ephemeral-AI-Lab/layerfs)
  branch: cheap forks, a full writable workspace, shared committed history.
- **One CLI, one closed loop.** The `arbor` binary covers every operation of
  the framework. The model gets a small set of direct tools on top of the same
  commands and reaches the rest through `arbor` in bash.
- **Every module is replaceable.** The agent backend (pi by default), storage,
  scheduler, task sources, tools and the rest are interfaces; anything that
  implements one can replace the default.

Status: design. No code yet.

> The design grows out of the context, window and notes mechanisms built for
> [qqnt-gui-driver](https://github.com/4fuu/qqnt-gui-driver). This link is
> temporary and will be removed once arbor is built.

## Documents

| Page | Contents |
| --- | --- |
| [docs/overview.md](docs/overview.md) | goals, concepts, what carries over from the QQ project |
| [docs/architecture.md](docs/architecture.md) | layers, interfaces, replaceable modules |
| [docs/branches.md](docs/branches.md) | branch operations, merging, conflicts, branch messages, external effects |
| [docs/context.md](docs/context.md) | context windows, rotation, reminders, notes, references |
| [docs/scheduling.md](docs/scheduling.md) | tasks, ownership keys, assignment, insertion timing |
| [docs/cli.md](docs/cli.md) | the `arbor` command tree and the model's direct tools |
