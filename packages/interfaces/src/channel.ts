/**
 * The `Channel` interface: an outside source and sink - look up a message by
 * its native id, list what is connected, report online state
 * (docs/architecture.md#interfaces).
 *
 * An outside message keeps its native id, with a short channel prefix:
 * `qq:12345`. No second id is made up for it. When the channel is offline the
 * lookup returns the stored copy and says the channel is offline; a channel
 * plugged back in matches the same ids.
 */

import type { Block } from "./blocks.ts";
import type { ExternalRef, Ref, Target } from "./refs.ts";

/** One event from outside, before a task source turns it into a task. */
export interface OutsideEvent {
  /** The channel or service it came from: `qq`, `svc:crawler`. */
  source: string;
  /** Its native id, with the channel prefix: `qq:12345`. */
  external?: ExternalRef;
  /** What it touches: the conversation, the issue, the service. */
  target: Target;
  time: number;
  content: readonly Block[];
  /** The outside message it answers, when it is a reply. */
  replyTo?: ExternalRef;
  refs?: readonly Ref[];
}

/** What a channel lookup returns: the stored copy, plus the channel's state. */
export interface OutsideMessage extends OutsideEvent {
  external: ExternalRef;
  /** True when the copy came from the journal rather than the live channel. */
  stored: boolean;
}

export interface ChannelConnection {
  id: string;
  online: boolean;
  detail?: string;
}

export interface SendRequest {
  channel: string;
  /** The conversation or item it goes to. */
  target: Target;
  content: readonly Block[];
  /** The outside message it answers, by native id. */
  replyTo?: ExternalRef;
}

export interface SendResult {
  external: ExternalRef;
  time: number;
}

export type Unsubscribe = () => void | Promise<void>;

export interface Channel {
  readonly id: string;

  /** What is connected, and whether each connection is online. */
  connections(): Promise<readonly ChannelConnection[]>;

  /** Look up a message by its native id. Returns the stored copy when offline. */
  get(nativeId: ExternalRef): Promise<OutsideMessage | null>;

  /** The sink: send out. Used by an effect executor, never by a window directly. */
  send?(request: SendRequest): Promise<SendResult>;

  /** Push source. A host that prefers polling may ignore this. */
  subscribe?(handler: (events: readonly OutsideEvent[]) => void | Promise<void>): Unsubscribe;
}
