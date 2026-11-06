/**
 * The HTTP test channel plugin: the whole domain, through the public plugin
 * surface (docs/architecture.md#plugins).
 *
 * A plugin adds; it never patches the core. This one is a chat channel, and
 * every part of it is optional in the framework's own terms:
 *
 * - **adapters**: the `Channel` (docs/journal.md#external-ids) and the
 *   `EffectExecutor` that carries a window's `send` out through it
 *   (docs/coordination.md#effects). The host takes the channel's push source and
 *   ingests what arrives (docs/dispatch.md#tasks).
 * - **a prompt section**: the blocks its own inputs use, so the model reads what
 *   the channel is and how to answer on it. The blocks carry data; the words come
 *   from the text table the section merges into the host's one renderer.
 * - **judge criteria**: one extra criterion for its own inputs, which the host
 *   collects for the judge (`Arbor.judgeCriteria`).
 *
 * What it deliberately does not have: a direct tool or a code mode module of its
 * own. Capabilities are MCP servers and skills in `/env`, which the model reads,
 * changes and reinstalls with `reload` like any item.
 */

import type {
  Block,
  BlockKindSpec,
  Effect,
  EffectExecutor,
  EffectResult,
  Plugin,
  TextTable,
} from "@arbor/interfaces";
import type { HttpChannel } from "./channel.ts";

/** The block kind this plugin's prompt section renders. */
const HTTP_BLOCKS: readonly BlockKindSpec[] = [
  {
    kind: "http_channel",
    fields: [
      { name: "channel", type: "string", required: true },
      { name: "conversations", type: "strings" },
    ],
    lines: ["http.channel", "http.conversations"],
  },
];

/** The fixed strings its own block writes, merged into the host's table. */
const HTTP_TEXT: TextTable = {
  "http.channel": "HTTP 测试频道 {channel}：回复用 send，目标写 {channel}:<来源名>。",
  "http.conversations": "当前来源：{conversations}",
};

/** What the plugin is built from. */
export interface HttpPluginOptions {
  channel: HttpChannel;
}

/**
 * The executor that carries a window's send out through the channel. One effect
 * queue per host executes each effect exactly once and in the order it was made
 * (docs/coordination.md#effects); this is the executor that owns the sends whose
 * target is one of this channel's conversations.
 */
export class HttpSendExecutor implements EffectExecutor {
  readonly id = "http-send";

  private readonly channel: HttpChannel;

  constructor(channel: HttpChannel) {
    this.channel = channel;
  }

  can(effect: Effect): boolean {
    return effect.kind === "send" && effect.target.startsWith(`${this.channel.id}:`);
  }

  async run(effect: Effect): Promise<EffectResult> {
    const sent = await this.channel.send({
      channel: this.channel.id,
      target: effect.target,
      content: effect.content,
      ...(effect.replyTo === undefined ? {} : { replyTo: effect.replyTo }),
    });
    // The native id the outside world gave it, which the host records on the
    // effect's result, so a ref resolves to what was sent.
    return { ok: true, external: sent.external };
  }
}

/** The plugin a deployment registers with the host. */
export function httpPlugin(options: HttpPluginOptions): Plugin {
  const channel = options.channel;
  return {
    name: "http",
    adapters: {
      channels: [channel],
      effectExecutors: [new HttpSendExecutor(channel)],
    },
    promptSection: {
      tag: "http",
      blocks: HTTP_BLOCKS,
      text: HTTP_TEXT,
      content: (): readonly Block[] => [
        {
          kind: "http_channel",
          fields: {
            channel: channel.id,
            conversations: channel.conversations().map((target) =>
              target.startsWith(`${channel.id}:`) ? target.slice(channel.id.length + 1) : target,
            ),
          },
        },
      ],
    },
    judgeCriteria: [
      {
        decision: "route",
        criteria: ["一个来源里的消息进入已经在该来源中的窗口，而不是新开一个窗口"],
      },
    ],
  };
}
