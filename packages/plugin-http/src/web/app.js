/**
 * The page the HTTP test channel serves: pick or create a conversation, send a
 * message, watch replies arrive, and read the board.
 *
 * Plain JavaScript, no build step. Every string that came from outside is set
 * with `textContent`, so message text can never become markup. The page polls,
 * because a test tool does not need a socket.
 */

"use strict";

const POLL_MS = 1200;

/** What the page holds between polls. */
const state = {
  channel: "http",
  online: false,
  address: "",
  conversations: [],
  board: [],
  messages: [],
  selected: null,
  /** Conversations the page made that the channel has no message for yet. */
  created: [],
};

const elements = {
  status: document.getElementById("status"),
  conversationList: document.getElementById("conversation-list"),
  newConversation: document.getElementById("new-conversation"),
  newConversationName: document.getElementById("new-conversation-name"),
  conversationTitle: document.getElementById("conversation-title"),
  messages: document.getElementById("messages"),
  chatEmpty: document.getElementById("chat-empty"),
  composer: document.getElementById("composer"),
  text: document.getElementById("text"),
  send: document.getElementById("send"),
  boardBody: document.getElementById("board-body"),
  boardEmpty: document.getElementById("board-empty"),
};

/** One GET against the channel's own reads. */
async function get(path) {
  const response = await fetch(path, { headers: { accept: "application/json" } });
  return response.json();
}

/** The conversation name without the channel prefix, for display. */
function nameOf(target) {
  const prefix = `${state.channel}:`;
  return target.startsWith(prefix) ? target.slice(prefix.length) : target;
}

function renderStatus() {
  elements.status.textContent = state.online
    ? `${state.channel} 在线 · ${state.address}`
    : `${state.channel} 离线`;
}

function renderConversations() {
  const known = new Set(state.conversations.map((one) => one.target));
  const every = [...state.conversations, ...state.created.filter((target) => !known.has(target)).map((target) => ({ target, messages: 0 }))];
  elements.conversationList.replaceChildren(
    ...every.map((one) => {
      const item = document.createElement("li");
      item.setAttribute("role", "button");
      item.setAttribute("aria-current", String(one.target === state.selected));
      const label = document.createElement("span");
      label.textContent = nameOf(one.target);
      const count = document.createElement("span");
      count.className = "count";
      count.textContent = String(one.messages);
      item.append(label, count);
      item.addEventListener("click", () => {
        state.selected = one.target;
        void refreshMessages();
      });
      return item;
    }),
  );
}

function renderMessages() {
  const title = state.selected === null ? "选择一个会话" : `会话 ${nameOf(state.selected)}`;
  elements.conversationTitle.textContent = title;
  const shown = state.selected === null ? [] : state.messages.filter((one) => one.conversation === state.selected);
  elements.chatEmpty.hidden = shown.length > 0;
  elements.messages.replaceChildren(
    ...shown.map((message) => {
      const item = document.createElement("li");
      item.className = `message ${message.direction}`;
      const head = document.createElement("header");
      const who = document.createElement("span");
      who.textContent = message.direction === "out" ? "arbor" : message.from;
      const when = document.createElement("time");
      when.textContent = new Date(message.time).toLocaleTimeString();
      head.append(who, when);
      const body = document.createElement("div");
      body.textContent = message.text;
      item.append(head, body);
      return item;
    }),
  );
}

function renderBoard() {
  elements.boardEmpty.hidden = state.board.length > 0;
  elements.boardBody.replaceChildren(
    ...state.board.map((line) => {
      const row = document.createElement("tr");
      const cells = [
        line.window,
        line.state,
        line.doing,
        `${line.usage.used}/${line.usage.limit}`,
      ];
      for (const [index, value] of cells.entries()) {
        const cell = document.createElement("td");
        if (index === 2) cell.className = "doing";
        cell.textContent = value;
        row.append(cell);
      }
      return row;
    }),
  );
}

/** One poll: the state, then the selected conversation's messages. */
async function refresh() {
  let next;
  try {
    next = await get("/api/state");
  } catch {
    state.online = false;
    renderStatus();
    return;
  }
  state.channel = next.channel;
  state.online = next.online;
  state.address = next.address;
  state.conversations = next.conversations;
  state.board = next.board;
  // A conversation the page made stays selected until the channel has a message
  // for it, so a new conversation does not disappear on the next poll.
  if (state.selected === null && state.conversations.length > 0) {
    state.selected = state.conversations[0].target;
  }
  renderStatus();
  renderConversations();
  renderBoard();
  await refreshMessages();
}

async function refreshMessages() {
  if (state.selected === null) {
    state.messages = [];
    renderMessages();
    renderConversations();
    return;
  }
  const page = await get(`/api/messages?conversation=${encodeURIComponent(state.selected)}`);
  state.messages = page.items;
  renderMessages();
  renderConversations();
}

elements.newConversation.addEventListener("submit", (event) => {
  event.preventDefault();
  const name = elements.newConversationName.value.trim();
  if (name === "") return;
  const target = `${state.channel}:${name}`;
  if (!state.created.includes(target)) state.created.push(target);
  state.selected = target;
  elements.newConversationName.value = "";
  void refreshMessages();
});

elements.composer.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = elements.text.value.trim();
  if (text === "" || state.selected === null) return;
  elements.send.disabled = true;
  try {
    await fetch("/webhook", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ conversation: nameOf(state.selected), text }),
    });
    elements.text.value = "";
    await refresh();
  } finally {
    elements.send.disabled = false;
  }
});

void refresh();
setInterval(() => void refresh(), POLL_MS);
