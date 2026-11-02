# Workspaces

Files are the only thing that is isolated per window, because a file change
in progress must not break another window's work. Everything else is in the
shared journal and notes.

## Lifecycle

1. **Fork.** A window's first file write forks a workspace from LayerFS
   `main`. A fork copies no files. A window that only reads files reads `main`.
2. **Work.** `read`, `write` and `edit` go to the workspace; every write is
   one commit. `bash` mounts the workspace, runs the command, commits what it
   changed and unmounts.
3. **Continue.** A continuation window keeps the workspace, so long work spans
   windows.
4. **Publish.** `publish(message)` asks the host to merge the workspace into
   `main`; a window that ends with unpublished changes publishes them. A
   workspace can publish any number of times and keep working.

Any window can read another workspace's unpublished files, for reference.

## Merging

The host merges, never the model. A publish first takes `main`'s new changes
into the workspace, then merges into `main`. Files changed on one side only,
files with equal bytes and compatible text edits merge by themselves; paths
configured last-writer-wins (LayerFS `.lww`) never conflict.

## Conflicts

When LayerFS refuses a file as a conflict, the host:

1. writes that file into the workspace with conflict markers built from the
   common base and the two sides;
2. makes a system task with instructions - which files, which publishes
   collided, with refs - and dispatches it to the window that published if it
   is still live, otherwise to a new window with its ref
   ([dispatch.md](dispatch.md#system-tasks));
3. publishes again once the model has edited the files and called `publish`.

## Cleanup

A workspace that has been unpublished and unused for a set time becomes a
system task to publish or discard it.
