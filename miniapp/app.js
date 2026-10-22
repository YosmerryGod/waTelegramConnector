
"use strict";

// [CONFIG] Ubah jika API berada di domain atau port berbeda.
const API_BASE = "/api/miniapp";

const tg = window.Telegram?.WebApp;

const state = {
  chats: [],
  activeFilter: "all",
  currentChat: null,
  currentMessages: [],
  searchQuery: "",
  me: null,
  busy: false
};

const $ = (selector) => document.querySelector(selector);

function escapeHTML(value = "") {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char]);
}

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.remove("hidden");

  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => {
    toast.classList.add("hidden");
  }, 2600);
}

function getChatId(chat) {
  return chat.chat_id ?? chat.whatsapp_chat_id ?? chat.id;
}

function getChatName(chat) {
  return chat.chat_name || chat.name || chat.phone_number || getChatId(chat) || "Chat";
}

function getLastMessage(chat) {
  return chat.last_message || chat.last_message_body || chat.lastMessage || "Belum ada pesan";
}

function formatTime(value) {
  if (!value) return "";
  let date;

  if (typeof value === "number") {
    date = new Date(value < 1e12 ? value * 1000 : value);
  } else {
    date = new Date(value);
  }

  if (Number.isNaN(date.getTime())) return "";

  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString("id-ID", {
      hour: "2-digit",
      minute: "2-digit"
    });
  }

  return date.toLocaleDateString("id-ID", {
    day: "2-digit",
    month: "short"
  });
}

function getInitials(name) {
  const parts = String(name || "W").trim().split(/\s+/);
  return parts.slice(0, 2).map((part) => part[0] || "").join("").toUpperCase();
}

function getUnread(chat) {
  return Number(chat.unread_count ?? chat.unreadCount ?? 0);
}

function isFavorite(chat) {
  return Boolean(chat.is_favorite ?? chat.isFavorite ?? chat.favorite);
}

function isArchived(chat) {
  return Boolean(chat.is_archived ?? chat.isArchived ?? chat.archived);
}

function isOutgoing(message) {
  return ["outgoing", "sent", "out"].includes(
    String(message.direction || "").toLowerCase()
  );
}

async function api(path, options = {}) {
  const initData = tg?.initData;

  // Jangan memakai initDataUnsafe sebagai autentikasi.
  if (!initData) {
    throw new Error(
      "Mini App harus dibuka dari Telegram agar data autentikasi tersedia."
    );
  }

  const headers = {
    "Content-Type": "application/json",
    "X-Telegram-Init-Data": initData,
    ...(options.headers || {})
  };

  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.error || data.message || `HTTP ${response.status}`);
  }

  return data;
}

function extractList(data, keys) {
  if (Array.isArray(data)) return data;

  for (const key of keys) {
    if (Array.isArray(data?.[key])) return data[key];
  }

  return [];
}

function renderChats() {
  const list = $("#chatList");
  const query = state.searchQuery.toLowerCase().trim();

  let chats = state.chats.filter((chat) => {
    const name = getChatName(chat).toLowerCase();
    const preview = getLastMessage(chat).toLowerCase();

    if (query && !name.includes(query) && !preview.includes(query)) {
      return false;
    }

    switch (state.activeFilter) {
      case "unread":
        return getUnread(chat) > 0;
      case "favorites":
        return isFavorite(chat);
      case "archived":
        return isArchived(chat);
      default:
        return !isArchived(chat);
    }
  });

  $("#chatCount").textContent = `${chats.length} chat`;
  $("#listTitle").textContent = ({
    all: "Percakapan",
    unread: "Belum dibaca",
    favorites: "Favorit",
    archived: "Arsip"
  })[state.activeFilter];

  if (!chats.length) {
    list.innerHTML = `
      <div class="empty-state">
        <div style="font-size:28px;margin-bottom:8px">▤</div>
        Tidak ada percakapan ditemukan.
      </div>`;
    return;
  }

  list.innerHTML = chats.map((chat) => {
    const id = getChatId(chat);
    const name = getChatName(chat);
    const last = getLastMessage(chat);
    const timestamp = chat.last_message_at ||
      chat.last_message_timestamp ||
      chat.updated_at ||
      chat.timestamp;

    return `
      <article class="chat-item" data-chat-id="${escapeHTML(id)}">
        <div class="avatar">${escapeHTML(getInitials(name))}</div>
        <div class="chat-details">
          <div class="chat-top">
            <span class="chat-name">${escapeHTML(name)}</span>
            <span class="chat-time">${escapeHTML(formatTime(timestamp))}</span>
          </div>
          <div class="chat-bottom">
            <span class="chat-preview">${escapeHTML(last)}</span>
            <span class="chat-tags">
              ${isFavorite(chat) ? '<span class="tag">★</span>' : ""}
              ${chat.chat_type === "group" ? '<span class="tag">Grup</span>' : ""}
              ${getUnread(chat) > 0
                ? `<span class="unread-dot">${escapeHTML(getUnread(chat))}</span>`
                : ""}
            </span>
          </div>
        </div>
      </article>`;
  }).join("");

  list.querySelectorAll("[data-chat-id]").forEach((element) => {
    element.addEventListener("click", () => {
      openChat(element.dataset.chatId);
    });
  });
}

async function loadChats() {
  $("#chatList").innerHTML = '<div class="loading">Memuat percakapan...</div>';

  try {
    const data = await api("/chats");
    state.chats = extractList(data, ["chats", "items", "results"]);
    $("#connectionStatus").textContent = "Terhubung ke akun";
    renderChats();
  } catch (error) {
    $("#connectionStatus").textContent = "Gagal terhubung";
    $("#chatList").innerHTML = `
      <div class="error-state">
        <div>${escapeHTML(error.message)}</div>
        <button id="retryButton">Coba lagi</button>
      </div>`;
    $("#retryButton").addEventListener("click", loadChats);
  }
}

async function openChat(chatId) {
  const chat = state.chats.find((item) => String(getChatId(item)) === String(chatId));

  if (!chat) {
    showToast("Data chat tidak ditemukan.");
    return;
  }

  state.currentChat = chat;
  state.currentMessages = [];

  $("#chatPage").classList.add("hidden");
  $("#conversationPage").classList.remove("hidden");

  const name = getChatName(chat);
  $("#conversationName").textContent = name;
  $("#conversationSubtitle").textContent =
    chat.chat_type === "group" ? "Grup WhatsApp" : "Percakapan WhatsApp";
  $("#conversationAvatar").textContent = getInitials(name);
  $("#favoriteButton").textContent = isFavorite(chat) ? "★" : "☆";
  $("#messageList").innerHTML = '<div class="loading">Memuat pesan...</div>';

  try {
    // [API] ID diencode untuk aman sebagai bagian URL.
    const id = encodeURIComponent(chatId);
    const data = await api(`/chats/${id}/messages`);
    state.currentMessages = extractList(data, ["messages", "items", "results"]);
    renderMessages();

    // [IMPORTANT] Endpoint ini hanya mengubah status lokal di database.
    await api(`/chats/${id}/read`, {
      method: "POST",
      body: JSON.stringify({})
    }).catch(() => {});

    chat.unread_count = 0;
    renderChats();
  } catch (error) {
    $("#messageList").innerHTML = `
      <div class="error-state">${escapeHTML(error.message)}</div>`;
  }
}

function renderMessages() {
  const list = $("#messageList");
  const messages = state.currentMessages;

  if (!messages.length) {
    list.innerHTML = '<div class="empty-state">Belum ada pesan tersimpan.</div>';
    return;
  }

  list.innerHTML = messages.map((message) => {
    const outgoing = isOutgoing(message);
    const body = message.body ||
      message.text ||
      message.message_body ||
      (message.message_type ? `[${message.message_type}]` : "[Pesan]");

    const timestamp = message.message_timestamp ||
      message.timestamp ||
      message.created_at;

    return `
      <div class="message ${outgoing ? "outgoing" : ""}">
        ${!outgoing && message.sender_name
          ? `<div style="font-size:10px;color:var(--green);margin-bottom:4px">${escapeHTML(message.sender_name)}</div>`
          : ""}
        <div>${escapeHTML(body)}</div>
        <div class="message-meta">${escapeHTML(formatTime(timestamp))}</div>
      </div>`;
  }).join("");

  list.scrollTop = list.scrollHeight;
}

function showChatList() {
  $("#conversationPage").classList.add("hidden");
  $("#chatPage").classList.remove("hidden");
  state.currentChat = null;
}

async function toggleFavorite() {
  const chat = state.currentChat;
  if (!chat) return;

  const id = encodeURIComponent(getChatId(chat));
  const next = !isFavorite(chat);

  try {
    await api(`/chats/${id}/favorite`, {
      method: "PUT",
      body: JSON.stringify({ favorite: next })
    });

    chat.is_favorite = next;
    $("#favoriteButton").textContent = next ? "★" : "☆";
    renderChats();
    showToast(next ? "Ditambahkan ke favorit" : "Dihapus dari favorit");
  } catch (error) {
    showToast(error.message);
  }
}

function setupEvents() {
  $("#refreshButton").addEventListener("click", loadChats);
  $("#backButton").addEventListener("click", showChatList);
  $("#favoriteButton").addEventListener("click", toggleFavorite);
  $("#searchInput").addEventListener("input", (event) => {
    state.searchQuery = event.target.value;
    renderChats();
  });

  document.querySelectorAll(".filter").forEach((button) => {
    button.addEventListener("click", () => {
      state.activeFilter = button.dataset.filter;

      document.querySelectorAll(".filter").forEach((item) => {
        item.classList.toggle("active", item === button);
      });

      renderChats();
    });
  });

  $("#chatsNav").addEventListener("click", () => {
    showChatList();
    $("#chatsNav").classList.add("selected");
    $("#profileNav").classList.remove("selected");
  });

  $("#profileNav").addEventListener("click", () => {
    const user = state.me;
    showToast(user?.first_name
      ? `Akun Telegram: ${user.first_name}`
      : "Akun terhubung melalui Telegram.");
  });
}

async function init() {
  if (tg) {
    tg.ready();
    tg.expand();

    // Menyesuaikan warna Telegram dengan tampilan aplikasi.
    try {
      tg.setHeaderColor("#101114");
      tg.setBackgroundColor("#101114");
    } catch {
      // Beberapa versi Telegram mungkin tidak mendukung pengaturan ini.
    }
  }

  setupEvents();

  try {
    const data = await api("/me");
    state.me = data.user || data;
  } catch {
    // loadChats akan menampilkan pesan autentikasi/API jika gagal.
  }

  await loadChats();
}

document.addEventListener("DOMContentLoaded", init);
