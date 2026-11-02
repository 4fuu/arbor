# Scheduling

The scheduler decides which branch a task goes to and when an input enters a
running branch. The built-in scheduler is deliberately simple; a deployment
that needs more replaces it through the `Scheduler` interface
([architecture.md](architecture.md#interfaces)).

## Tasks

A task is one piece of outside work produced by a `TaskSource`. It carries:

- an **ownership key** - what it is about (a conversation, an issue, a path);
- a reason and a time;
- its content, rendered as an input block.

A task source may batch several outside events into one task (the QQ
project's debounce is such a source). Batching is the source's business, not
the scheduler's.

## Assignment

1. **Ownership first.** If a live branch holds the task's key, the task goes
   to that branch. One key is handled by one branch at a time, so two branches
   never answer the same conversation or edit the same issue at once.
2. **Otherwise an idle branch,** the one with the highest score.
3. **Otherwise a new branch,** forked from the trunk.

There is no cap on branches.

### The built-in score

Three terms, each 0..1, summed with configurable weights:

| Term | Meaning |
| --- | --- |
| activity | how recently the branch worked; a branch that just finished is likely to know the surroundings |
| context share | how much of its window is left; a branch near rotation scores low |
| warmth | whether its prefix is likely still cached by the provider |

A deployment can register `Scorer`s (relevance by embeddings, a model judge,
a domain rule) to add terms, or replace the scheduler entirely.

## Insertion timing

A running branch receives new tasks and branch messages as input blocks at a
tool-call boundary. Rules, carried over from the QQ project:

- **Protection period** (default 60 s, configurable, 0 inserts at once): when a
  branch starts on a key, only inputs for that key enter during the period.
  Inputs for the same key do not restart it.
- **After the period:** an input for the current key that is still being
  batched goes in first; then the others, by priority and age, and the
  branch's current key becomes the inserted one's.
- **No insertion after the final usage reminder.** The branch finishes its
  run; waiting inputs go to its next context or to another branch.
- **Paused:** nothing is inserted.

The model sees only input blocks; it never manages timing.

## Scheduled tasks

A scheduled task is a task source driven by time: a first time, a repeat rule,
optional daily skip periods, an optional ownership key. The QQ project's
spreading of colliding repeating tasks and their jitter carry over as
settings, off by default.
