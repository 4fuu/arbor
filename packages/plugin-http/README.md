# @4fu/arbor-plugin-http

The HTTP test channel: the first plugin that runs the whole host end to end
([docs/architecture.md#plugins](../../docs/architecture.md#plugins)).

A webhook in, a window's sends out, and a small page a person drives it from.
Nothing here is specific to the plugin's own domain: a deployment that plugs a
different channel in composes the same stack the same way.

## Run it

```sh
DEEPSEEK_API_KEY=… JEV_API_KEY=… pnpm --filter @4fu/arbor-plugin-http start
```

Then open the address it prints (127.0.0.1:8787 by default), pick or create a
conversation, and send a message. Replies arrive on the page as the window sends
them. The board beside the conversation is read-only: which windows are live and
what they are doing.

| Name | What it names | Default |
| --- | --- | --- |
| `ARBOR_DATA_DIR` | the journal, notes, `/env` and the workspaces | a directory under the system temp dir |
| `ARBOR_HOST` | the host the page binds | `127.0.0.1` |
| `ARBOR_PORT` | the port the page binds | `8787` |
| `ARBOR_MODEL` | the model the `chat` tier maps to | `deepseek-flash` |
| `DEEPSEEK_API_KEY` | pi's key for DeepSeek | - |
| `JEV_API_KEY` | Jev's key | - |

A configuration names a secret and never holds its value: the two keys are
environment variables pi and Jev read themselves, and the settings name them, so
the host's scrub covers every string that leaves it
([docs/architecture.md#data-placement](../../docs/architecture.md#data-placement)).

The page is a local test tool, so it binds localhost by default. Visibility,
permissions and auth are deferred.

## The channel

| Route | What it does |
| --- | --- |
| `GET /` | the page |
| `GET /app.js` | the page's script |
| `GET /api/state` | the connection, the conversations and the board |
| `GET /api/messages?conversation=<name>` | one conversation, both directions |
| `POST /webhook` | one inbound message |

`POST /webhook` takes `{ "conversation": "demo", "id": "42", "from": "alice",
"text": "部署流程是什么", "replyTo": "41" }`. The `id` is the sender's own id for
the message, which the channel keeps as its native id: `http:42`. The journal's
unique index on the native id is what stores a redelivered message once, so the
channel forwards every delivery it is given and keeps one line per native id on
the page. The answer says which happened: `redelivered`.

A window answers with `send({ to: "http:demo", content: "…" })`. The host records
the effect, the queue executes it exactly once, and this plugin's executor carries
it out through the channel, which hands back the native id the outside world would
have given it
([docs/coordination.md#effects](../../docs/coordination.md#effects)).

## What the plugin registers

| Part | What it gives |
| --- | --- |
| `adapters.channels` | the `Channel`: `connections`, `get`, `send` and the push source |
| `adapters.effectExecutors` | the executor that owns the sends to this channel's conversations |
| `promptSection` | one block kind and its two fixed lines, so the model reads what the channel is and how to answer on it |
| `judgeCriteria` | one extra criterion for the `route` decision |

It adds no direct tool and no code mode module of its own: capabilities are MCP
servers and skills in `/env`, which the model reads, changes and reinstalls with
`reload` like any item.

## Test it

```sh
pnpm --filter @4fu/arbor-plugin-http test
```

The test composes the whole stack - the SQLite journal and notes, the directory
environment, the directory workspace, pi over its scripted faux provider and the
default judge over a fake transport - so it needs no key and makes no network
call. It proves the channel end to end: a webhook message reaches dispatch and
opens a window; a second message in the same conversation is steered into that
window; a reply comes back out through the channel; and a redelivered native id is
stored once.
