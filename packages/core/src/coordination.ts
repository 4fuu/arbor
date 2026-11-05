/**
 * Coordination: how windows that run in parallel work together without locks
 * (docs/coordination.md).
 *
 * Windows share the board and share deliveries. A new event on a conversation a
 * window is in is steered into it as it arrives, so a window rarely acts on
 * stale input; a notice tells the other windows on a target about an event the
 * judge says they need; a broadcast offers a message to every live window; a
 * window message goes to one live window and a reply is routed back as an input
 * block, with a hop limit so two windows cannot answer each other forever.
 *
 * Nothing here is a lock. Every delivery is an input block that enters a window
 * at a tool-call boundary under the insertion rules
 * (docs/dispatch.md#insertion-timing).
 */

import type {
  BoardLine,
  CandidateWindow,
  Delivery,
  EnvDelta,
  Event,
  EventRef,
  Journal,
  MessageRef,
  Ref,
  Target,
  WindowRef,
} from "@arbor/interfaces";
import { arborError } from "@arbor/errors";
import {
  broadcastBlock,
  conversationUpdateBlock,
  dataBlock,
  environmentDeltaBlock,
  noticeBlock,
  windowMessageBlock,
} from "@arbor/prompt";
import type { Dispatcher } from "./dispatch.ts";
import { MAX_REPLY_HOPS } from "./dispatch.ts";
import type { WindowRecord } from "./host.ts";

/**
 * How one delivery's kind orders against the others waiting for a window.
 * Higher goes first (docs/dispatch.md#insertion-timing).
 */
export const DELIVERY_PRIORITY: Record<Delivery["kind"], number> = {
  // Currency and what a window can call come first: they change what the window
  // would otherwise do next.
  conversation_update: 1,
  environment_delta: 1,
  // A direct answer to this window comes before anything that only informs it.
  window_message: 1,
  notice: 0,
  inserted_task: 0,
  reminder: 0,
  // A broadcast needs no reply, so it goes last.
  broadcast: -1,
};

/** What the coordinator needs from the host. */
export interface CoordinationHost {
  readonly journal: Journal;
  readonly dispatcher: Dispatcher;
  now(): number;
  nextMessage(): MessageRef;
  live(): readonly WindowRecord[];
  boardLine(window: WindowRef): BoardLine | undefined;
  /** One window's profile, for the judge. */
  profile(window: WindowRef): Promise<CandidateWindow>;
  /** Deliver one block into a live window, under the insertion rules. */
  deliver(
    window: WindowRef,
    delivery: Delivery,
    options: { priority: number; targets?: readonly Target[] },
  ): Promise<void>;
}

export class Coordinator {
  private readonly host: CoordinationHost;

  constructor(host: CoordinationHost) {
    this.host = host;
  }

  /**
   * A new event reaches the windows already in it
   * (docs/coordination.md#staying-current).
   *
   * Outside traffic - a message from a channel, or the result of a send - goes
   * to every live window that touched the target, unfiltered and not held back
   * by the protection period. Any other event makes every *other* live window
   * that touched the same target a candidate for a notice, and the judge decides
   * which ones need it.
   */
  async circulate(event: Event): Promise<void> {
    const behind: WindowRecord[] = [];
    for (const record of this.host.live()) {
      if (record.window === event.window || record.state === "ended") continue;
      const touched = this.host.boardLine(record.window)?.targets ?? [];
      if (!event.targets.some((target) => touched.includes(target))) continue;
      if (await this.seen(record.window, event)) continue;
      behind.push(record);
    }
    if (behind.length === 0) return;
    // Outside traffic - a message from a channel - keeps a conversation current,
    // so nothing is filtered and nothing is held back. Any other event is news
    // about a target, so the windows that touched it are notice candidates and
    // the judge decides which ones need it (docs/coordination.md#deliveries).
    const current = event.kind === "input" || event.kind === "effect_result";
    if (current) {
      for (const record of behind) {
        await this.host.deliver(
          record.window,
          {
            kind: "conversation_update",
            refs: [event.ref],
            time: event.time,
            content: [
              conversationUpdateBlock({
                conversation: event.targets[0] ?? "",
                refs: [event.ref],
                time: event.time,
                content: [dataBlock(openingWords(event.body))],
              }),
            ],
          },
          { priority: DELIVERY_PRIORITY.conversation_update, targets: event.targets },
        );
        await this.see(record.window, event);
      }
      return;
    }
    const candidates: CandidateWindow[] = [];
    for (const record of behind) candidates.push(await this.host.profile(record.window));
    const wanted = await this.host.dispatcher.notice(
      {
        ref: event.ref,
        kind: event.kind,
        target: event.targets[0] ?? "",
        summary: openingWords(event.body),
      },
      candidates,
    );
    for (const window of wanted) {
      await this.host.deliver(
        window,
        {
          kind: "notice",
          ...(event.window === null ? {} : { from: event.window }),
          refs: [event.ref],
          time: event.time,
          content: [
            noticeBlock({
              ...(event.window === null ? {} : { from: event.window }),
              refs: [event.ref],
              time: event.time,
              content: openingWords(event.body),
            }),
          ],
        },
        { priority: DELIVERY_PRIORITY.notice, targets: event.targets },
      );
      await this.see(window, event);
    }
  }

  /**
   * A message to every live window. The judge decides for each one whether it
   * needs it, except for an environment delta, which is never filtered. The
   * block carries one fixed host line: it is a broadcast, it needs no reply, and
   * a reply goes to the sender as a window message.
   */
  async broadcast(from: WindowRef, text: string, unfiltered = false): Promise<number> {
    const candidates: CandidateWindow[] = [];
    for (const record of this.host.live()) {
      if (record.window === from || record.state === "ended") continue;
      candidates.push(await this.host.profile(record.window));
    }
    const ref = this.host.nextMessage();
    const event = await this.host.journal.append({
      kind: "broadcast",
      window: from,
      body: text,
      refs: [ref],
    });
    const wanted = await this.host.dispatcher.broadcast(
      { from, summary: openingWords(event.body), refs: [event.ref] },
      candidates,
      unfiltered,
    );
    for (const window of wanted) {
      await this.host.deliver(
        window,
        {
          kind: "broadcast",
          from,
          refs: [event.ref, ref],
          time: event.time,
          content: [broadcastBlock({ from, time: event.time, content: [dataBlock(text)] })],
        },
        { priority: DELIVERY_PRIORITY.broadcast },
      );
    }
    return wanted.length;
  }

  /**
   * A message to another live window. A message to an ended window is refused
   * with the next action named, and a chain of replies has a hop limit, so two
   * windows cannot answer each other forever.
   *
   * The send and the delivery are events, linked to each other. A sender never
   * blocks waiting for a reply.
   */
  async windowMessage(from: WindowRef, to: WindowRef, text: string, replyTo?: Ref): Promise<MessageRef> {
    const record = this.host.live().find((one) => one.window === to);
    if (record === undefined || record.state === "ended") throw windowRefusal(to);
    // The chain a reply joins carries its own length, so the limit needs no walk.
    const hops = replyTo === undefined ? 0 : (await this.hopsOf(replyTo)) + 1;
    if (hops > MAX_REPLY_HOPS) throw hopRefusal(MAX_REPLY_HOPS);
    const ref = this.host.nextMessage();
    const event = await this.host.journal.append({
      kind: "window_message",
      window: from,
      body: text,
      targets: [`window:${to}`],
      refs: [ref, ...(replyTo === undefined ? [] : [replyTo])],
      ...(replyTo === undefined ? {} : { links: [{ kind: "reply", to: replyTo, weight: hops }] }),
    });
    await this.host.deliver(
      to,
      {
        kind: "window_message",
        from,
        refs: [ref, event.ref],
        time: event.time,
        content: [
          windowMessageBlock({
            from,
            ...(replyTo === undefined ? {} : { replyTo }),
            ref,
            time: event.time,
            content: [dataBlock(text)],
          }),
        ],
      },
      { priority: DELIVERY_PRIORITY.window_message, targets: [`window:${to}`] },
    );
    return ref;
  }

  /**
   * How many replies the chain a message belongs to already carries. The count
   * rides on the `reply` link the message was sent with, so a limit needs no
   * walk of the chain.
   */
  async hopsOf(message: Ref): Promise<number> {
    const event = await this.messageEvent(message);
    if (event === null) return 0;
    return event.links.find((link) => link.kind === "reply")?.weight ?? 0;
  }

  /**
   * The window_message event that carries one message ref: the one that sent it,
   * not the delivery that carried it in and not a reply that names it.
   */
  private async messageEvent(message: Ref): Promise<Event | null> {
    const page = await this.host.journal.links(message, { limit: 50 });
    for (const item of page.items) {
      if (item.direction !== "in") continue;
      const event = await this.host.journal.get(item.ref as EventRef);
      if (event === null || event.kind !== "window_message") continue;
      if (!event.refs.includes(message)) continue;
      // A reply to this message names it too; the send that made it does not
      // answer anything.
      if (event.links.some((link) => link.kind === "reply" && link.to === message)) continue;
      return event;
    }
    return null;
  }

  /**
   * An environment delta reaches every live window, unfiltered and not held back
   * by the protection period, because it changes what a window can call
   * (docs/coordination.md#broadcasts). The rule bound is the service layer's
   * own, so nothing is asked.
   */
  async environmentDelta(delta: EnvDelta): Promise<number> {
    const block = environmentDeltaBlock(delta, this.host.now());
    let delivered = 0;
    for (const record of this.host.live()) {
      if (record.state === "ended") continue;
      await this.host.deliver(
        record.window,
        {
          kind: "environment_delta",
          refs: [delta.revision],
          time: this.host.now(),
          content: [block],
        },
        { priority: DELIVERY_PRIORITY.environment_delta },
      );
      delivered += 1;
    }
    return delivered;
  }

  /** The window has seen this event, so its watermark moves forward. */
  private async see(window: WindowRef, event: Event): Promise<void> {
    for (const target of event.targets) {
      await this.host.journal.advanceWatermark(window, target, event.seq);
    }
  }

  /** True when the window has already seen this event on every target it touched. */
  private async seen(window: WindowRef, event: Event): Promise<boolean> {
    for (const target of event.targets) {
      const watermark = await this.host.journal.watermark(window, target);
      if (watermark === null || watermark < event.seq) return false;
    }
    return true;
  }
}

/** An event's opening words, for a one-line delivery. */
function openingWords(body: string | null): string {
  if (body === null) return "";
  return body.replace(/\s+/gu, " ").trim().slice(0, 120);
}

/** A message to a window that is not live: read its history, or address a live one. */
function windowRefusal(window: WindowRef): Error {
  return arborError({
    code: "not_found",
    rule: "window.not_found",
    message: `window: 没有窗口 ${window}`,
    nextAction: "用 windows.show 读它的记录，或用 windows.list 找一个运行中的窗口。",
  });
}

/** A reply past the hop limit. */
function hopRefusal(hops: number): Error {
  return arborError({
    code: "limit_reached",
    rule: "window_message.hop_limit",
    message: `window: 回复链已有 ${hops} 跳，达到上限`,
    nextAction: "把结论直接说清，或另起一个问题重新开始这段对话。",
  });
}
