/**
 * The default `Scheduler`: insertion timing, backpressure and scheduled tasks
 * (docs/dispatch.md).
 *
 * These are the host's own rules, and they are a function of what they are
 * handed, so they are driven directly here and through the host in
 * dispatch.test.ts.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  QueuedInput,
  ScheduledTask,
  ScheduledTaskInput,
  TaskInput,
  TaskRef,
  WindowRuntimeState,
} from "@arbor/interfaces";
import { RuleScheduler } from "./scheduler.ts";
import { ManualTimers } from "./testing.ts";

function window(overrides: Partial<WindowRuntimeState> = {}): WindowRuntimeState {
  return {
    window: "c1",
    state: "running",
    startedAt: 1_000,
    targets: ["gh:pr:57"],
    currentTarget: "gh:pr:57",
    paused: false,
    protectionUntil: null,
    finalReminderSent: false,
    usage: { used: 1_000, limit: 200_000, reserve: 4_000 },
    ...overrides,
  };
}

function queued(id: string, overrides: Partial<QueuedInput> = {}): QueuedInput {
  return {
    id,
    kind: "inserted_task",
    targets: ["gh:pr:57"],
    priority: 0,
    time: 1_000,
    ...overrides,
  };
}

describe("insertion timing", () => {
  it("holds an input for another target back during the protection period", async () => {
    const scheduler = new RuleScheduler();
    const plan = await scheduler.insertion({
      state: window({ protectionUntil: 10_000 }),
      queued: [queued("q1", { targets: ["gh:issue:9"] })],
      now: 5_000,
    });

    assert.deepEqual(plan.insert, []);
    assert.equal(plan.hold.length, 1);
  });

  it("lets an input for the protected target in, and does not restart the period", async () => {
    const scheduler = new RuleScheduler();
    const state = window({ protectionUntil: 10_000 });
    const plan = await scheduler.insertion({ state, queued: [queued("q1")], now: 5_000 });

    assert.equal(plan.insert.length, 1);
    assert.equal(state.protectionUntil, 10_000, "an input for the same target does not restart it");
  });

  it("never holds an environment delta or a conversation update back", async () => {
    const scheduler = new RuleScheduler();
    const plan = await scheduler.insertion({
      state: window({ protectionUntil: 10_000 }),
      queued: [
        queued("q1", { kind: "environment_delta", targets: [], unfiltered: true }),
        queued("q2", { kind: "conversation_update", targets: ["gh:issue:9"], unfiltered: true }),
      ],
      now: 5_000,
    });

    assert.equal(plan.insert.length, 2);
  });

  it("orders the current target first, then priority and age", async () => {
    const scheduler = new RuleScheduler();
    const plan = await scheduler.insertion({
      state: window(),
      queued: [
        queued("q1", { targets: ["gh:issue:9"], priority: 9, time: 1 }),
        queued("q2", { targets: ["gh:pr:57"], priority: 0, time: 5 }),
        queued("q3", { targets: ["gh:pr:60"], priority: 1, time: 2 }),
        queued("q4", { targets: ["gh:pr:60"], priority: 1, time: 1 }),
      ],
      now: 10,
    });

    assert.deepEqual(
      plan.insert.map((item) => item.id),
      // The current target first, whatever its priority; then priority, then age.
      ["q2", "q1", "q4", "q3"],
    );
  });

  it("dispatches everything again once the final reminder has been sent", async () => {
    const scheduler = new RuleScheduler();
    const plan = await scheduler.insertion({
      state: window({ finalReminderSent: true }),
      queued: [queued("q1"), queued("q2", { targets: ["gh:issue:9"] })],
      now: 10,
    });

    assert.deepEqual(plan.insert, []);
    assert.equal(plan.redispatch.length, 2);
  });

  it("inserts nothing while the window is paused, and dispatches nothing again", async () => {
    const scheduler = new RuleScheduler();
    const plan = await scheduler.insertion({
      state: window({ paused: true }),
      queued: [queued("q1")],
      now: 10,
    });

    assert.deepEqual(plan.insert, []);
    assert.deepEqual(plan.redispatch, []);
    assert.equal(plan.hold.length, 1);
  });

  it("dispatches again what an ended window will never take", async () => {
    const scheduler = new RuleScheduler();
    const plan = await scheduler.insertion({
      state: window({ state: "ended" }),
      queued: [queued("q1")],
      now: 10,
    });

    assert.deepEqual(plan.insert, []);
    assert.equal(plan.redispatch.length, 1);
  });
});

describe("backpressure", () => {
  it("opens every waiting window while the backend reports no rate limit", async () => {
    const scheduler = new RuleScheduler();
    const plan = await scheduler.admission({ running: 40, queued: [task(), task()], now: 10 });

    assert.equal(plan.open, 2, "there is no cap on windows");
    assert.equal(plan.wait, false);
  });

  it("opens nothing while the backend is limited, and says when to ask again", async () => {
    const scheduler = new RuleScheduler();
    const plan = await scheduler.admission({
      running: 3,
      queued: [task()],
      rateLimit: { limited: true, retryAfterMs: 2_000 },
      now: 10,
    });

    assert.equal(plan.open, 0);
    assert.equal(plan.wait, true);
    assert.equal(plan.retryAfterMs, 2_000);
    assert.match(plan.reason ?? "", /rate limits/);
  });
});

describe("scheduled tasks", () => {
  /** Let the fired tasks reach the host: the loop is asynchronous. */
  async function settle(): Promise<void> {
    for (let index = 0; index < 20; index += 1) await Promise.resolve();
  }

  /** One scheduler with a manual clock, so a firing is driven by hand. */
  function scheduler(): {
    scheduler: RuleScheduler;
    timers: ManualTimers;
    at: (value: number) => void;
    fired: TaskInput[];
  } {
    const timers = new ManualTimers();
    const fired: TaskInput[] = [];
    let now = 1_000;
    const instance = new RuleScheduler({
      now: () => now,
      timers,
      nextTask: () => `t${Math.floor(now / 1_000)}` as TaskRef,
      onDue: (tasks) => {
        fired.push(...tasks);
      },
    });
    return { scheduler: instance, timers, at: (value: number) => (now = value), fired };
  }

  function schedule(overrides: Partial<ScheduledTaskInput> = {}): ScheduledTaskInput {
    return {
      firstAt: 10_000,
      targets: ["qq:group:1"],
      task: {
        reason: "a scheduled check",
        targets: ["qq:group:1"],
        time: 10_000,
        content: [{ kind: "data", fields: { content: "到点了" } }],
      },
      ...overrides,
    };
  }

  it("fires once at its first time, with the task it was made for", async () => {
    const host = scheduler();
    await host.scheduler.schedule(schedule());

    // The timer fires when its time has come, so the clock moves with it.
    host.at(10_000);
    host.timers.fireAll();
    await settle();

    assert.equal(host.fired.length, 1);
    assert.equal(host.fired[0]?.kind, "scheduled");
    assert.equal(host.fired[0]?.source, "schedule");
    assert.equal(host.fired[0]?.reason, "a scheduled check");
    assert.equal((await host.scheduler.list()).length, 0, "a one-off schedule is spent");
  });

  it("moves a repeating schedule on by whole periods", async () => {
    const host = scheduler();
    await host.scheduler.schedule(schedule({ repeat: { everyMs: 5_000 } }));

    host.at(10_000);
    host.timers.fireAll();
    await settle();
    const after = await host.scheduler.list();
    assert.equal(after.length, 1);
    assert.equal(after[0]?.nextAt, 15_000);
    assert.equal(after[0]?.lastAt, 10_000);
  });

  it("does not fire inside a daily skip period, and moves the firing past it", async () => {
    const host = scheduler();
    // 2026-11-05T10:00:00Z is inside the 09:00 to 11:00 skip period.
    const inside = Date.UTC(2026, 10, 5, 10, 0, 0);
    await host.scheduler.schedule(
      schedule({
        firstAt: inside,
        repeat: { everyMs: 3_600_000 },
        skipDaily: [{ from: "09:00", to: "11:00" }],
      }),
    );

    const fired = await host.scheduler.due(inside);

    assert.deepEqual(fired, [], "nothing fires inside the skip period");
    const after = await host.scheduler.list();
    assert.equal(after[0]?.nextAt, Date.UTC(2026, 10, 5, 11, 0, 0), "the firing moves to the period's end");
  });

  it("restores what it was made for after a restart", async () => {
    const host = scheduler();
    const stored: ScheduledTask = {
      ref: "t9",
      firstAt: 20_000,
      nextAt: 20_000,
      targets: ["qq:group:1"],
      paused: false,
      task: {
        reason: "a restored check",
        targets: ["qq:group:1"],
        time: 20_000,
        content: [{ kind: "data", fields: { content: "恢复后的检查" } }],
      },
    };
    await host.scheduler.restore([stored]);

    host.at(20_000);
    host.timers.fireAll();
    await settle();

    assert.equal(host.fired.length, 1);
    assert.equal(host.fired[0]?.reason, "a restored check");
  });
});

function task(): TaskInput {
  return {
    kind: "batch",
    reason: "a message arrived",
    targets: ["qq:group:1"],
    time: 10,
    content: [{ kind: "data", fields: { content: "hi" } }],
  };
}
