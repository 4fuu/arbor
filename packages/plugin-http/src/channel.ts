/**
 * The HTTP test channel: an outside source and sink over plain HTTP
 * (packages/interfaces/src/channel.ts, docs/architecture.md#interfaces).
 *
 * It is the first real plugin's adapter, and it is a test tool: it holds a
 * conversation per id, turns an inbound message into one `OutsideEvent` that
 * carries its native id, records what a window sent, and serves the page a
 * person drives it from. Nothing here knows the host; a deployment plugs the
 * channel in and the host takes its push source
 * (docs/architecture.md#plugins).
 *
 * An inbound message keeps the id the sender gave it, with the channel prefix:
 * `http:42`. The journal's unique index on `external` is what makes a
 * redelivered message stored once (docs/journal.md#external-ids), so this
 * channel forwards every delivery it is given and keeps one line per native id
 * on the page: the exactly-once guarantee is the host's, not the transport's.
 *
 * The page it serves is a local test tool, so the server binds `127.0.0.1` by
 * default and a deployment that names another host says so explicitly.
 * Visibility, permissions and auth are not part of the framework.
 */

import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { arborError } from "@4fu/arbor-errors";
import { dataBlock } from "@4fu/arbor-prompt";
import type {
  BoardLine,
  Channel,
  ChannelConnection,
  ExternalRef,
  OutsideEvent,
  OutsideMessage,
  SendRequest,
  SendResult,
  Target,
  Unsubscribe,
} from "@4fu/arbor-interfaces";

/** How large a request body may be. 1 MiB is far more than a test message. */
const MAX_BODY_BYTES = 1024 * 1024;

/** Where the page's own files are, beside this module. */
const WEB_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), "web");

/** The channel prefix every native id and every conversation target carries. */
const DEFAULT_CHANNEL_ID = "http";

/** Which way one message went. */
export type HttpDirection = "in" | "out";

/** One message this channel carries, in either direction. */
export interface HttpMessage {
  /** Its native id, with the channel prefix: `http:42`. */
  external: ExternalRef;
  /** The conversation it belongs to: `http:demo`. */
  conversation: Target;
  direction: HttpDirection;
  /** Who sent it: the webhook's `from`, or `arbor` for a window's send. */
  from: string;
  text: string;
  time: number;
  /** The native id it answers, when it is a reply. */
  replyTo?: ExternalRef;
}

/** What a deployment configures for the channel. */
export interface HttpChannelOptions {
  /** The channel prefix. `http`. */
  id?: string;
  /** The live board, for the page's read-only view. Absent when it has none. */
  board?: () => readonly BoardLine[];
  /** The host to bind. `127.0.0.1`, because the page is a local test tool. */
  host?: string;
  /** The port to bind. 0 picks a free one. */
  port?: number;
  /** The clock. */
  now?: () => number;
}

/** One webhook message, as the page or an outside system posts it. */
export interface WebhookBody {
  /** The conversation it belongs to, without the channel prefix. */
  conversation: string;
  /** The sender's own id for it. Absent when the channel assigns one. */
  id?: string;
  text: string;
  from?: string;
  /** The native id it answers, when it is a reply. */
  replyTo?: string;
}

/** What the webhook answers with: where the message landed, and whether it had. */
export interface WebhookResult {
  external: ExternalRef;
  target: Target;
  /** True when this native id had already arrived, so the host stored it once. */
  redelivered: boolean;
}

/** One subscription to what arrives. */
type Handler = (events: readonly OutsideEvent[]) => void | Promise<void>;

export class HttpChannel implements Channel {
  readonly id: string;

  private readonly board: (() => readonly BoardLine[]) | undefined;
  private readonly host: string;
  private readonly port: number;
  private readonly clock: () => number;

  private readonly messages: HttpMessage[] = [];
  private readonly handlers = new Set<Handler>();
  private server: Server | undefined;
  private address: string | undefined;
  /** Every native id this channel has used, so an assigned one never collides. */
  private readonly used = new Set<string>();
  private next = 1;

  constructor(options: HttpChannelOptions = {}) {
    this.id = options.id ?? DEFAULT_CHANNEL_ID;
    this.board = options.board;
    this.host = options.host ?? "127.0.0.1";
    this.port = options.port ?? 0;
    this.clock = options.now ?? (() => Date.now());
  }

  // ---- the interface ------------------------------------------------------

  /** What is connected: the one connection this channel has, and its state. */
  async connections(): Promise<readonly ChannelConnection[]> {
    return [
      {
        id: this.id,
        online: this.online,
        ...(this.address === undefined ? {} : { detail: this.address }),
      },
    ];
  }

  /**
   * Look up a message by its native id. This channel is its own store, so the
   * copy is the one it kept: `stored` says it came from the store rather than
   * from a live source, which for this channel means the server is not up
   * (packages/interfaces/src/channel.ts).
   */
  async get(nativeId: ExternalRef): Promise<OutsideMessage | null> {
    const message = this.messages.find((one) => one.external === nativeId);
    if (message === undefined) return null;
    return {
      external: message.external,
      source: this.id,
      target: message.conversation,
      time: message.time,
      content: [dataBlock(message.text)],
      ...(message.replyTo === undefined ? {} : { replyTo: message.replyTo }),
      stored: !this.online,
    };
  }

  /**
   * The sink. A window's `send` reaches here as an effect
   * (docs/coordination.md#effects); the channel records it and hands back the
   * native id the outside world would have given it, which the host records on
   * the effect's result.
   */
  async send(request: SendRequest): Promise<SendResult> {
    const external = this.assign().external;
    const message: HttpMessage = {
      external,
      conversation: request.target,
      direction: "out",
      from: "arbor",
      text: textOfBlocks(request.content),
      time: this.clock(),
      ...(request.replyTo === undefined ? {} : { replyTo: request.replyTo }),
    };
    this.messages.push(message);
    return { external: message.external, time: message.time };
  }

  /**
   * Push source. The host takes it and ingests what arrives
   * (docs/dispatch.md#tasks); a host that prefers polling ignores it.
   */
  subscribe(handler: Handler): Unsubscribe {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  // ---- what the page reads ------------------------------------------------

  /** True once the server is listening. */
  get online(): boolean {
    return this.server !== undefined && this.address !== undefined;
  }

  /** Where the page is served, once it is up. */
  get url(): string | undefined {
    return this.address;
  }

  /** Every message this channel carries, oldest first. */
  list(): readonly HttpMessage[] {
    return [...this.messages];
  }

  /** The conversations this channel carries, most recent first. */
  conversations(): readonly Target[] {
    const seen = new Map<Target, number>();
    for (const message of this.messages) seen.set(message.conversation, message.time);
    return [...seen.entries()].sort((left, right) => right[1] - left[1]).map(([target]) => target);
  }

  /** Start serving the page and the webhook. Resolves with where it listens. */
  async listen(): Promise<string> {
    if (this.server !== undefined) return this.address as string;
    const server = createServer((request, response) => {
      void this.route(request, response).catch((error: unknown) => {
        void this.answer(response, 500, { ok: false, error: infoOf(error) });
      });
    });
    this.server = server;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(this.port, this.host, () => resolve());
      });
    } catch (error) {
      this.server = undefined;
      throw error;
    }
    const bound = server.address();
    const port = typeof bound === "object" && bound !== null ? bound.port : this.port;
    this.address = `http://${this.host}:${port}`;
    return this.address;
  }

  /** Stop serving. What the channel recorded stays, for `get` and for the page. */
  async close(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    this.address = undefined;
    if (server === undefined) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }

  // ---- the webhook ---------------------------------------------------------

  /**
   * One inbound message. The channel builds the outside event - its native id,
   * the conversation as its target, the blocks a window reads - and hands it to
   * every subscriber, which is the host (docs/dispatch.md#tasks). A native id
   * that already arrived is forwarded anyway: the host's journal is what keeps
   * it stored once, and the answer says so.
   */
  async receive(body: WebhookBody): Promise<WebhookResult> {
    const conversation = typeof body.conversation === "string" ? body.conversation.trim() : "";
    if (conversation === "") {
      throw arborError({
        code: "invalid_input",
        rule: "http.webhook.conversation",
        message: "webhook: 没有给出来源名",
        nextAction: "在 body 里给 conversation，例如 {\"conversation\":\"demo\",\"text\":\"你好\"}。",
      });
    }
    const text = typeof body.text === "string" ? body.text : "";
    if (text.trim() === "") {
      throw arborError({
        code: "invalid_input",
        rule: "http.webhook.text",
        message: "webhook: 没有给出消息内容",
        nextAction: "在 body 里给 text。",
      });
    }
    const replyTo =
      typeof body.replyTo === "string" && body.replyTo.trim() !== ""
        ? nativeId(this.id, body.replyTo.trim())
        : undefined;
    const target = `${this.id}:${conversation}`;
    const assigned = this.assign(
      typeof body.id === "string" && body.id.trim() !== "" ? body.id.trim() : undefined,
    );
    const redelivered = assigned.seen;
    // One line per native id on the page, even when a sender retries.
    if (!redelivered) {
      this.messages.push({
        external: assigned.external,
        conversation: target,
        direction: "in",
        from: typeof body.from === "string" && body.from.trim() !== "" ? body.from.trim() : "web",
        text,
        time: this.clock(),
        ...(replyTo === undefined ? {} : { replyTo }),
      });
    }
    const event: OutsideEvent = {
      source: this.id,
      external: assigned.external,
      target,
      time: this.clock(),
      content: [dataBlock(text)],
      ...(replyTo === undefined ? {} : { replyTo }),
    };
    for (const handler of [...this.handlers]) await handler([event]);
    return { external: assigned.external, target, redelivered };
  }

  /** One native id, with the channel prefix, and whether it had arrived before. */
  private assign(wanted?: string): { external: ExternalRef; seen: boolean } {
    if (wanted !== undefined) {
      const external = nativeId(this.id, wanted);
      const seen = this.used.has(external);
      this.used.add(external);
      return { external, seen };
    }
    for (;;) {
      const external = nativeId(this.id, String(this.next));
      this.next += 1;
      if (this.used.has(external)) continue;
      this.used.add(external);
      return { external, seen: false };
    }
  }

  // ---- the HTTP surface ----------------------------------------------------

  /** The page, its script, and the JSON reads the page polls. */
  private async route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", `http://${this.host}`);
    if (request.method === "POST" && url.pathname === "/webhook") {
      const received = await this.receive((await bodyOf(request)) as WebhookBody);
      await this.answer(response, 200, { ok: true, ...received });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/state") {
      await this.answer(response, 200, {
        ok: true,
        channel: this.id,
        online: this.online,
        address: this.address ?? "",
        conversations: this.conversations().map((target) => ({
          target,
          messages: this.messages.filter((message) => message.conversation === target).length,
        })),
        board: (this.board?.() ?? []).map((line) => ({
          window: line.window,
          state: line.state,
          doing: line.doing,
          targets: [...line.targets],
          expects: line.expects.map((one) => one.description ?? one.item ?? one.ref),
          usage: { used: line.usage.used, limit: line.usage.limit },
        })),
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/messages") {
      const wanted = url.searchParams.get("conversation") ?? "";
      const target = wanted === "" ? undefined : wanted.includes(":") ? wanted : `${this.id}:${wanted}`;
      await this.answer(response, 200, {
        ok: true,
        items: this.messages
          .filter((message) => target === undefined || message.conversation === target)
          .map((message) => ({
            external: message.external,
            conversation: message.conversation,
            direction: message.direction,
            from: message.from,
            text: message.text,
            time: message.time,
            ...(message.replyTo === undefined ? {} : { replyTo: message.replyTo }),
          })),
      });
      return;
    }
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      await this.file(response, join(WEB_DIRECTORY, "index.html"), "text/html; charset=utf-8");
      return;
    }
    if (request.method === "GET" && url.pathname === "/app.js") {
      await this.file(response, join(WEB_DIRECTORY, "app.js"), "text/javascript; charset=utf-8");
      return;
    }
    await this.answer(response, 404, {
      ok: false,
      error: {
        code: "not_found",
        rule: "http.route.unknown",
        message: `没有 ${request.method ?? "GET"} ${url.pathname} 这个端点`,
        nextAction: "用 GET / 打开页面，POST /webhook 收消息，GET /api/state 看现场板。",
      },
    });
  }

  /** One file of the page, read on each request so a change needs no restart. */
  private async file(response: ServerResponse, path: string, type: string): Promise<void> {
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch {
      await this.answer(response, 404, {
        ok: false,
        error: {
          code: "not_found",
          rule: "http.file.absent",
          message: `页面文件 ${path} 不存在`,
          nextAction: "检查这个插件的 src/web 目录。",
        },
      });
      return;
    }
    response.writeHead(200, { "content-type": type, "cache-control": "no-store" });
    response.end(text);
  }

  private async answer(response: ServerResponse, status: number, body: unknown): Promise<void> {
    response.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(JSON.stringify(body));
  }
}

/** The text of a send's blocks: what a window said, as one string. */
function textOfBlocks(blocks: readonly { fields: Record<string, unknown> }[]): string {
  const lines: string[] = [];
  for (const block of blocks) {
    const content = block.fields.content;
    if (typeof content === "string") lines.push(content);
  }
  return lines.join("\n");
}

/** One native id: the channel prefix, then the sender's own id for the message. */
function nativeId(channel: string, id: string): ExternalRef {
  return `${channel}:${id}` as ExternalRef;
}

/** One request body, read whole and parsed. */
async function bodyOf(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) {
      throw arborError({
        code: "limit_reached",
        rule: "http.body.too_large",
        message: `请求体超过 ${MAX_BODY_BYTES} 字节`,
        nextAction: "分条发送，或把这个插件的上限调大。",
      });
    }
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw arborError({
      code: "invalid_input",
      rule: "http.body.json",
      message: "请求体不是 JSON",
      nextAction: "发送一个 JSON 对象：{\"conversation\":\"demo\",\"text\":\"你好\"}。",
    });
  }
}

/** Anything a route threw, in the core's error shape. */
function infoOf(error: unknown): Record<string, unknown> {
  const info = error as { code?: unknown; rule?: unknown; message?: unknown; nextAction?: unknown };
  return {
    code: typeof info.code === "string" ? info.code : "internal",
    rule: typeof info.rule === "string" ? info.rule : "http.failed",
    message: typeof info.message === "string" ? info.message : String(error),
    ...(typeof info.nextAction === "string" ? { nextAction: info.nextAction } : {}),
  };
}
