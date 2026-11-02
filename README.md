# arbor

arbor is a framework for an agent without sessions: many context windows run
at once over one shared record, so work moves in parallel, replies come fast,
and every window can find everything that was ever done.

- **No sessions to manage.** Work runs in disposable context windows. Any
  number run at the same time; none of them owns anything, and a window that
  ends loses nothing. The model looks up what it needs instead of carrying it.
- **One record, shared live.** Every input, tool call, result, send and note
  revision goes into one journal per project and is visible to every window as
  soon as it is written. Records never merge and are never lost.
- **Dispatch by a judge.** A judge (Jev by default, replaceable) decides which
  live window takes a new input, or opens a new one. There is no router
  session and no main line.
- **Consistency at the moments that are visible.** Windows run without locks.
  A send, a note write and a file publish are checked against what the window
  has seen, and refused with the newer events named when it is behind.
- **Files on LayerFS.** Only file changes are isolated: a window that writes
  files gets a [LayerFS](https://github.com/Ephemeral-AI-Lab/layerfs) branch,
  the host merges it into `main`, and a real conflict becomes a task for a
  model.
- **Direct tools plus code mode.** Decisions are direct tools; everything else
  is a module called from `code_exec`. There is no CLI.
- **Every module is replaceable.** The agent backend (pi by default), the
  journal, notes, workspaces, the judge, channels and the rest are interfaces.

Status: design. No code yet.

> The design grows out of the context, window and notes mechanisms built for
> [qqnt-gui-driver](https://github.com/4fuu/qqnt-gui-driver). This link is
> temporary and will be removed once arbor is built.

## Documents

| Page | Contents |
| --- | --- |
| [docs/overview.md](docs/overview.md) | goals, concepts, principles, routes considered |
| [docs/architecture.md](docs/architecture.md) | layers, interfaces, data placement, room for many machines |
| [docs/journal.md](docs/journal.md) | events, targets, watermarks, external ids, channels, refs, tracing |
| [docs/windows.md](docs/windows.md) | window lifecycle, prompt layout, reminders, continuation |
| [docs/dispatch.md](docs/dispatch.md) | task sources, judge decisions, insertion timing, backpressure, scheduled and system tasks |
| [docs/coordination.md](docs/coordination.md) | the board, notices, window messages, consistency checks, effects |
| [docs/memory.md](docs/memory.md) | notes, the active set, anchors, links |
| [docs/workspaces.md](docs/workspaces.md) | files on LayerFS, publishing, conflicts |
| [docs/tools.md](docs/tools.md) | direct tools and code mode modules |
