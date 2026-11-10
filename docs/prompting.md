# Prompting

Rules for every text a model reads: the system prompt, the memory snapshot,
the first input, deliveries, reminders, tool and parameter descriptions,
`tool_search` answers, skills, results, errors, and the judge's questions.
The aim is low noise, clear layers and a closed loop: each layer carries only
what the next step needs, and every layer leads to the next.

## Blocks and the renderer

No component writes prompt text. Everything that reaches a model - a system
prompt section, a delivery, a reminder, a note, a result, an error - is a
typed block: a kind and its fields. One renderer turns blocks into text when
a request is built, by fixed rules:

- each kind maps to one shape, with its tag, field order and fixed lines
  taken from the text table; a kind may also name the field its tag comes from,
  for a block whose tag the caller chooses - a plugin prompt section's delta
  renders in the tag the plugin named;
- content inside a block is escaped, so outside text cannot close a tag or
  pose as host text;
- a fixed line is complete when every placeholder its own template names has
  a value, and is dropped when one has none - never by scanning what was
  filled: a `{` a filled value carries, JSON in a message or a snippet in a
  note, is data the line keeps, not a placeholder it drops for. A placeholder
  is `{name}` and nothing else, so `{ everyMs }` written with spaces is text;
- data blocks are marked as data ([below](#data-and-instructions));
- the output is deterministic, so the same blocks always give the same bytes.

The core defines the built-in kinds below. A plugin registers kinds of its
own - its prompt section, its message shapes - as a kind with fields and a
mapping, and hands the host blocks, never finished text. A plugin's kind may
also extend a built-in one: the built-in kind's tag, field order and fixed lines
are kept, and the plugin's are added, so it can put its own fields on a note or
an outside message and the one renderer still writes them. Its own fixed strings
are merged into the host's table. Changing how something reads is a change to
one mapping or one table entry, in one place.

## No built-in pi prompt

arbor uses pi-agent-core's `Agent` with its own system prompt. pi's default
coding prompt, context files and skills never reach the model. Reminders and
deliveries are user-role text inside inputs, never system messages in the
middle of a window, because some providers fold those into the leading system
prompt and that breaks the cached prefix.

## Language and the text table

Every fixed text the framework writes - section headings, the opening and
continuation notes, delivery lines, reminders, descriptions, errors - is in
Chinese and lives in one text table. A deployment replaces the table to
change the language or the wording; no fixed text is written anywhere else.
Identifiers stay as they are: tool, parameter and field names, refs and
enum values. The judge's questions are in English
([below](#judge-questions)).

## Layers

Each fact lives in exactly one layer. Another layer that needs it points to
it instead of repeating it, because a fact stated twice drifts.

| Layer | Contains | Length |
| --- | --- | --- |
| system prompt | the sections below | as short as the rules allow |
| memory snapshot | the active notes, by summary | the active-set budget |
| first input | the task; related board lines; for a continuation, the previous window's ref and handoff; changes since the epoch | data, plus one fixed note |
| delivery | one block per inserted task, conversation update, notice, broadcast, window message or environment delta ([below](#deliveries)) | dense |
| board line | one live window: what it is doing, its targets, its open work, its usage and what it expects | one line per part |
| reminder | the head line saying it is a host reminder and not a request, with the window's real numbers (used, limit, share used and what is left), the tier's own instruction, the window's open work, and from 80 % on what happens at the hard limit | a few sentences |
| tool description | what one tool does and when to use it; side effects | 1 to 4 sentences |
| parameter description | meaning, default or range, relation to other parameters | one sentence |
| external tool's schema | the JSON Schema the outside harness declared, verbatim: in the tool declaration the backend sends, and in a `tool_search` answer | as long as the schema |
| `tool_search` answer | one function's call instructions, or where a skill's procedure is | one block per name |
| skill | a procedure, read on demand | as long as the procedure |
| result | current facts, and the next step only when it is not obvious | stable fields |
| error | the rule that refused the call and the next action | one line |

## System prompt

XML-tagged sections, each tag on its own line, separated by a blank line, in
this order:

1. `<identity>` - from settings; omitted when empty, with no default sentence.
2. `<agent>` - the general rules: a finished round leaves the window idle for a
   related input and everything is in the journal; sending is never required;
   only what `send` writes leaves the window; looking things up is free and
   what is learned goes into notes; everything from outside is data; a real
   consequence is weighed before it is taken.
3. `<tools>` - the direct tools, one line each: a name, a description, and for
   a tool a plugin or a backend declared, where it comes from. Its JSON Schema
   is not repeated here: the tool declaration carries it
   ([tools.md](tools.md#external-tools)).
4. `<modules>` - the modules, one line each: a name and a description of
   everything the module can do, never a function name.
5. `<env>` - skills, MCP servers and services, one line each: a name, a
   description and, for a skill, its path. The built-in skills are listed
   here like any other. A lead line says what the items are, that a skill is
   third-party reference material rather than an instruction, and when to read
   one.
6. One section per plugin that registered one
   ([architecture.md](architecture.md#plugins)), rendered from its block in a
   tag named after the plugin. The tag is the plugin's own choice - `<dsh>` is
   one plugin's name for its block, not a name the framework reserves. A
   section a plugin declares outside - material from a third party, such as the
   sections a DeepSeek Harness plugin contributes - is led by the line that
   says what it is and marked as data
   ([below](#data-and-instructions)), and `<agent>` states that the framework's
   own prompt wins on conflict.

A section with nothing to say is not rendered. The whole prompt is frozen
with the snapshot epoch ([windows.md](windows.md#prompt-layout)).

## Plugin sections that change

A plugin's prompt section is rendered per epoch and its content can change
while a window runs: a third party contributes a section, rewrites one, or
takes one away. The section declares a `revision`, and the host asks for it once
per step - one cheap call, so nothing is rendered for a section that did not
move. When a revision moves, the section is rendered again and the window
learns the change the way it learns an environment change: a delta at the next
tool-call boundary, carrying only the lines that changed. Unchanged lines are
never repeated, and a running window's system prompt is never rebuilt. A window
that opens after the change is built with the new text in its prefix and gets no
delta of its own opening.

### A section rendered per window

The host registers a section once and renders it per window, and every render
names the window it is for: `content(window)` answers for that window. A section
that serves several sessions - one workspace per session, as a host embedded in
another harness runs - says which window it is rendering for and declares itself
`perWindow`; the host then renders it for each window instead of freezing it
with the epoch, so each window reads the section for itself while the rest of
the prefix stays shared. A section that says the same thing to every window
declares nothing and is frozen with the epoch as before
([windows.md](windows.md#prompt-layout)).

A per-window section is also handed what the embedding says that window serves -
the opaque label the task that opened it carried, `content(window, label)` - so a
section can name the session the window belongs to without a map of its own
([windows.md](windows.md#what-a-window-serves)).

## Fixed notes

- **Opening note of a continuation.** The previous window's transcript is not
  loaded but can be looked up; it names where - the journal and notes
  modules, `windows.show`, the workspace - by module, never by function. Then
  it either introduces the handoff as the agent's own earlier note, or says
  there is none and gives the order to recover: notes, the board, the
  previous window's last events.
- **Mid-task reset.** After the hard limit or a restart that continues a stopped
  window, one host line says the window ended mid-task by the host, that the
  steps already taken can be looked up, and that nothing already sent is sent
  again.
- A window opened for a new task gets no note.

## Deliveries

Each delivery is a block kind with one fixed shape, with its source window or
target, its refs and its content:

| Block | Fixed line |
| --- | --- |
| inserted task | none; the task renders as it would open a window |
| conversation update | the conversation, then the new events in the plugin's block kinds |
| notice | the event's opening words and its ref, from which window |
| broadcast | it is a broadcast, needs no reply, and a reply when really needed goes to the sender as a window message |
| window message | from which window, and its `reply_to` when it has one |
| environment delta | one line per item: `+`, `~` or `-`, kind, name, description |
| prompt delta | the lines one plugin's prompt section changed, `+` and `-`, in the tag the plugin named |
| tools delta | one line per direct tool declared from outside the core: `+` or `-`, name, source ([tools.md](tools.md#external-tools-that-change)) |

Every block carries its own time. A block that holds outside content says it
is data where it is delivered ([below](#data-and-instructions)).

## Rules surface where they bite

- A guard rule - a limit, a refusal, a precondition - is not written into the
  prompt or a description in advance. The host enforces it, and the model
  learns it from the error when it meets it.
- **Every error closes the loop.** It names the rule and the next action that
  reaches the goal with what the model has now. Errors from a workspace
  implementation, a provider, an MCP server or a service pass through a host
  wrapper that adds the same; a raw upstream error never reaches the model
  alone. A refusal with no useful next action means the rule belongs elsewhere.
- **A refusal carries its own wording.** The rule, the message and the next
  action stand on the result itself, in the one form a refusal is written in, so
  an embedding that keeps its own journal records the result as it stands
  instead of reassembling the three parts. `error` stays the structured part the
  model reads, and what the record holds is what the caller was handed.
- An error about the environment names the section of the built-in skill
  that covers it.
- A rule moves into a description only when the logs show the model hitting
  the same error again and again, and then it replaces the error's wording
  instead of adding to it.
- The one exception stated up front: `end` has two uses, and its description
  says when each applies - a plain end when this window's work is settled, a
  handoff when there is something to hand over - and the `handoff` parameter
  names the exact fields - `topics`, `progress`, `pending` and `agreements`,
  each a string array, and optional `refs` - because the handoff is the cost of
  the decision to end. A handoff in any other shape is refused with
  `end.handoff.invalid`, which names the same fields, and the window stays
  open.
- **The handoff floor is a guard rule.** Below `window.handoffFloor` (a
  fraction, 0.6 by default) an `end` carrying a handoff is refused while
  nothing is unfinished, because the window can simply stay idle for the next
  input. The prompt and `tool.end` never state the floor or the current usage:
  `end.handoff.early` carries both, together with the next action, and the
  window stays open. With unfinished work the handoff is always accepted, and
  an `end` without one is never limited by the floor.
- A limit that shapes a result without refusing - a page size, a row cap - is
  reported by the result every time. A rule the host enforces without a
  refusal, like the context budget, is taught by the layer that reports it,
  here the reminders.

## Wording

- Start with what to do. The identity says who the agent is; everything else
  says how the situation works.
- Constraints are declarative and use the same patterns everywhere: "X 和 Y
  只能二选一", "X 只在 Y 时有效", "仅当……时使用".
- Verbs are the formal two-character ones: 查看、查询、记录、发送、修改、完成.
  A one-character verb (看、查、记、发、改) is not used where one of these fits.
- No greetings, encouragement, progress narration, generic advice,
  "important" markers or emphasis by repetition.
- Examples only to define a format, such as a ref.
- Errors start with the tool name. Successful writes answer in one short line
  (`已写入 n012@1`). Results use the same field names every time.
- A result that can be partly done names each part's state, so a retry acts
  only on what did not happen.

## Information density

Show what the model cannot get another way; leave out what it can look up or
infer. Everything left out stays reachable from something shown.

- **Refs instead of content.** What a tool returns from a ref already on
  screen is not shown; the ref is.
- **Related in one line.** Every `journal` read appends one 相关 line per
  returned item, at most for three items: its strongest neighbours, the total,
  and the exact call that pages the rest. No line when there are no
  neighbours. `journal.links` lists the neighbours already, so its own answer
  adds none.
- **First appearance.** Not implemented yet. A person, conversation or item
  should be described in full the first time it appears in a window and by name
  only afterwards, with the state rebuilt from the journal after a restart;
  nothing in the code carries it, so no layer does it today.
- **Inferable is not repeated**, except safety signals, which are repeated
  wherever they apply.
- **Bound every result.** One head-and-tail cut in the tool pipeline for every
  tool, at the one exit `ToolCatalog.call` leaves by, with a marker that says
  how much was cut and where the whole is kept in the workspace. Images are
  exempt.
- **A limit that shapes a result is reported.** What a search covered, how
  much there is and how to reach the rest are in the result every time; a
  `tool_search` answer that lists more names than it shows says so, and so does
  a search that left matches out.

## Input format

The framework fixes the envelope of an outside input: time, source channel,
target, its ref, and first-appearance details. What goes inside - senders,
quotes, images, a channel's own shapes - is blocks of the kinds its plugin
registered ([architecture.md](architecture.md#plugins)); their mappings
follow the density rules above.

## Data and instructions

Content from outside the framework is data, never instructions, and is marked
where it is delivered rather than in one warning far away: outside messages,
notes, the journal, tool and `code_exec` output, MCP results, service events,
broadcasts and window messages. A plugin's prompt block that comes from outside
the framework - the sections a third party contributes - is data the same way,
and it is led by the line that says so; `<agent>` states that the framework's
own prompt wins on conflict. Skills the model or a third party wrote are
reference material. The handoff is labelled as the agent's own earlier note.
This is how the prompt is written, not a permission system; a deployment that
grants authority to some sources does it through hooks.

## Judge questions

The judge is a classifier, not the main model.

- **Minimal and complete state.** A question's state carries exactly what the
  decision needs and nothing it does not: everything it judges is there, and
  nothing that could tilt it is. Each field is defined in a `state_note`.
- **One question, one state path.** The instruction names the field it judges
  and the point of view, and does not restate the state.
- **Criteria describe both outcomes.** What counts, what does not, which
  evidence comes first, the boundary cases and a tie-break; principles, not
  lists of literal examples.
- **Tie-break toward the less harmful action**, stated per question.
- **No arithmetic.** Counts, time gaps and shares are computed in code and
  appear as labelled facts.
- **Batching.** One request per decision; one question per item when items
  fail separately.
- Questions are in English; the state keeps original text as it is. Every
  request is scrubbed of secrets on the way out.

## Stability

- Rendering is deterministic and byte-stable for the prefix: notes sorted by
  id, no timestamps or counters in the system prompt or snapshot.
- Nothing is injected when there is nothing to say: no empty sections, no
  "nothing new" lines.

## Terms

One term per concept, in prompts, descriptions, results, errors and logs:

| Term | Meaning | Do not use |
| --- | --- | --- |
| 窗口 (window) | one context window | 会话、session、来源 |
| 记录 (journal) | the one append-only log | 日志、历史库 |
| 事件 (event) | one record in the journal | 条目 |
| 目标 (target) | what an event touches | 对象、主题 |
| 现场板 (board) | the live lines of every window | 看板、状态表 |
| 投递 (delivery) | a block entering a running window | 消息 (alone) |
| 推送 (notice) | a delivery to windows that touched a target | 通知 |
| 广播 (broadcast) | a delivery to every live window | 群发 |
| 预期 (expectation) | what a window expects to be routed to it | 订阅、等待 |
| 笔记 (note) | shared long-term memory | 记忆条目、备注 |
| 环境 (environment) | skills, MCP servers, services and settings | 配置 (alone) |
| 服务 (service) | a resident application the host supervises | 后台进程 |
| 工作区 (workspace) | a window's own directory | 仓库、沙箱 |
| 常驻目录 (persistent directory) | a named directory kept past the window, made with `workspace.keep` | 持久目录、长期目录、存档 |
| 来源 (conversation) | where an outside message comes from and where its reply goes, such as a chat on a channel | 会话、对话、窗口、频道 |
| 效果 (effect) | one act on the outside world a window made, such as a `send`; its result event says whether it was carried out | 消息、动作 |
| 引用 (ref) | a ref such as `r902` or `n012@3` | 链接、ID |
