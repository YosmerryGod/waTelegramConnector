/* =========================================================
   DOOD BOT Mini App
   Halaman: Chat, Panggilan, Kontak, Akun

   Alamat API default: /api/miniapp (satu domain dengan server).
   Jika Mini App di-host di domain lain, set sebelum app.js dimuat:
     <script>window.MINIAPP_API_BASE = "https://domain-kamu.com/api/miniapp";</script>
   ========================================================= */

(() => {
  "use strict";

  const tg = window.Telegram?.WebApp || null;

  const API_BASE = String(
    window.MINIAPP_API_BASE || "/api/miniapp"
  ).replace(/\/+$/, "");

  const $ = (selector, root = document) => root.querySelector(selector);

  const state = {
    page: "chats",
    me: null,

    chats: [],
    chatsLoaded: false,
    filter: "all",
    search: "",
    messageHits: [],
    currentChat: null,

    calls: [],
    callsLoaded: false,
    callsStale: false,
    callFilter: "all",
    callSearch: "",

    contacts: [],
    contactsLoaded: false,
    contactSearch: "",
    editingId: null
  };

  const PAGES = {
    chats: "#chatPage",
    calls: "#callsPage",
    contacts: "#contactsPage",
    account: "#accountPage"
  };

  const NAVS = {
    chats: "#chatsNav",
    calls: "#callsNav",
    contacts: "#contactsNav",
    account: "#profileNav"
  };

  const FILTER_TITLES = {
    all: "Percakapan",
    unread: "Belum dibaca",
    favorites: "Favorit",
    archived: "Arsip"
  };

  const MEDIA_LABELS = {
    image: "Foto",
    video: "Video",
    audio: "Audio",
    ptt: "Pesan suara",
    document: "Dokumen",
    sticker: "Stiker",
    location: "Lokasi",
    contact: "Kontak",
    poll: "Polling",
    call: "Panggilan"
  };

  const ERROR_TEXT = {
    INVALID_TELEGRAM_AUTH: "Buka aplikasi ini dari dalam Telegram.",
    USER_NOT_REGISTERED: "Kirim /start ke bot Telegram terlebih dahulu.",
    INVALID_NAME: "Nama kontak wajib diisi.",
    INVALID_PHONE: "Nomor HP tidak valid. Periksa kembali nomornya.",
    DUPLICATE_PHONE: "Nomor ini sudah tersimpan sebagai kontak lain.",
    CONTACT_LIMIT: "Batas jumlah kontak sudah tercapai.",
    CONTACT_NOT_FOUND: "Kontak tidak ditemukan.",
    CHAT_NOT_FOUND: "Chat tidak ditemukan."
  };

  /* ---------------------------------------------------------
     Utilitas
     --------------------------------------------------------- */

  function escapeHTML(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  const enc = encodeURIComponent;

  function icon(name, extraClass = "") {
    return `<svg class="i ${extraClass}"><use href="#i-${name}"/></svg>`;
  }

  function getInitials(name) {
    const words = String(name || "")
      .replace(/^\+/, "")
      .trim()
      .split(/\s+/)
      .filter(Boolean);

    if (!words.length) return "?";

    if (/^\d/.test(words[0])) return "#";

    const first = [...words[0]][0] || "?";
    const second = words.length > 1 ? [...words[1]][0] : "";

    return (first + second).toUpperCase();
  }

  function avatarHue(seed) {
    let hash = 0;

    for (const char of String(seed || "")) {
      hash = (hash * 31 + char.codePointAt(0)) % 360;
    }

    return hash;
  }

  function avatar(name, seed, extraClass = "") {
    return `<div class="avatar ${extraClass}" style="--h:${avatarHue(seed || name)}">${escapeHTML(getInitials(name))}</div>`;
  }

  // Timestamp bisa detik (WhatsApp) atau milidetik.
  function toMs(value) {
    const number = Number(value);

    if (!Number.isFinite(number) || number <= 0) return 0;

    return number < 1e12 ? number * 1000 : number;
  }

  function startOfDay(ms) {
    const date = new Date(ms);

    return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  }

  function timeOnly(ms) {
    return new Date(ms).toLocaleTimeString("id-ID", {
      hour: "2-digit",
      minute: "2-digit"
    });
  }

  function shortDate(ms) {
    const sameYear = new Date(ms).getFullYear() === new Date().getFullYear();

    return new Date(ms).toLocaleDateString("id-ID", {
      day: "numeric",
      month: "short",
      ...(sameYear ? {} : { year: "numeric" })
    });
  }

  // Waktu di daftar chat: jam / Kemarin / tanggal.
  function formatListTime(value) {
    const ms = toMs(value);

    if (!ms) return "";

    const today = startOfDay(Date.now());

    if (ms >= today) return timeOnly(ms);
    if (ms >= today - 864e5) return "Kemarin";

    return shortDate(ms);
  }

  function dayLabel(ms) {
    const today = startOfDay(Date.now());

    if (ms >= today) return "Hari ini";
    if (ms >= today - 864e5) return "Kemarin";

    return new Date(ms).toLocaleDateString("id-ID", {
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric"
    });
  }

  function formatPhone(phone) {
    const digits = String(phone || "").replace(/\D/g, "");

    return digits ? `+${digits}` : "";
  }

  let toastTimer = 0;

  function showToast(message) {
    const toast = $("#toast");

    if (!toast) return;

    toast.textContent = message;
    toast.classList.remove("hidden");

    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.add("hidden"), 2800);
  }

  function confirmAction(message) {
    return new Promise((resolve) => {
      if (tg?.showConfirm) {
        tg.showConfirm(message, (ok) => resolve(Boolean(ok)));
      } else {
        resolve(window.confirm(message));
      }
    });
  }

  function openWhatsApp(phone) {
    const digits = String(phone || "").replace(/\D/g, "");

    if (!digits) return;

    const url = `https://wa.me/${digits}`;

    if (tg?.openLink) {
      tg.openLink(url);
    } else {
      window.open(url, "_blank", "noopener");
    }
  }

  function haptic(type) {
    try {
      tg?.HapticFeedback?.notificationOccurred(type);
    } catch {
      /* tidak penting */
    }
  }

  function emptyState(iconName, title, text, actionHTML = "") {
    return `
      <div class="empty">
        <div class="empty-icon">${icon(iconName)}</div>
        <h3>${escapeHTML(title)}</h3>
        <p>${escapeHTML(text)}</p>
        ${actionHTML}
      </div>`;
  }

  function errorState(message, retryId) {
    return `
      <div class="error-state">
        <div>${escapeHTML(message)}</div>
        <button id="${retryId}" class="secondary-button" type="button">Coba lagi</button>
      </div>`;
  }

  /* ---------------------------------------------------------
     API
     --------------------------------------------------------- */

  async function api(path, options = {}) {
    const headers = {
      "X-Telegram-Init-Data": tg?.initData || "",
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers
    };

    let response;

    try {
      response = await fetch(API_BASE + path, { ...options, headers });
    } catch {
      throw new Error("Tidak dapat terhubung ke server.");
    }

    let data = null;

    try {
      data = await response.json();
    } catch {
      /* respons bukan JSON */
    }

    if (!response.ok || data?.ok === false) {
      throw new Error(
        ERROR_TEXT[data?.error] ||
        data?.message ||
        `Permintaan gagal (${response.status}).`
      );
    }

    return data;
  }

  /* ---------------------------------------------------------
     Navigasi
     --------------------------------------------------------- */

  function closeConversationUI() {
    $("#conversationPage").classList.add("hidden");
    $("#topbar").classList.remove("hidden");
    document.body.classList.remove("in-chat");
    state.currentChat = null;

    try {
      tg?.BackButton?.hide();
    } catch {
      /* tidak penting */
    }
  }

  function setPage(page) {
    state.page = page;
    closeConversationUI();

    for (const [key, selector] of Object.entries(PAGES)) {
      $(selector).classList.toggle("hidden", key !== page);
    }

    for (const [key, selector] of Object.entries(NAVS)) {
      const nav = $(selector);

      nav.classList.toggle("selected", key === page);

      if (key === page) {
        nav.setAttribute("aria-current", "page");
      } else {
        nav.removeAttribute("aria-current");
      }
    }

    if (page === "calls" && (!state.callsLoaded || state.callsStale)) {
      loadCalls();
    }

    if (page === "contacts" && !state.contactsLoaded) {
      loadContacts();
    }

    if (page === "account") {
      renderAccount();
    }

    window.scrollTo(0, 0);
  }

  function refreshCurrentPage() {
    if (state.page === "chats") return loadChats();
    if (state.page === "calls") return loadCalls();
    if (state.page === "contacts") return loadContacts();

    return loadMe();
  }

  /* ---------------------------------------------------------
     Akun
     --------------------------------------------------------- */

  async function loadMe() {
    try {
      const data = await api("/me");

      state.me = data.user;

      const name = state.me.firstName || state.me.username || "pengguna";

      $("#connectionStatus").textContent = `Terhubung sebagai ${name}`;
      renderAccount();
    } catch (error) {
      $("#connectionStatus").textContent = error.message;
    }
  }

  function renderAccount() {
    const me = state.me;

    if (!me) return;

    const fullName = [me.firstName, me.lastName].filter(Boolean).join(" ");
    const name = fullName || me.username || "Pengguna Telegram";

    $("#accountName").textContent = name;
    $("#accountUsername").textContent = me.username ? `@${me.username}` : `ID ${me.id}`;

    const accountAvatar = $("#accountAvatar");

    accountAvatar.textContent = getInitials(name);
    accountAvatar.style.setProperty("--h", avatarHue(name));
  }

  /* ---------------------------------------------------------
     Chat
     --------------------------------------------------------- */

  async function loadChats() {
    const list = $("#chatList");

    if (!state.chatsLoaded) {
      list.innerHTML = '<div class="loading">Memuat percakapan…</div>';
    }

    try {
      const archived = state.filter === "archived";
      const data = await api(`/chats?limit=100&archived=${archived}`);

      state.chats = data.chats || [];
      state.chatsLoaded = true;
      renderChats();
    } catch (error) {
      state.chatsLoaded = false;
      list.innerHTML = errorState(error.message, "retryChats");
      $("#retryChats")?.addEventListener("click", loadChats);
    }
  }

  function chatName(chat) {
    return chat.display_name || chat.name || formatPhone(chat.phone_number) || chat.whatsapp_chat_id;
  }

  function renderChats() {
    const list = $("#chatList");
    const query = state.search.trim().toLowerCase();

    let items = state.chats.filter((chat) => {
      if (state.filter === "unread" && !(chat.unread_count > 0)) return false;
      if (state.filter === "favorites" && !chat.is_favorite) return false;

      if (!query) return true;

      return [chatName(chat), chat.phone_number, chat.last_message_preview]
        .join(" ")
        .toLowerCase()
        .includes(query);
    });

    $("#listTitle").textContent = FILTER_TITLES[state.filter] || "Percakapan";
    $("#chatCount").textContent = `${items.length} chat`;

    const hits = query.length >= 2 ? state.messageHits : [];

    if (!items.length && !hits.length) {
      list.innerHTML = query
        ? emptyState("search", "Tidak ada hasil", "Coba kata kunci lain.")
        : emptyState(
            "chat",
            "Belum ada percakapan",
            state.filter === "all"
              ? "Pesan WhatsApp yang masuk akan muncul di sini."
              : "Tidak ada chat pada filter ini."
          );
      return;
    }

    const chatRows = items.map((chat) => {
      const name = chatName(chat);
      const unread = Number(chat.unread_count) || 0;
      const isGroup = chat.chat_type === "group";

      return `
        <button class="list-item" type="button" data-chat="${escapeHTML(chat.whatsapp_chat_id)}">
          ${avatar(name)}
          <div class="item-body">
            <div class="item-row">
              <span class="item-title">${escapeHTML(name)}</span>
              <span class="item-time ${unread ? "is-unread" : ""}">${escapeHTML(formatListTime(chat.last_message_at))}</span>
            </div>
            <div class="item-row">
              <span class="item-sub">${escapeHTML(chat.last_message_preview || (isGroup ? "Grup" : "Belum ada pesan"))}</span>
              ${chat.is_favorite || unread
                ? `<span class="item-flags">${chat.is_favorite ? icon("star", "mini-icon fav") : ""}${unread ? `<span class="badge">${unread > 99 ? "99+" : unread}</span>` : ""}</span>`
                : ""}
            </div>
          </div>
        </button>`;
    }).join("");

    const hitRows = hits.length
      ? `<div class="sub-heading">Pesan</div>` + hits.map((hit) => {
          const name = hit.chat_name || hit.sender_name || "Chat";

          return `
            <button class="list-item" type="button" data-chat="${escapeHTML(hit.whatsapp_chat_id)}">
              ${avatar(name, name, "small")}
              <div class="item-body">
                <div class="item-row">
                  <span class="item-title">${escapeHTML(name)}</span>
                  <span class="item-time">${escapeHTML(formatListTime(hit.message_timestamp))}</span>
                </div>
                <div class="item-row">
                  <span class="item-sub">${escapeHTML(hit.body || "")}</span>
                </div>
              </div>
            </button>`;
        }).join("")
      : "";

    list.innerHTML = chatRows + hitRows;
  }

  let searchTimer = 0;
  let searchSeq = 0;

  function onChatSearch(event) {
    state.search = event.target.value;

    const query = state.search.trim();

    clearTimeout(searchTimer);

    if (query.length < 2) {
      state.messageHits = [];
      renderChats();
      return;
    }

    renderChats();

    searchTimer = setTimeout(async () => {
      const seq = ++searchSeq;

      try {
        const data = await api(`/search?q=${enc(query)}`);

        if (seq !== searchSeq) return;

        state.messageHits = data.messages || [];
        renderChats();
      } catch {
        /* pencarian pesan bersifat tambahan */
      }
    }, 350);
  }

  function mediaLabel(message) {
    const label = MEDIA_LABELS[message.message_type] || `[${message.message_type || "pesan"}]`;

    return message.media_file_name ? `${label} · ${message.media_file_name}` : label;
  }

  async function openChat(chatId) {
    clearMediaCache();

    const known = state.chats.find((chat) => chat.whatsapp_chat_id === chatId);

    state.currentChat = known || { whatsapp_chat_id: chatId };

    $(PAGES.chats).classList.add("hidden");
    $("#conversationPage").classList.remove("hidden");
    $("#topbar").classList.add("hidden");
    document.body.classList.add("in-chat");

    try {
      tg?.BackButton?.show();
    } catch {
      /* tidak penting */
    }

    updateConversationHeader();

    const messageList = $("#messageList");

    messageList.innerHTML = '<div class="loading">Memuat pesan…</div>';

    try {
      const data = await api(`/chats/${enc(chatId)}/messages?limit=200`);

      if (state.currentChat?.whatsapp_chat_id !== chatId) return;

      state.currentChat = { ...state.currentChat, ...data.chat };
      updateConversationHeader();
      renderMessages(data.messages || []);

      // Status baca hanya lokal; tidak mengirim read receipt ke WhatsApp.
      api(`/chats/${enc(chatId)}/read`, { method: "POST" }).catch(() => {});

      if (known) {
        known.unread_count = 0;
      }
    } catch (error) {
      messageList.innerHTML = errorState(error.message, "retryMessages");
      $("#retryMessages")?.addEventListener("click", () => openChat(chatId));
    }
  }

  function updateConversationHeader() {
    const chat = state.currentChat;

    if (!chat) return;

    const name = chatName(chat);
    const isGroup = chat.chat_type === "group";

    $("#conversationName").textContent = name;
    $("#conversationSubtitle").textContent = isGroup
      ? "Grup"
      : formatPhone(chat.phone_number) || "Chat pribadi";

    const conversationAvatar = $("#conversationAvatar");

    conversationAvatar.textContent = getInitials(name);
    conversationAvatar.style.setProperty("--h", avatarHue(name));

    $("#favoriteButton").classList.toggle("is-on", Boolean(chat.is_favorite));
    $("#archiveButton").classList.toggle("is-on", Boolean(chat.is_archived));
    $("#archiveButton").setAttribute(
      "aria-label",
      chat.is_archived ? "Keluarkan dari arsip" : "Arsipkan"
    );
  }

  /* ---------------------------------------------------------
     Foto & video
     --------------------------------------------------------- */

  const MEDIA_ERRORS = {
    MEDIA_TOO_LARGE: "File terlalu besar untuk ditampilkan di sini (lebih dari 20 MB).",
    MEDIA_NOT_FOUND: "File tidak ditemukan.",
    MEDIA_UNAVAILABLE: "File tidak dapat dimuat saat ini."
  };

  const mediaCache = new Map();
  let mediaObserver = null;
  let nearBottom = true;

  function clearMediaCache() {
    mediaObserver?.disconnect();
    mediaObserver = null;

    for (const url of mediaCache.values()) {
      URL.revokeObjectURL(url);
    }

    mediaCache.clear();
  }

  // Berkas diminta dengan header autentikasi lalu dijadikan blob lokal.
  async function fetchMediaURL(messageId) {
    const key = String(messageId);

    if (mediaCache.has(key)) return mediaCache.get(key);

    let response;

    try {
      response = await fetch(`${API_BASE}/messages/${enc(key)}/media`, {
        headers: { "X-Telegram-Init-Data": tg?.initData || "" }
      });
    } catch {
      throw new Error("Tidak dapat terhubung ke server.");
    }

    if (!response.ok) {
      let code = "";

      try {
        code = (await response.json()).error;
      } catch {
        /* respons bukan JSON */
      }

      throw new Error(MEDIA_ERRORS[code] || MEDIA_ERRORS.MEDIA_UNAVAILABLE);
    }

    const url = URL.createObjectURL(await response.blob());

    mediaCache.set(key, url);

    return url;
  }

  function mediaHTML(message) {
    const kind = message.media_kind;
    const isImage =
      kind === "photo" ||
      kind === "sticker" ||
      (kind === "document" && /^image\//.test(message.media_mimetype || ""));

    if (isImage) {
      return `<div class="media ${kind === "sticker" ? "sticker" : ""}"><img class="media-img is-loading" alt="${kind === "sticker" ? "Stiker" : "Foto"}" data-media-img="${escapeHTML(message.id)}"></div>`;
    }

    if (kind === "video" || kind === "animation") {
      const isGif = kind === "animation";

      return `<button class="media video-card" type="button" data-media-video="${escapeHTML(message.id)}" data-gif="${isGif ? 1 : 0}">${icon("play")}<span>${isGif ? "GIF" : "Putar video"}</span></button>`;
    }

    return "";
  }

  function keepBottom() {
    const list = $("#messageList");

    if (nearBottom) list.scrollTop = list.scrollHeight;
  }

  async function loadImage(img) {
    try {
      const url = await fetchMediaURL(img.dataset.mediaImg);

      img.addEventListener("load", keepBottom, { once: true });
      img.src = url;
      img.classList.remove("is-loading");
    } catch (error) {
      img.closest(".media")?.replaceWith(
        Object.assign(document.createElement("div"), {
          className: "media media-error",
          textContent: error.message
        })
      );
    }
  }

  // Foto dimuat saat mendekati layar supaya hemat data.
  function observeMedia(root) {
    mediaObserver?.disconnect();

    const images = root.querySelectorAll("[data-media-img]");

    if (!("IntersectionObserver" in window)) {
      images.forEach(loadImage);
      return;
    }

    mediaObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;

        mediaObserver.unobserve(entry.target);
        loadImage(entry.target);
      }
    }, { root, rootMargin: "300px" });

    images.forEach((img) => mediaObserver.observe(img));
  }

  async function playVideo(button) {
    if (button.dataset.busy) return;

    button.dataset.busy = "1";

    const label = button.querySelector("span");
    const original = label.textContent;

    label.textContent = "Memuat…";

    try {
      const url = await fetchMediaURL(button.dataset.mediaVideo);
      const isGif = button.dataset.gif === "1";
      const video = document.createElement("video");

      video.className = "media-video";
      video.src = url;
      video.controls = !isGif;
      video.playsInline = true;
      video.autoplay = true;
      video.loop = isGif;
      video.muted = isGif;
      video.addEventListener("loadedmetadata", keepBottom, { once: true });

      button.replaceWith(video);
      video.play?.().catch(() => {});
    } catch (error) {
      label.textContent = original;
      delete button.dataset.busy;
      showToast(error.message);
    }
  }

  function openLightbox(src) {
    $("#lightboxImage").src = src;
    $("#lightbox").classList.remove("hidden");
    document.body.style.overflow = "hidden";

    try {
      tg?.BackButton?.show();
    } catch {
      /* tidak penting */
    }
  }

  function closeLightbox() {
    $("#lightbox").classList.add("hidden");
    $("#lightboxImage").removeAttribute("src");
    document.body.style.overflow = "";
  }

  function renderMessages(messages) {
    const list = $("#messageList");

    if (!messages.length) {
      list.innerHTML = emptyState("chat", "Belum ada pesan", "Riwayat pesan akan muncul di sini.");
      return;
    }

    const isGroup = state.currentChat?.chat_type === "group";
    let lastDay = "";

    list.innerHTML = messages.map((message) => {
      const ms = toMs(message.message_timestamp);
      const day = ms ? startOfDay(ms) : 0;
      const outgoing = message.direction === "outgoing";

      let separator = "";

      if (day && String(day) !== lastDay) {
        lastDay = String(day);
        separator = `<div class="day-label">${escapeHTML(dayLabel(ms))}</div>`;
      }

      // Nama dari Kontak diutamakan dibanding nama profil WhatsApp.
      const senderName = message.contact_name || message.sender_name;

      const sender = isGroup && !outgoing && senderName
        ? `<div class="message-sender">${escapeHTML(senderName)}</div>`
        : "";

      const media = message.has_media ? mediaHTML(message) : "";

      const body = message.body
        ? `<div class="message-text">${escapeHTML(message.body)}</div>`
        : media
          ? ""
          : `<div class="message-text"><span class="message-media">${escapeHTML(mediaLabel(message))}</span></div>`;

      return `${separator}<div class="message ${outgoing ? "outgoing" : ""} ${media ? "has-media" : ""}">${sender}${media}${body}<div class="message-meta">${ms ? escapeHTML(timeOnly(ms)) : ""}</div></div>`;
    }).join("");

    list.scrollTop = list.scrollHeight;
    nearBottom = true;
    observeMedia(list);
  }

  function patchListedChat(chat, changes) {
    const listed = state.chats.find(
      (item) => item.whatsapp_chat_id === chat.whatsapp_chat_id
    );

    if (listed) Object.assign(listed, changes);
  }

  async function toggleFavorite() {
    const chat = state.currentChat;

    if (!chat) return;

    const next = !chat.is_favorite;

    try {
      await api(`/chats/${enc(chat.whatsapp_chat_id)}/favorite`, {
        method: "PUT",
        body: JSON.stringify({ favorite: next })
      });

      chat.is_favorite = next ? 1 : 0;
      patchListedChat(chat, { is_favorite: chat.is_favorite });
      updateConversationHeader();
      showToast(next ? "Ditambahkan ke favorit" : "Dihapus dari favorit");
    } catch (error) {
      showToast(error.message);
    }
  }

  async function toggleArchive() {
    const chat = state.currentChat;

    if (!chat) return;

    const next = !chat.is_archived;

    try {
      await api(`/chats/${enc(chat.whatsapp_chat_id)}/archive`, {
        method: "PUT",
        body: JSON.stringify({ archived: next })
      });

      showToast(next ? "Chat diarsipkan" : "Chat dikeluarkan dari arsip");
      setPage("chats");
      loadChats();
    } catch (error) {
      showToast(error.message);
    }
  }

  /* ---------------------------------------------------------
     Panggilan
     --------------------------------------------------------- */

  async function loadCalls() {
    const list = $("#callsList");

    if (!state.callsLoaded) {
      list.innerHTML = '<div class="loading">Memuat panggilan…</div>';
    }

    try {
      const data = await api("/calls?limit=200");

      state.calls = data.calls || [];
      state.callsLoaded = true;
      state.callsStale = false;
      renderCalls();
    } catch (error) {
      state.callsLoaded = false;
      list.innerHTML = errorState(error.message, "retryCalls");
      $("#retryCalls")?.addEventListener("click", loadCalls);
    }
  }

  function callKind(call) {
    if (call.direction === "outgoing") return "outgoing";

    return call.status === "missed" ? "missed" : "incoming";
  }

  function callLabel(call) {
    if (call.status === "rejected") return "Ditolak";

    if (call.direction === "outgoing") {
      return call.status === "no_answer" ? "Tidak dijawab" : "Keluar";
    }

    return call.status === "missed" ? "Tak terjawab" : "Masuk";
  }

  function renderCalls() {
    const list = $("#callsList");
    const query = state.callSearch.trim().toLowerCase();
    const digits = query.replace(/\D/g, "").replace(/^0+/, "");

    const calls = state.calls.filter((call) => {
      if (state.callFilter !== "all" && callKind(call) !== state.callFilter) {
        return false;
      }

      if (!query) return true;

      return (
        String(call.display_name || "").toLowerCase().includes(query) ||
        Boolean(digits && String(call.phone_number || "").includes(digits))
      );
    });

    $("#callCount").textContent = `${calls.length} panggilan`;

    if (!calls.length) {
      list.innerHTML = query || state.callFilter !== "all"
        ? emptyState("search", "Tidak ada hasil", "Coba ubah filter atau kata kunci.")
        : emptyState(
            "phone",
            "Belum ada panggilan",
            "Panggilan WhatsApp masuk dan keluar akan dicatat di sini."
          );
      return;
    }

    let lastDay = 0;

    list.innerHTML = calls.map((call) => {
      const ms = toMs(call.call_timestamp);
      const day = startOfDay(ms);
      const kind = callKind(call);
      const canSave = !call.is_saved && call.phone_number;

      let heading = "";

      if (day !== lastDay) {
        lastDay = day;
        heading = `<div class="sub-heading">${escapeHTML(dayLabel(ms))}</div>`;
      }

      const iconName = kind === "missed" ? "call-missed" : kind === "outgoing" ? "call-out" : "call-in";

      return `${heading}
        <article class="list-item">
          <div class="call-icon ${kind}">${icon(iconName)}</div>
          <div class="item-body">
            <div class="item-title ${kind === "missed" ? "danger" : ""}">${escapeHTML(call.display_name)}</div>
            <div class="item-sub call-meta">
              ${escapeHTML(callLabel(call))}
              ${call.is_video ? `· ${icon("video", "mini-icon")} Video` : "· Suara"}
              ${call.is_group ? "· Grup" : ""}
            </div>
          </div>
          <div class="call-side">
            <span class="item-time">${escapeHTML(timeOnly(ms))}</span>
            ${canSave
              ? `<button class="link-button" type="button" data-save-call="${escapeHTML(call.id)}">Simpan</button>`
              : call.is_saved
                ? `<span class="saved-tag">${icon("bookmark")}Tersimpan</span>`
                : ""}
          </div>
        </article>`;
    }).join("");
  }

  /* ---------------------------------------------------------
     Kontak
     --------------------------------------------------------- */

  async function loadContacts() {
    const list = $("#contactsList");

    if (!state.contactsLoaded) {
      list.innerHTML = '<div class="loading">Memuat kontak…</div>';
    }

    try {
      const data = await api("/contacts");

      state.contacts = data.contacts || [];
      state.contactsLoaded = true;
      renderContacts();
    } catch (error) {
      state.contactsLoaded = false;
      list.innerHTML = errorState(error.message, "retryContacts");
      $("#retryContacts")?.addEventListener("click", loadContacts);
    }
  }

  function renderContacts() {
    const list = $("#contactsList");
    const query = state.contactSearch.trim().toLowerCase();
    const digits = query.replace(/\D/g, "").replace(/^0+/, "");

    const contacts = state.contacts.filter((contact) => {
      if (!query) return true;

      return (
        contact.name.toLowerCase().includes(query) ||
        Boolean(digits && contact.phone_number.includes(digits))
      );
    });

    if (!contacts.length) {
      list.innerHTML = query
        ? emptyState("search", "Kontak tidak ditemukan", "Coba nama atau nomor lain.")
        : emptyState(
            "users",
            "Belum ada kontak",
            "Simpan nomor HP dari sini, atau kirim /save ke bot Telegram.",
            `<button class="primary-button" type="button" data-add-contact>${icon("plus")}Tambah kontak</button>`
          );
      return;
    }

    list.innerHTML = contacts.map((contact) => `
      <article class="list-item">
        ${avatar(contact.name, contact.name, "small")}
        <div class="item-body">
          <div class="item-title">${escapeHTML(contact.name)}</div>
          <div class="item-sub">${escapeHTML(formatPhone(contact.phone_number))}</div>
        </div>
        <div class="contact-actions">
          <button class="icon-button small" type="button" data-wa="${escapeHTML(contact.phone_number)}" aria-label="Buka di WhatsApp">${icon("chat")}</button>
          <button class="icon-button small" type="button" data-edit="${escapeHTML(contact.id)}" aria-label="Edit kontak">${icon("edit")}</button>
          <button class="icon-button small danger" type="button" data-del="${escapeHTML(contact.id)}" aria-label="Hapus kontak">${icon("trash")}</button>
        </div>
      </article>`).join("");
  }

  function openContactSheet(contact = null, prefill = null) {
    state.editingId = contact ? contact.id : null;

    $("#contactFormTitle").textContent = contact ? "Edit kontak" : "Tambah kontak";
    $("#saveContactButton").textContent = contact ? "Simpan perubahan" : "Simpan";

    const nameInput = $("#contactNameInput");
    const phoneInput = $("#contactPhoneInput");

    nameInput.value = contact?.name || prefill?.name || "";
    phoneInput.value = contact ? formatPhone(contact.phone_number) : formatPhone(prefill?.phone);
    nameInput.classList.remove("invalid");
    phoneInput.classList.remove("invalid");

    $("#contactSheet").classList.remove("hidden");
    document.body.style.overflow = "hidden";

    try {
      tg?.BackButton?.show();
    } catch {
      /* tidak penting */
    }

    setTimeout(() => (nameInput.value ? phoneInput : nameInput).focus(), 60);
  }

  function closeContactSheet() {
    $("#contactSheet").classList.add("hidden");
    $("#contactForm").reset();
    document.body.style.overflow = "";
    state.editingId = null;

    if (!document.body.classList.contains("in-chat")) {
      try {
        tg?.BackButton?.hide();
      } catch {
        /* tidak penting */
      }
    }
  }

  async function submitContact(event) {
    event.preventDefault();

    const nameInput = $("#contactNameInput");
    const phoneInput = $("#contactPhoneInput");
    const name = nameInput.value.trim();
    const phone = phoneInput.value.trim();
    const digits = phone.replace(/\D/g, "");

    nameInput.classList.toggle("invalid", !name);
    phoneInput.classList.toggle("invalid", digits.length < 8 || digits.length > 16);

    if (!name) {
      showToast(ERROR_TEXT.INVALID_NAME);
      nameInput.focus();
      return;
    }

    if (digits.length < 8 || digits.length > 16) {
      showToast(ERROR_TEXT.INVALID_PHONE);
      phoneInput.focus();
      return;
    }

    const editingId = state.editingId;
    const button = $("#saveContactButton");

    button.disabled = true;

    try {
      const data = await api(
        editingId == null ? "/contacts" : `/contacts/${enc(editingId)}`,
        {
          method: editingId == null ? "POST" : "PUT",
          body: JSON.stringify({ name, phone_number: phone })
        }
      );

      closeContactSheet();
      haptic("success");

      showToast(
        editingId != null
          ? "Kontak diperbarui"
          : data.created === false
            ? "Nomor sudah ada, nama diperbarui"
            : "Kontak disimpan"
      );

      state.callsStale = true;
      await loadContacts();
      loadChats(); // nama kontak ikut tampil di daftar chat

      if (state.page === "calls") loadCalls();
    } catch (error) {
      haptic("error");
      showToast(error.message);
    } finally {
      button.disabled = false;
    }
  }

  async function removeContact(id) {
    const contact = state.contacts.find((item) => String(item.id) === String(id));

    if (!contact) return;

    if (!(await confirmAction(`Hapus ${contact.name} dari kontak?`))) return;

    try {
      await api(`/contacts/${enc(id)}`, { method: "DELETE" });

      state.callsStale = true;
      showToast("Kontak dihapus");
      await loadContacts();
      loadChats();
    } catch (error) {
      showToast(error.message);
    }
  }

  /* ---------------------------------------------------------
     Event
     --------------------------------------------------------- */

  function bindEvents() {
    $("#refreshButton").addEventListener("click", refreshCurrentPage);
    $("#backButton").addEventListener("click", () => setPage("chats"));

    // Tema
    $("#themeButton").addEventListener("click", () => {
      setThemePref(resolveScheme() === "dark" ? "light" : "dark");
    });

    $("#themeSegment").addEventListener("click", (event) => {
      const option = event.target.closest("[data-theme-pref]");

      if (option) setThemePref(option.dataset.themePref);
    });

    window.matchMedia?.("(prefers-color-scheme: dark)")
      .addEventListener?.("change", applyTheme);

    // Foto & video
    const messageList = $("#messageList");

    messageList.addEventListener("scroll", () => {
      nearBottom =
        messageList.scrollHeight - messageList.scrollTop - messageList.clientHeight < 200;
    });

    messageList.addEventListener("click", (event) => {
      const img = event.target.closest("[data-media-img]");

      if (img) {
        if (img.getAttribute("src") && !img.closest(".sticker")) {
          openLightbox(img.src);
        }

        return;
      }

      const video = event.target.closest("[data-media-video]");

      if (video) playVideo(video);
    });

    $("#lightbox").addEventListener("click", closeLightbox);
    $("#favoriteButton").addEventListener("click", toggleFavorite);
    $("#archiveButton").addEventListener("click", toggleArchive);

    $("#chatsNav").addEventListener("click", () => setPage("chats"));
    $("#callsNav").addEventListener("click", () => setPage("calls"));
    $("#contactsNav").addEventListener("click", () => setPage("contacts"));
    $("#profileNav").addEventListener("click", () => setPage("account"));

    // Chat
    $("#searchInput").addEventListener("input", onChatSearch);

    $("#chatFilters").addEventListener("click", (event) => {
      const chip = event.target.closest("[data-filter]");

      if (!chip) return;

      const wasArchived = state.filter === "archived";

      state.filter = chip.dataset.filter;

      document.querySelectorAll("#chatFilters .chip").forEach((item) => {
        item.classList.toggle("active", item === chip);
      });

      // Arsip memakai data berbeda dari daftar utama.
      if (wasArchived !== (state.filter === "archived")) {
        state.chatsLoaded = false;
        loadChats();
      } else {
        renderChats();
      }
    });

    $("#chatList").addEventListener("click", (event) => {
      const row = event.target.closest("[data-chat]");

      if (row) openChat(row.dataset.chat);
    });

    // Panggilan
    $("#callsSearchInput").addEventListener("input", (event) => {
      state.callSearch = event.target.value;
      renderCalls();
    });

    $("#callFilters").addEventListener("click", (event) => {
      const chip = event.target.closest("[data-call-filter]");

      if (!chip) return;

      state.callFilter = chip.dataset.callFilter;

      document.querySelectorAll("#callFilters .chip").forEach((item) => {
        item.classList.toggle("active", item === chip);
      });

      renderCalls();
    });

    $("#callsList").addEventListener("click", (event) => {
      const button = event.target.closest("[data-save-call]");

      if (!button) return;

      const call = state.calls.find((item) => String(item.id) === button.dataset.saveCall);

      if (!call?.phone_number) {
        showToast("Nomor telepon tidak tersedia.");
        return;
      }

      openContactSheet(null, { phone: call.phone_number });
    });

    // Kontak
    $("#addContactButton").addEventListener("click", () => openContactSheet());

    $("#contactsSearchInput").addEventListener("input", (event) => {
      state.contactSearch = event.target.value;
      renderContacts();
    });

    $("#contactsList").addEventListener("click", (event) => {
      if (event.target.closest("[data-add-contact]")) {
        openContactSheet();
        return;
      }

      const wa = event.target.closest("[data-wa]");
      const edit = event.target.closest("[data-edit]");
      const del = event.target.closest("[data-del]");

      if (wa) {
        openWhatsApp(wa.dataset.wa);
      } else if (edit) {
        const contact = state.contacts.find(
          (item) => String(item.id) === edit.dataset.edit
        );

        if (contact) openContactSheet(contact);
      } else if (del) {
        removeContact(del.dataset.del);
      }
    });

    // Form kontak
    $("#contactForm").addEventListener("submit", submitContact);

    $("#contactSheet").addEventListener("click", (event) => {
      if (event.target.closest("[data-close-sheet]")) closeContactSheet();
    });

    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;

      if (!$("#lightbox").classList.contains("hidden")) {
        closeLightbox();
      } else if (!$("#contactSheet").classList.contains("hidden")) {
        closeContactSheet();
      }
    });
  }

  /* ---------------------------------------------------------
     Telegram & tema
     --------------------------------------------------------- */

  const THEME_KEY = "dood-theme";

  function getThemePref() {
    try {
      const value = localStorage.getItem(THEME_KEY);

      return ["auto", "light", "dark"].includes(value) ? value : "auto";
    } catch {
      return "auto";
    }
  }

  function setThemePref(value) {
    try {
      localStorage.setItem(THEME_KEY, value);
    } catch {
      /* penyimpanan tidak tersedia */
    }

    applyTheme();
  }

  // "auto" mengikuti tema Telegram, lalu tema perangkat.
  function resolveScheme() {
    const pref = getThemePref();

    if (pref !== "auto") return pref;

    if (tg?.colorScheme) return tg.colorScheme === "dark" ? "dark" : "light";

    return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }

  function applyTheme() {
    const scheme = resolveScheme();
    const root = document.documentElement;

    root.dataset.theme = scheme;

    // Tombol tema: bulan saat terang (ketuk -> gelap), matahari saat gelap.
    $("#themeButton").innerHTML = icon(scheme === "dark" ? "sun" : "moon");

    const pref = getThemePref();

    document.querySelectorAll("#themeSegment [data-theme-pref]").forEach((button) => {
      button.classList.toggle("active", button.dataset.themePref === pref);
    });

    const background = getComputedStyle(root).getPropertyValue("--bg").trim();

    $('meta[name="theme-color"]')?.setAttribute("content", background);

    try {
      tg?.setHeaderColor?.(background);
      tg?.setBackgroundColor?.(background);
    } catch {
      /* versi Telegram lama */
    }
  }

  function initTelegram() {
    applyTheme();

    if (!tg) return;

    tg.ready();
    tg.expand?.();
    tg.onEvent?.("themeChanged", applyTheme);

    tg.BackButton?.onClick(() => {
      if (!$("#lightbox").classList.contains("hidden")) {
        closeLightbox();
      } else if (!$("#contactSheet").classList.contains("hidden")) {
        closeContactSheet();
      } else {
        setPage("chats");
      }
    });
  }

  function init() {
    initTelegram();
    bindEvents();
    loadMe();
    loadChats();
  }

  init();
})();
