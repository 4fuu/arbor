/**
 * @arbor/plugin-http - the HTTP test channel, and the first plugin the host
 * runs end to end (docs/architecture.md#plugins).
 *
 * The channel is the adapter: a webhook in, a window's sends out, and a page a
 * person drives it from. `httpPlugin` wraps it as a `Plugin`, and `src/server.ts`
 * is the entry point that composes the default stack around it.
 */

export {
  HttpChannel,
  type HttpChannelOptions,
  type HttpDirection,
  type HttpMessage,
  type WebhookBody,
  type WebhookResult,
} from "./channel.ts";
export { HttpSendExecutor, httpPlugin, type HttpPluginOptions } from "./plugin.ts";
