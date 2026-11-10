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
    membership: null, // [ADDED] Server-authoritative role and membership state.
    whatsappSessions: [],
    whatsappSessionLimit: 1,
    activeSessionId: null,

    chats: [],
    chatsLoaded: false,
    chatCounts: { all: 0, unread: 0, favorites: 0, archived: 0 },
    filter: "all",
    search: "",
    messageHits: [],
    currentChat: null,
    currentChatMessageSignature: "",

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
    connections: "#connectionsPage",
    automation: "#automationPage",
    account: "#accountPage",
    premium: "#premiumPage" // [ADDED] Dedicated Premium subscription page.
  };

  const NAVS = {
    chats: "#messagesNav",
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

  function avatar(name, seed, extraClass = "", pictureUrl = "") {
    const photo = pictureUrl
      ? `<img class="avatar-photo" src="${escapeHTML(pictureUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer">`
      : escapeHTML(getInitials(name));

    return `<div class="avatar ${extraClass}" style="--h:${avatarHue(seed || name)}">${photo}</div>`;
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
      ...(state.activeSessionId && path !== "/me" && path !== "/account" && path !== "/sessions" && !path.startsWith("/premium/") ? { "X-WAGRAM-Session-ID": state.activeSessionId } : {}),
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
    closeTopbarSearch(false);
    updateTopbarTitle();
    // [ADDED] Show the add-contact action only on the Contacts page.
    $("#addContactButton").classList.toggle("hidden", page !== "contacts");
    $("#bottomNav").classList.toggle("hidden", page === "premium");
    document.body.classList.toggle("premium-page-active", page === "premium");
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

    if (page === "calls") {
      // [MODIFIED] Refresh first, then mark calls as seen after they are displayed.
      loadCalls();
    }

    if (page === "contacts" && !state.contactsLoaded) {
      loadContacts();
    }

    if (page === "account") {
      renderAccount();
      loadMembership(); // [ADDED] Refresh membership whenever Profile is opened.
      loadWhatsAppAccount();
      renderNotificationPreferences();
    }

    window.scrollTo(0, 0);
  }

  // [ADDED] Keep the compact top bar title in sync with the active tab.
  function updateTopbarTitle() {
    const titles = {
      chats: "Pesan",
      calls: "Panggilan",
      contacts: "Kontak",
      account: "Profil",
      premium: "WAGRAM Premium"
    };

    $("#topbarTitle").textContent = titles[state.page] || "Pesan";
    $("#topbarSearchInput").placeholder = state.page === "calls"
      ? "Cari nama atau nomor"
      : state.page === "contacts"
        ? "Cari nama atau nomor"
        : "Cari chat atau pesan";
  }

  // [ADDED] Expand/collapse the top-bar search without shifting the theme button.
  function openTopbarSearch() {
    const topbar = $("#topbar");
    const input = $("#topbarSearchInput");
    const target = state.page === "calls"
      ? $("#callsSearchInput")
      : state.page === "contacts"
        ? $("#contactsSearchInput")
        : state.page === "chats"
          ? $("#searchInput")
          : null;

    topbar.classList.add("search-open");
    $("#searchToggleButton").setAttribute("aria-expanded", "true");
    $("#searchToggleButton").setAttribute("aria-label", "Cari");
    input.value = target?.value || "";
    requestAnimationFrame(() => input.focus());
  }

  function closeTopbarSearch(restoreFocus = true) {
    const topbar = $("#topbar");
    if (!topbar.classList.contains("search-open")) return;

    topbar.classList.remove("search-open");
    $("#searchToggleButton").setAttribute("aria-expanded", "false");
    $("#searchToggleButton").setAttribute("aria-label", "Cari");
    $("#topbarSearchInput").blur();

    if (restoreFocus) {
      $("#topbarTitle").focus?.();
    }
  }

  function handleTopbarSearch() {
    const value = $("#topbarSearchInput").value;
    const target = state.page === "calls"
      ? $("#callsSearchInput")
      : state.page === "contacts"
        ? $("#contactsSearchInput")
        : state.page === "chats"
          ? $("#searchInput")
          : null;

    if (!target) return;
    target.value = value;
    target.dispatchEvent(new Event("input", { bubbles: true }));
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
      await Promise.all([
        loadMembership(),
        loadWhatsAppAccount()
      ]);
      renderNotificationPreferences();
    } catch (error) {
      $("#connectionStatus").textContent = error.message;
    }
  }

  // [ADDED] Fetch the active membership from the authenticated server API.
  async function loadMembership() {
    const tier = $(".profile-tier");
    if (!tier) return;

    try {
      const data = await api("/account");
      state.membership = data.account || null;
      renderMembership();
      renderNotificationPreferences(); // [ADDED] Reapply notification access after the membership refresh.
      renderFreePauseCountdown(); // [ADDED] Show countdown after membership is known.
      // [ADDED] Re-render chat rows after the server confirms the plan; chats and membership load in parallel on startup.
      if (state.chatsLoaded && state.page === "chats") renderChats();
    } catch (error) {
      console.error("Could not load WAGRAM membership:", error);
      if (!state.membership) {
        tier.textContent = "PLAN TIDAK TERSEDIA";
        tier.removeAttribute("title");
        tier.classList.remove("is-premium", "is-admin");
      }
    }
  }

  // [MODIFIED] Show Premium and its live days-hours-minutes expiry countdown in one tier badge.
  function renderMembership() {
    const tier = $(".profile-tier");
    if (!tier) return;

    const membership = state.membership;
    const upgradeButton = $("#upgradePremiumButton");
    const meta = $("#profileMembershipMeta");
    const planLabels = {
      free: "FREE TIER",
      "premium-a": "PREMIUM A",
      "premium-b": "PREMIUM B",
      "premium-c": "PREMIUM C"
    };

    if (!membership) {
      tier.textContent = "FREE TIER";
      tier.removeAttribute("title");
      tier.classList.remove("is-premium", "is-admin");
      if (upgradeButton) upgradeButton.innerHTML = '<span aria-hidden="true">♛</span> Upgrade Premium';
      if (meta) meta.textContent = "Nikmati fitur dasar WAGRAM";
      return;
    }

    const expiryDate = membership.plan_expires_at
      ? new Date(membership.plan_expires_at)
      : null;
    const hasExpiry = expiryDate && !Number.isNaN(expiryDate.getTime());
    const isExpired = hasExpiry && expiryDate.getTime() <= Date.now();
    const isPremium = Boolean(membership.plan && membership.plan !== "free" && !isExpired);
    const rawPlanLabel = String(membership.plan_label || planLabels[membership.plan] || "Premium");
    const remainingMs = hasExpiry ? Math.max(0, expiryDate.getTime() - Date.now()) : 0;
    const totalMinutes = Math.floor(remainingMs / 60000);
    const remainingDays = Math.floor(totalMinutes / 1440);
    const remainingHours = Math.floor((totalMinutes % 1440) / 60);
    const remainingMinutes = totalMinutes % 60;
    const expiryCountdown = `${remainingDays}d ${String(remainingHours).padStart(2, "0")}h ${String(remainingMinutes).padStart(2, "0")}m`; // [MODIFIED] Compact countdown units save badge space.

    // [MODIFIED] Keep the remaining subscription time in the Premium badge only.
    tier.textContent = isPremium
      ? (hasExpiry ? `PREMIUM · ${expiryCountdown}` : "PREMIUM")
      : "FREE TIER";
    tier.classList.toggle("is-premium", isPremium);
    tier.classList.toggle("is-admin", membership.role === "admin");

    if (upgradeButton) {
      upgradeButton.innerHTML = isPremium
        ? '<span aria-hidden="true">♛</span> Perpanjang Premium'
        : '<span aria-hidden="true">♛</span> Upgrade Premium';
    }

    // [MODIFIED] Remove the separate expiry-date line below the tier badge.
    if (meta) meta.textContent = isPremium
      ? ""
      : (isExpired ? "Masa Premium telah berakhir" : ""); // [MODIFIED] Keep the Free Tier badge clean without supporting text.

    const expiry = hasExpiry
      ? expiryDate.toLocaleString("id-ID", {
          dateStyle: "medium",
          timeStyle: "short",
          timeZone: "Asia/Jakarta"
        }) + " WIB"
      : "Tidak ada batas waktu";

    tier.title = [
      `Role: ${membership.role || "user"}`,
      `Plan: ${rawPlanLabel}`,
      `Batas akun WhatsApp: ${membership.sessions_limit || 1}`,
      `Berlaku sampai: ${expiry}`
    ].join("\\n");
  }

  function renderAccount() {
    const me = state.me;

    if (!me) return;

    const fullName = [me.firstName, me.lastName].filter(Boolean).join(" ");
    const name = fullName || me.username || "Pengguna Telegram";

    $("#accountName").textContent = name;
    $("#accountUsername").textContent = me.username ? `@${me.username}` : `ID ${me.id}`;

    const accountAvatar = $("#accountAvatar");
    const accountPhoto = $("#accountPhoto");
    const photoUrl = me.photoUrl || me.photo_url || me.photoURL || "";

    $("#accountInitials").textContent = getInitials(name);
    accountAvatar.style.setProperty("--h", avatarHue(name));

    if (photoUrl) {
      accountPhoto.src = photoUrl;
      accountPhoto.classList.remove("hidden");
      $("#accountInitials").classList.add("hidden");
    } else {
      accountPhoto.removeAttribute("src");
      accountPhoto.classList.add("hidden");
      $("#accountInitials").classList.remove("hidden");
    }
  }


  // [ADDED] Load WhatsApp sessions and restore the selected account.
  async function loadWhatsAppSessions() {
    const data = await api("/sessions");
    state.whatsappSessions = data.sessions || [];
    // [MODIFIED] Prefer the API limit, then the already-loaded membership limit.
    state.whatsappSessionLimit = Math.max(
      1,
      Number(data.limit ?? state.membership?.sessions_limit ?? 1) || 1
    );
    const saved = localStorage.getItem("wagram-active-whatsapp-session");
    const selected = state.whatsappSessions.find((item) => item.session_id === saved) || state.whatsappSessions.find((item) => item.is_primary) || state.whatsappSessions[0];
    state.activeSessionId = selected ? selected.session_id : null;
    renderWhatsAppSessions();
    return selected;
  }

  function renderWhatsAppSessions() {
    const list = $("#whatsappSessionList");
    if (!list) return;
    list.innerHTML = (state.whatsappSessions || []).map((session, index) => {
      const active = session.session_id === state.activeSessionId;
      const status = session.status || session.connection_status || "disconnected";
      const labels = { connected: "Terhubung", connecting: "Menghubungkan", qr: "Menunggu QR", paused: "Pause", disconnected: "Terputus", logged_out: "Keluar" };
      const number = session.phone_number ? "+" + String(session.phone_number).replace(/^\\+/, "") : "Nomor belum terhubung";
      const label = session.label || (session.is_primary ? "WhatsApp utama" : "WhatsApp " + (index + 1));
      return '<button class="whatsapp-session-item' + (active ? ' is-active' : '') + '" type="button" data-session-select="' + escapeHTML(session.session_id) + '">' + '<span class="whatsapp-session-avatar">' + icon("whatsapp") + '</span>' + '<span class="whatsapp-session-info"><strong>' + escapeHTML(label) + '</strong><small>' + escapeHTML(number) + '</small></span>' + '<span class="whatsapp-session-status status-' + escapeHTML(status) + '">' + escapeHTML(labels[status] || status) + '</span>' + (active ? '<span class="whatsapp-session-check">✓</span>' : '') + '</button>';
    }).join("");
    // [ADDED] Keep all linked accounts visible in one Profile card, each with its own actions.
    const accountRows = $("#whatsappAccountRows");
    if (accountRows) {
      // [MODIFIED] Hide newly-created secondary sessions until WhatsApp pairing succeeds.
      accountRows.innerHTML = (state.whatsappSessions || []).filter((session) => {
        const status = session.status || session.connection_status || "disconnected";
        return Boolean(session.phone_number) || status === "connected" || status === "paused";
      }).map((session, index) => {
        const status = session.status || session.connection_status || "disconnected";
        const labels = { connected: "Connected", connecting: "Connecting", qr: "Menunggu QR", paused: "Pause", disconnected: "Connect", logged_out: "Disconnected" };
        const number = session.phone_number ? "+" + String(session.phone_number).replace(/^\\+/, "") : "Nomor belum terhubung";
        const label = session.label || (session.is_primary ? "WhatsApp utama" : "WhatsApp " + (index + 1));
        const active = session.session_id === state.activeSessionId;
        return '<div class="whatsapp-account-row' + (active ? ' is-active' : '') + '" data-account-row="' + escapeHTML(session.session_id) + '">' +
          '<button class="whatsapp-account-select" type="button" data-account-settings="' + escapeHTML(session.session_id) + '" aria-label="Pengaturan ' + escapeHTML(label) + '">' +
          '<span class="whatsapp-account-avatar">' + icon("whatsapp") + (active ? '<span class="whatsapp-account-active-check" aria-label="Session aktif">✓</span>' : '') + '</span><span class="whatsapp-account-copy"><strong>' + escapeHTML(label) + '</strong><span>' + escapeHTML(number) + '</span></span>' +
          '<span class="whatsapp-connection-state' + (status === "connected" ? ' is-connected' : status === "paused" ? ' is-paused' : '') + '"><i></i> ' + escapeHTML(labels[status] || status) + '</span></button>' +
          '<button class="whatsapp-account-disconnect" type="button" data-account-disconnect="' + escapeHTML(session.session_id) + '"' + (status !== "connected" && status !== "paused" ? ' disabled' : '') + '>Disconnect</button>' +
          '</div>';
      }).join("");
    }
    const canAdd = state.whatsappSessions.length < state.whatsappSessionLimit;
    const add = $("#createWhatsAppSessionButton");
    if (add) add.innerHTML = canAdd ? icon("plus") + " Tambah akun WhatsApp" : icon("crown") + " Upgrade untuk tambah akun";
    $("#whatsappSessionLimitText").textContent = state.whatsappSessions.length + " dari " + state.whatsappSessionLimit + " session digunakan";
    const headerAdd = $("#addWhatsAppSessionButton");
    if (headerAdd) {
      headerAdd.classList.toggle("is-session-locked", !canAdd);
      // [MODIFIED] Keep the plus icon visible; show the crown as a small locked-capacity badge.
      headerAdd.innerHTML = '<span aria-hidden="true">+</span>';
      headerAdd.title = canAdd ? "Tambah session WhatsApp" : "Batas session tercapai · Upgrade Premium";
    }
    const selected = state.whatsappSessions.find((item) => item.session_id === state.activeSessionId);
    const deleteButton = $("#whatsappSessionDeleteButton");
    if (deleteButton) deleteButton.hidden = !selected || Boolean(selected.is_primary);
    const selectedStatus = selected?.status || selected?.connection_status || "disconnected";
    const connectButton = $("#whatsappSessionConnectButton");
    if (connectButton) {
      connectButton.hidden = selectedStatus === "connected";
      connectButton.textContent = selectedStatus === "qr" ? "Tampilkan QR" : "Hubungkan session";
    }
  }

  // [ADDED] Load WhatsApp connection details for the selected Profile session.
  async function loadWhatsAppAccount() {
    const phone = $("#accountWhatsAppPhone");
    const stateLabel = $("#accountWhatsAppState");
    const disconnectButton = $("#disconnectWhatsAppButton");
    try {
      await loadWhatsAppSessions();
      if (!state.activeSessionId) throw new Error("Session WhatsApp belum tersedia.");
      const data = await api("/sessions/" + enc(state.activeSessionId) + "/connection");
      const connected = data.status === "connected";
      const paused = data.status === "paused";
      phone.textContent = data.phoneNumber ? `+${String(data.phoneNumber).replace(/^\+/, "")}` : "Nomor belum tersedia";
      $("#accountWhatsAppName").textContent = connected || paused
        ? (data.displayName || "WhatsApp")
        : "WhatsApp";
      const photo = $("#accountWhatsAppPhoto");
      if (connected && data.pictureUrl) {
        photo.src = data.pictureUrl;
        photo.classList.remove("hidden");
      } else {
        photo.removeAttribute("src");
        photo.classList.add("hidden");
      }
      stateLabel.classList.toggle("is-connected", connected);
      stateLabel.classList.toggle("is-paused", paused);
      // [MODIFIED] Connect is available from Profile when WhatsApp is disconnected or paused.
      stateLabel.classList.remove("is-connecting");
      stateLabel.disabled = connected;
      stateLabel.innerHTML = connected
        ? '<i></i> Connected <span class="free-pause-countdown hidden" id="freePauseCountdown" aria-live="off">00.00</span>'
        : paused
          ? '<i></i> Pause <span class="free-pause-countdown hidden" id="freePauseCountdown" aria-live="off">00.00</span>'
          : '<i></i> Connect <span class="free-pause-countdown hidden" id="freePauseCountdown" aria-live="off">00.00</span>';
      disconnectButton.disabled = !connected && !paused;
      disconnectButton.dataset.sessionId = state.activeSessionId;
      renderFreePauseCountdown(); // [ADDED] Refresh countdown with connection status.
    } catch (error) {
      phone.textContent = "Status koneksi tidak tersedia";
      stateLabel.classList.remove("is-connected");
      stateLabel.textContent = "Status tidak tersedia";
      disconnectButton.disabled = true;
    }
  }

  // [ADDED] Countdown until the next automatic Free-tier pause at 08:00 WITA.
  function renderFreePauseCountdown() {
    const countdown = $("#accountWhatsAppState .free-pause-countdown");
    if (!countdown) return;
    if (!state.membership || state.membership.plan !== "free") {
      countdown.classList.add("hidden");
      return;
    }
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Makassar", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    const nextPause = new Date(Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day), 6, 0, 0));
    if (Date.now() >= nextPause.getTime()) nextPause.setUTCDate(nextPause.getUTCDate() + 1);
    const remainingMinutes = Math.max(0, Math.floor((nextPause.getTime() - Date.now()) / 60000));
    const hours = Math.floor(remainingMinutes / 60);
    const minutes = remainingMinutes % 60;
    countdown.textContent = String(hours).padStart(2, "0") + "." + String(minutes).padStart(2, "0");
    countdown.classList.remove("hidden");
    countdown.title = "Menuju pause otomatis pukul 14.00 WITA";
    countdown.setAttribute("aria-label", "Pause otomatis dalam " + hours + " jam " + minutes + " menit");
  }

  // [ADDED] Persist notification preferences locally on this device.
  const NOTIFICATION_PREFS_KEY = "wagram-notification-preferences";
  const DEFAULT_NOTIFICATION_PREFS = {
    private: true, groups: true, channels: true, calls: true, mentions: true, media: true
  };

  function isPremiumMembership() {
    return Boolean(state.membership?.plan && state.membership.plan !== "free");
  }

  function isPremiumNotification(key) {
    return ["groups", "channels", "mentions", "media"].includes(key);
  }

  function renderNotificationPreferences() {
    let allSaved = {};
    try {
      allSaved = JSON.parse(localStorage.getItem(NOTIFICATION_PREFS_KEY) || "{}");
    } catch {
      allSaved = {};
    }
    const saved = allSaved[state.activeSessionId] || {};
    const premium = isPremiumMembership();
    document.querySelectorAll("[data-notification]").forEach((button) => {
      const key = button.dataset.notification;
      button.dataset.sessionId = state.activeSessionId || "";
      const locked = !premium && isPremiumNotification(key);
      const enabled = !locked && (
        typeof saved[key] === "boolean" ? saved[key] : DEFAULT_NOTIFICATION_PREFS[key]
      );
      const option = button.closest(".notification-option");
      button.setAttribute("aria-checked", String(enabled));
      button.setAttribute("aria-disabled", String(locked));
      button.classList.toggle("is-premium-locked", locked);
      option?.classList.toggle("is-premium-locked", locked);
      button.setAttribute(
        "aria-label",
        locked ? `${option?.querySelector(".notification-option-copy strong")?.textContent || key}, khusus Premium` : key
      );
      let crown = button.querySelector(".notification-lock-crown");
      if (locked && !crown) {
        crown = document.createElement("span");
        crown.className = "notification-lock-crown";
        crown.setAttribute("aria-hidden", "true");
        crown.textContent = "👑";
        button.appendChild(crown);
      } else if (!locked && crown) {
        crown.remove();
      }
    });
  }

  function toggleNotificationPreference(button) {
    const key = button.dataset.notification;
    if (!Object.prototype.hasOwnProperty.call(DEFAULT_NOTIFICATION_PREFS, key)) return;
    if (!isPremiumMembership() && isPremiumNotification(key)) return;
    const enabled = button.getAttribute("aria-checked") !== "true";
    let allSaved = {};
    try {
      allSaved = JSON.parse(localStorage.getItem(NOTIFICATION_PREFS_KEY) || "{}");
    } catch {
      allSaved = {};
    }
    const sessionId = button.dataset.sessionId || state.activeSessionId;
    if (!sessionId) return;
    const saved = allSaved[sessionId] || {};
    saved[key] = enabled;
    allSaved[sessionId] = saved;
    try {
      localStorage.setItem(NOTIFICATION_PREFS_KEY, JSON.stringify(allSaved));
    } catch {
      showToast("Pengaturan tidak dapat disimpan di perangkat ini.");
    }
    button.setAttribute("aria-checked", String(enabled));
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
      // [MODIFIED] Fetch active and archived chats together so every filter count stays accurate.
      const [activeData, archivedData] = await Promise.all([
        api("/chats?limit=100&archived=false"),
        api("/chats?limit=100&archived=true")
      ]);
      const activeChats = activeData.chats || [];
      const archivedChats = archivedData.chats || [];

      state.chatCounts = {
        all: activeChats.length,
        unread: activeChats.filter((chat) => Number(chat.unread_count) > 0).length,
        favorites: activeChats.filter((chat) => Boolean(chat.is_favorite)).length,
        archived: archivedChats.length
      };
      state.chats = state.filter === "archived" ? archivedChats : activeChats;
      state.chatsLoaded = true;
      updateChatFilterCounts();
      updateBottomNavBadges();
      renderChats();
    } catch (error) {
      state.chatsLoaded = false;
      list.innerHTML = errorState(error.message, "retryChats");
      $("#retryChats")?.addEventListener("click", loadChats);
    }
  }

  // [ADDED] Keep the count badges on chat filters synchronized with server data.
  function updateChatFilterCounts() {
    const counts = state.chatCounts;
    updateBottomNavBadges();
    const labels = {
      all: "Semua",
      unread: "Belum dibaca",
      favorites: "Favorit",
      archived: "Arsip"
    };

    Object.entries(labels).forEach(([filter, label]) => {
      const button = document.querySelector(`#chatFilters [data-filter="${filter}"]`);
      if (!button) return;
      button.innerHTML = `${label}<span class="chip-count">${counts[filter] || 0}</span>`;
    });
  }

  function chatName(chat) {
    return chat.display_name || chat.name || formatPhone(chat.phone_number) || chat.whatsapp_chat_id;
  }

  // [ADDED] Free accounts cannot open WhatsApp groups or channels.
  function isPremiumLockedChat(chat) {
    const jid = String(chat?.whatsapp_chat_id || "");
    return chat?.chat_type === "group" || jid.endsWith("@newsletter");
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

    // [MODIFIED] The duplicate conversation heading and count were removed from the page.
    // Filter totals are displayed directly in the filter chips.
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
      const isLocked = !isPremiumMembership() && isPremiumLockedChat(chat);

      return `
        <div class="chat-swipe-row ${isLocked ? "is-premium-locked" : ""}" data-chat-row="${escapeHTML(chat.whatsapp_chat_id)}">
          <div class="chat-actions">
            <button class="chat-favorite-action" type="button" data-favorite-chat="${escapeHTML(chat.whatsapp_chat_id)}" aria-label="${chat.is_favorite ? "Hapus dari favorit" : "Tambahkan ke favorit"}">
              ${icon("star")}
            </button>
            <button class="chat-archive-action" type="button" data-archive-chat="${escapeHTML(chat.whatsapp_chat_id)}" aria-label="Arsipkan chat">
              ${icon("archive")}
            </button>
          </div>
          <button class="list-item chat-row-content" type="button" data-chat="${escapeHTML(chat.whatsapp_chat_id)}" ${isLocked ? 'data-premium-chat="true"' : ""}>
            <span class="chat-avatar-wrap">
              ${avatar(name, name, "", chat.profile_picture_url)}
              ${isLocked ? '<span class="premium-chat-crown" aria-label="Premium">👑</span>' : ""}
            </span>
            <div class="item-body">
              <div class="item-row">
                <span class="item-title">${escapeHTML(name)}</span>
                <span class="item-time ${unread ? "is-unread" : ""}">${escapeHTML(formatListTime(chat.last_message_at))}</span>
              </div>
              <div class="item-row">
                <span class="item-sub">${isLocked ? (chat.chat_type === "group" ? "Grup · Premium" : "Saluran · Premium") : escapeHTML(chat.last_message_preview || (isGroup ? "Grup" : "Belum ada pesan"))}</span>
                ${chat.is_favorite || unread
                  ? `<span class="item-flags">${chat.is_favorite ? icon("star", "mini-icon fav") : ""}${unread ? `<span class="badge">${unread > 99 ? "99+" : unread}</span>` : ""}</span>`
                  : ""}
              </div>
            </div>
          </button>
        </div>`;
    }).join("");

    const hitRows = hits.length
      ? `<div class="sub-heading">Pesan</div>` + hits.map((hit) => {
          const name = hit.chat_name || hit.sender_name || "Chat";
          const hitChat = state.chats.find((chat) => chat.whatsapp_chat_id === hit.whatsapp_chat_id);
          const isLocked = !isPremiumMembership() && isPremiumLockedChat(hitChat || { whatsapp_chat_id: hit.whatsapp_chat_id });

          return `
            <button class="list-item ${isLocked ? "is-premium-locked" : ""}" type="button" data-chat="${escapeHTML(hit.whatsapp_chat_id)}" ${isLocked ? 'data-premium-chat="true"' : ""}>
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
    const requestedChat = state.chats.find((chat) => chat.whatsapp_chat_id === chatId);
    if (!isPremiumMembership() && isPremiumLockedChat(requestedChat || { whatsapp_chat_id: chatId })) {
      openPremiumSheet();
      return;
    }

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
      state.currentChatMessageSignature = getMessageSignature(data.messages || []);

      // [MODIFIED] Wait until the local read status is saved before refreshing unread badges.
      try {
        await api(`/chats/${enc(chatId)}/read`, { method: "POST" });
      } catch (readError) {
        console.warn("Could not mark chat as read in Mini App:", readError.message);
      }

      // [MODIFIED] Clear the unread count immediately in the current UI.
      const openedChat = state.chats.find(
        (chat) => chat.whatsapp_chat_id === chatId
      );

      if (openedChat) {
        openedChat.unread_count = 0;
      }

      state.chatCounts.unread = state.chats.filter(
        (chat) => Number(chat.unread_count) > 0
      ).length;

      updateChatFilterCounts();
      renderChats();
      updateBottomNavBadges();
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
    conversationAvatar.innerHTML = chat.profile_picture_url
      ? `<img class="avatar-photo" src="${escapeHTML(chat.profile_picture_url)}" alt="" referrerpolicy="no-referrer">`
      : escapeHTML(getInitials(name));
    conversationAvatar.style.setProperty("--h", avatarHue(name));
    conversationAvatar.dataset.profileJid = chat.whatsapp_chat_id || "";
    conversationAvatar.dataset.profileName = name;
    $("#conversationName").dataset.profileJid = chat.whatsapp_chat_id || "";
    $("#conversationName").dataset.profileName = name;

    // [MODIFIED] Enable contact and WhatsApp actions only when a phone number is available.
    const hasPhone = Boolean(String(chat.phone_number || "").replace(/\D/g, ""));
    $("#saveChatContactButton").disabled = !hasPhone;
    $("#openChatWhatsAppButton").disabled = !hasPhone;
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

  // [ADDED] Compact Premium placeholder for incoming media on Free accounts.
  function lockedMediaHTML(message) {
    const kind = message.media_kind || message.message_type;
    const labels = {
      photo: "foto",
      image: "foto",
      video: "video",
      animation: "GIF",
      sticker: "stiker",
      audio: "audio",
      ptt: "pesan suara",
      document: "dokumen",
      location: "lokasi",
      contact: "kontak",
      view_once: "media sekali lihat"
    };
    const label = labels[kind] || "media";
    const sender = message.direction === "outgoing"
      ? "Anda"
      : message.contact_name || message.sender_name || chatName(state.currentChat || {});
    const iconName = ["photo", "image"].includes(kind) ? "file"
      : ["video", "animation"].includes(kind) ? "video"
        : ["audio", "ptt"].includes(kind) ? "play"
          : kind === "sticker" ? "star" : "file";

    return `<div class="locked-media">
      <div class="locked-media-heading">${icon(iconName)}<strong>${escapeHTML(label.charAt(0).toUpperCase() + label.slice(1))}</strong><span class="locked-media-lock">${icon("eye-off")}</span></div>
      <div class="locked-media-copy">${escapeHTML(sender)} mengirim ${escapeHTML(label)}</div>
      <button class="locked-media-upgrade" type="button" data-premium-media="true"><span aria-hidden="true">👑</span> Upgrade untuk melihat</button>
    </div>`;
  }

  function mediaHTML(message) {
    const kind = message.media_kind || message.message_type;
    const mime = String(message.media_mimetype || "").toLowerCase();
    const fileName = escapeHTML(message.media_file_name || "Dokumen");
    const isSticker = kind === "sticker";
    const isImage =
      kind === "photo" ||
      kind === "image" ||
      isSticker ||
      (kind === "document" && mime.startsWith("image/"));

    if (isImage) {
      return `<div class="media ${isSticker ? "sticker" : ""}"><img class="media-img is-loading" alt="${isSticker ? "Stiker" : "Foto"}" data-media-img="${escapeHTML(message.id)}"></div>`;
    }

    if (kind === "video" || kind === "animation") {
      const isGif = kind === "animation";
      return `<button class="media video-card" type="button" data-media-video="${escapeHTML(message.id)}" data-gif="${isGif ? 1 : 0}">${icon("play")}<span>${isGif ? "Putar GIF" : "Putar video"}</span></button>`;
    }

    if (kind === "audio" || kind === "ptt") {
      const isVoice = /voice|ogg/i.test(message.media_file_name || mime);
      return `<button class="media audio-card" type="button" data-media-audio="${escapeHTML(message.id)}">${icon("play")}<span>${isVoice ? "Putar pesan suara" : "Putar audio"}</span></button>`;
    }

    if (kind === "document" || message.media_file_name) {
      const isPdf = mime === "application/pdf";
      return `<button class="media document-card" type="button" data-media-document="${escapeHTML(message.id)}" data-file-name="${fileName}" data-open-inline="${isPdf ? 1 : 0}">${icon("file")}<span><strong>${fileName}</strong><small>${isPdf ? "PDF · Buka dokumen" : "Dokumen · Unduh file"}</small></span></button>`;
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

  // [ADDED] Load audio from the authenticated media endpoint on demand.
  async function playAudio(button) {
    if (button.dataset.busy) return;
    button.dataset.busy = "1";
    const label = button.querySelector("span");
    const original = label.textContent;
    label.textContent = "Memuat audio…";

    try {
      const url = await fetchMediaURL(button.dataset.mediaAudio);
      const audio = document.createElement("audio");
      audio.className = "media-audio";
      audio.controls = true;
      audio.preload = "metadata";
      audio.src = url;
      button.replaceWith(audio);
      await audio.play().catch(() => {});
    } catch (error) {
      label.textContent = original;
      delete button.dataset.busy;
      showToast(error.message);
    }
  }

  // [ADDED] Open PDFs in the browser and download other document types.
  async function openDocument(button) {
    if (button.dataset.busy) return;
    button.dataset.busy = "1";
    const label = button.querySelector("small");
    const original = label.textContent;
    label.textContent = "Menyiapkan dokumen…";

    const popup = button.dataset.openInline === "1"
      ? window.open("about:blank", "_blank")
      : null;

    try {
      const url = await fetchMediaURL(button.dataset.mediaDocument);
      if (button.dataset.openInline === "1") {
        if (popup) {
          popup.location.href = url;
        } else {
          showToast("Izinkan pop-up untuk membuka PDF.");
        }
      } else {
        const link = document.createElement("a");
        link.href = url;
        link.download = button.dataset.fileName || "document";
        document.body.appendChild(link);
        link.click();
        link.remove();
      }
      label.textContent = original;
      delete button.dataset.busy;
    } catch (error) {
      popup?.close();
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

  function renderMessages(messages, options = {}) {
    const list = $("#messageList");
    const previousDistanceFromBottom =
      list.scrollHeight - list.scrollTop - list.clientHeight;
    const shouldStickToBottom = options.preservePosition
      ? previousDistanceFromBottom < 200
      : true;

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
      const deleted = Boolean(Number(message.is_deleted));
      const edited = Boolean(Number(message.is_edited));
      // [ADDED] View Once messages are represented without exposing or downloading their media.
      const viewOnce = message.message_type === "view_once";

      let separator = "";

      if (day && String(day) !== lastDay) {
        lastDay = String(day);
        separator = `<div class="day-label">${escapeHTML(dayLabel(ms))}</div>`;
      }

      // Nama dari Kontak diutamakan dibanding nama profil WhatsApp.
      const senderName = message.contact_name || message.sender_name;

      const sender = isGroup && !outgoing && senderName
        ? (message.sender_jid
          ? `<button class="message-sender profile-sender" type="button" data-profile-jid="${escapeHTML(message.sender_jid)}" data-profile-name="${escapeHTML(senderName)}">${escapeHTML(senderName)}</button>`
          : `<div class="message-sender">${escapeHTML(senderName)}</div>`)
        : "";

      const lockedMedia = Boolean(message.media_locked && !deleted && !viewOnce);
      const media = lockedMedia
        ? lockedMediaHTML(message)
        : message.has_media ? mediaHTML(message) : "";

      // [MODIFIED] Hide captions together with locked incoming media for Free accounts.
      const body = viewOnce
        ? `<div class="view-once-content"><span class="view-once-symbol" aria-hidden="true">◉</span><div class="view-once-copy"><strong>Media Sekali Lihat</strong><span>Kontak mengirim media yang hanya dapat dilihat satu kali. Silakan buka WhatsApp untuk melihatnya.</span></div><button class="view-once-action" type="button" data-view-once-open="true">Buka WhatsApp</button></div>`
        : lockedMedia
          ? ""
          : message.body
            ? `<div class="message-text">${escapeHTML(message.body)}</div>`
            : media
              ? ""
              : `<div class="message-text"><span class="message-media">${escapeHTML(mediaLabel(message))}</span></div>`;

      const deletedLabel = deleted
        ? '<div class="message-status">Pesan dihapus</div>'
        : "";
      const editedLabel = edited && !deleted
        ? '<span class="message-edited">diedit</span>'
        : "";
      const originalBubble = edited && !deleted && message.original_body != null
        ? `<div class="message original-version ${outgoing ? "outgoing" : ""}"><div class="message-text">${escapeHTML(message.original_body)}</div><div class="message-meta">Pesan sebelumnya</div></div><div class="edit-connector" aria-hidden="true"><span></span></div>`
        : "";
      const currentBubble = `<div class="message ${outgoing ? "outgoing" : ""} ${media ? "has-media" : ""} ${deleted ? "deleted" : ""} ${edited && !deleted ? "edited" : ""} ${viewOnce ? "view-once" : ""}">${sender}${deletedLabel}${viewOnce ? "" : media}${body}<div class="message-meta">${ms ? escapeHTML(timeOnly(ms)) : ""} ${editedLabel}</div></div>`;

      if (originalBubble) {
        return `${separator}<div class="message-history-group ${outgoing ? "outgoing" : ""}" data-edit-expandable="true">${originalBubble}${currentBubble}</div>`;
      }

      return `${separator}${currentBubble}`;
    }).join("");

    if (shouldStickToBottom) {
      list.scrollTop = list.scrollHeight;
    } else {
      list.scrollTop = Math.max(
        0,
        list.scrollHeight - list.clientHeight - previousDistanceFromBottom
      );
    }
    nearBottom = shouldStickToBottom;
    observeMedia(list);
  }

  /* ---------------------------------------------------------
     Profil WhatsApp
     --------------------------------------------------------- */

  function profilePhone(jid) {
    const match = String(jid || "").match(/^(\d+)(?::\d+)?@s\.whatsapp\.net$/);
    return match ? formatPhone(match[1]) : "";
  }

  function openProfileSheet() {
    $("#profileSheet").classList.remove("hidden");
    document.body.style.overflow = "hidden";
    try {
      tg?.BackButton?.show();
    } catch {
      /* tidak penting */
    }
  }

  function closeProfileSheet() {
    $("#profileSheet").classList.add("hidden");
    $("#profilePhoto").removeAttribute("src");
    document.body.style.overflow = "";
    if (
      $("#contactSheet").classList.contains("hidden") &&
      !document.body.classList.contains("in-chat")
    ) {
      try {
        tg?.BackButton?.hide();
      } catch {
        /* tidak penting */
      }
    }
  }

  async function openProfile(jid, fallbackName = "", fallbackPhone = "") {
    if (!jid) return;

    const title = $("#profileDisplayName");
    const about = $("#profileAbout");
    const phone = $("#profilePhone");
    const identifier = $("#profileIdentifier");
    const photo = $("#profilePhoto");
    const avatarFallback = $("#profileAvatarFallback");

    title.textContent = fallbackName || "Profil WhatsApp";
    about.textContent = "Memuat info…";
    phone.textContent = formatPhone(fallbackPhone) || "Memuat…";
    identifier.textContent = jid;
    photo.classList.add("hidden");
    avatarFallback.classList.remove("hidden");
    avatarFallback.textContent = getInitials(fallbackName || jid);
    avatarFallback.style.setProperty("--h", avatarHue(fallbackName || jid));
    $("#profileUpdated").textContent = "";
    openProfileSheet();

    try {
      const data = await api(`/profile/${enc(jid)}`);
      const profile = data.profile || {};
      const name = profile.displayName || fallbackName || "Pengguna WhatsApp";

      title.textContent = name;
      about.textContent = profile.about || "Info tidak tersedia atau disembunyikan.";
      phone.textContent = formatPhone(profile.phoneNumber) || formatPhone(fallbackPhone) || profilePhone(jid) || (
        jid.endsWith("@g.us") ? "Grup WhatsApp" : "Nomor tidak tersedia"
      );
      identifier.textContent = jid;

      if (profile.pictureUrl) {
        // [ADDED] Reuse the fetched profile photo in chat list and conversation header.
        if (state.currentChat?.whatsapp_chat_id === jid) {
          state.currentChat.profile_picture_url = profile.pictureUrl;
          updateConversationHeader();
        }
        const listedChat = state.chats.find((chat) => chat.whatsapp_chat_id === jid);
        if (listedChat) {
          listedChat.profile_picture_url = profile.pictureUrl;
          renderChats();
        }

        photo.onload = () => {
          photo.classList.remove("hidden");
          avatarFallback.classList.add("hidden");
        };
        photo.onerror = () => {
          photo.classList.add("hidden");
          avatarFallback.classList.remove("hidden");
        };
        photo.src = profile.pictureUrl;
      }

      if (profile.cachedAt) {
        const date = new Date(profile.cachedAt);
        $("#profileUpdated").textContent = `Diperbarui ${date.toLocaleString("id-ID", {
          day: "numeric",
          month: "short",
          hour: "2-digit",
          minute: "2-digit"
        })}${profile.stale ? " · cache lama" : ""}`;
      }
    } catch (error) {
      about.textContent = error.message;
      phone.textContent = formatPhone(fallbackPhone) || profilePhone(jid) || "Tidak tersedia";
      identifier.textContent = jid;
      showToast(error.message);
    }
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

  // [ADDED] Archive a chat directly from its swipe action in the chat list.
  async function archiveChatFromList(chatId, button) {
    const chat = state.chats.find((item) => String(item.whatsapp_chat_id) === String(chatId));
    if (!chat || button.disabled) return;

    button.disabled = true;
    try {
      await api(`/chats/${enc(chatId)}/archive`, {
        method: "PUT",
        body: JSON.stringify({ archived: true })
      });

      chat.is_archived = 1;
      showToast("Chat berhasil diarsipkan");
      await loadChats();
    } catch (error) {
      button.disabled = false;
      showToast(error.message);
    }
  }

  // [ADDED] Toggle favorite directly from the revealed chat actions.
  async function toggleFavoriteFromList(chatId, button) {
    const chat = state.chats.find((item) => String(item.whatsapp_chat_id) === String(chatId));
    if (!chat || button.disabled) return;

    const next = !chat.is_favorite;
    button.disabled = true;
    try {
      await api(`/chats/${enc(chatId)}/favorite`, {
        method: "PUT",
        body: JSON.stringify({ favorite: next })
      });

      chat.is_favorite = next ? 1 : 0;
      showToast(next ? "Ditambahkan ke favorit" : "Dihapus dari favorit");
      await loadChats();
    } catch (error) {
      button.disabled = false;
      showToast(error.message);
    }
  }

  /* ---------------------------------------------------------
     Panggilan
     --------------------------------------------------------- */

  // [ADDED] Call notifications are tracked locally until the Calls tab is opened.
  const CALLS_LAST_SEEN_KEY = "wagram-calls-last-seen";

  function getCallsLastSeen() {
    try {
      const stored = localStorage.getItem(CALLS_LAST_SEEN_KEY);
      return stored === null ? null : Number(stored) || 0;
    } catch {
      return 0;
    }
  }

  function markCallsSeen() {
    try {
      localStorage.setItem(CALLS_LAST_SEEN_KEY, String(Date.now()));
    } catch {
      /* penyimpanan lokal tidak tersedia */
    }
    updateBottomNavBadges();
  }

  function updateBottomNavBadges() {
    const messageBadge = $("#messagesNavBadge");
    const callsBadge = $("#callsNavBadge");

    const unreadMessages = state.chats.reduce(
      (total, chat) => total + Math.max(0, Number(chat.unread_count) || 0),
      0
    );

    if (messageBadge) {
      messageBadge.textContent = unreadMessages > 99 ? "99+" : String(unreadMessages);
      messageBadge.classList.toggle("hidden", unreadMessages <= 0);
    }

    if (callsBadge) {
      const lastSeen = getCallsLastSeen();
      const unseenCalls = lastSeen === null
        ? 0
        : state.calls.filter((call) =>
            call.direction === "incoming" &&
            !call.is_archived &&
            toMs(call.call_timestamp) > lastSeen
          ).length;

      callsBadge.textContent = unseenCalls > 99 ? "99+" : String(unseenCalls);
      callsBadge.classList.toggle("hidden", unseenCalls <= 0);
    }
  }

  async function loadCalls() {
    const list = $("#callsList");

    if (!state.callsLoaded) {
      list.innerHTML = '<div class="loading">Memuat panggilan…</div>';
    }

    try {
      const data = await api("/calls?limit=200&archived=true");

      state.calls = data.calls || [];
      state.callsLoaded = true;
      state.callsStale = false;
      // [ADDED] On first install, existing call history is the baseline, not unread.
      if (getCallsLastSeen() === null) {
        try {
          localStorage.setItem(CALLS_LAST_SEEN_KEY, String(Date.now()));
        } catch {
          /* penyimpanan lokal tidak tersedia */
        }
      }
      updateBottomNavBadges();
      renderCalls();
      if (state.page === "calls") markCallsSeen();
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

    const favoriteCount = state.calls.filter((call) => Boolean(call.is_favorite) && !call.is_archived).length;
    const archivedCount = state.calls.filter((call) => Boolean(call.is_archived)).length;
    const favoriteCountNode = $('#callFavoriteCount');
    const archivedCountNode = $('#callArchivedCount');
    if (favoriteCountNode) favoriteCountNode.textContent = favoriteCount;
    if (archivedCountNode) archivedCountNode.textContent = archivedCount;

    const calls = state.calls.filter((call) => {
      if (state.callFilter === "archived" && !call.is_archived) return false;
      if (state.callFilter !== "archived" && call.is_archived) return false;
      if (state.callFilter === "favorites" && !call.is_favorite) return false;
      if (["incoming", "outgoing", "missed"].includes(state.callFilter) && callKind(call) !== state.callFilter) {
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
      const canSave = Boolean(call.phone_number);

      let heading = "";

      if (day !== lastDay) {
        lastDay = day;
        heading = `<div class="sub-heading">${escapeHTML(dayLabel(ms))}</div>`;
      }

      const iconName = kind === "missed" ? "call-missed" : kind === "outgoing" ? "call-out" : "call-in";

      return `${heading}
        <div class="call-swipe-row" data-call-row="${escapeHTML(call.id)}" data-call-phone="${escapeHTML(call.phone_number || "")}">
          <div class="call-actions">
            <button class="call-favorite-action" type="button" data-call-favorite="${escapeHTML(call.id)}" aria-label="${call.is_favorite ? "Hapus dari favorit panggilan" : "Favoritkan panggilan"}">${icon("star")}</button>
            <button class="call-archive-action" type="button" data-call-archive="${escapeHTML(call.id)}" aria-label="Arsipkan panggilan">${icon("archive")}</button>
          </div>
          <article class="list-item call-row-content">
            <div class="call-icon ${kind}">${icon(iconName)}</div>
            <div class="item-body">
              <div class="call-name-line">
                <div class="item-title ${kind === "missed" ? "danger" : ""}">${escapeHTML(call.display_name)}</div>
                ${canSave ? `<button class="call-inline-save" type="button" data-save-call="${escapeHTML(call.id)}" aria-label="${call.is_saved ? "Edit nama kontak" : "Simpan nomor ke kontak"}" title="${call.is_saved ? "Edit nama kontak" : "Simpan kontak"}">${icon("user-plus")}</button>` : ""}
              </div>
              <div class="item-sub call-meta">
                <span class="call-phone-line">${escapeHTML(formatPhone(call.phone_number) || callLabel(call))}</span>
                <span class="call-detail">${escapeHTML(callLabel(call))} ${call.is_video ? `· ${icon("video", "mini-icon")} Video` : "· Suara"}${call.is_group ? " · Grup" : ""}</span>
              </div>
            </div>
            <div class="call-side"><span class="item-time">${escapeHTML(timeOnly(ms))}</span></div>
          </article>
        </div>`;
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
      <div class="contact-swipe-row" data-contact-row="${escapeHTML(contact.id)}">
        <div class="contact-swipe-actions">
          <button class="contact-swipe-whatsapp" type="button" data-wa="${escapeHTML(contact.phone_number)}" aria-label="Buka di WhatsApp">${icon("whatsapp")}</button>
          <button class="contact-swipe-edit" type="button" data-edit="${escapeHTML(contact.id)}" aria-label="Edit kontak">${icon("edit")}</button>
          <button class="contact-swipe-delete" type="button" data-del="${escapeHTML(contact.id)}" aria-label="Hapus kontak">${icon("trash")}</button>
        </div>
        <article class="list-item contact-row-content">
          ${avatar(contact.name, contact.name, "small")}
          <div class="item-body">
            <div class="item-title">${escapeHTML(contact.name)}</div>
            <div class="item-sub">${escapeHTML(formatPhone(contact.phone_number))}</div>
          </div>
        </article>
      </div>`).join("");
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

      // [MODIFIED] Refresh the active chat header and chat list immediately after saving a contact.
      if (state.currentChat && String(state.currentChat.phone_number || "").replace(/\D/g, "") === digits) {
        state.currentChat.display_name = name;
        state.currentChat.name = name;
        updateConversationHeader();
      }

      await loadChats(); // [MODIFIED] Wait for the chat list refresh so the saved contact name appears immediately.
      if (state.page === "calls") await loadCalls();
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
     [ADDED] WhatsApp session manager actions
     --------------------------------------------------------- */

  // [ADDED] A newly-created session remains pending until WhatsApp completes pairing.
  let pendingWhatsAppSessionId = null;

  function openWhatsAppSessions() {
    renderWhatsAppSessions();
    $("#whatsappSessionQrWrap").classList.add("hidden");
    $("#whatsappSessionsModal").classList.remove("hidden");
    $("#whatsappSessionsModal").classList.remove("is-pairing");
    document.body.classList.add("whatsapp-sessions-open");
  }

  function closeWhatsAppSessions() {
    $("#whatsappSessionsModal").classList.add("hidden");
    $("#whatsappSessionsModal").classList.remove("is-pairing");
    document.body.classList.remove("whatsapp-sessions-open");
    // [ADDED] Remove an abandoned pending session so a cancelled QR does not consume a slot.
    if (pendingWhatsAppSessionId) {
      const cancelledSessionId = pendingWhatsAppSessionId;
      pendingWhatsAppSessionId = null;
      if (whatsappQrPollTimer) clearInterval(whatsappQrPollTimer);
      whatsappQrPollTimer = null;
      // [MODIFIED] Delete only the unpaired account; the previously active account remains selected.
      api("/sessions/" + enc(cancelledSessionId), {
        method: "DELETE",
        headers: { "X-WAGRAM-Session-ID": cancelledSessionId }
      }).then(async () => {
        await loadWhatsAppSessions();
        await loadWhatsAppAccount();
        renderWhatsAppSessions();
        renderNotificationPreferences();
      }).catch(() => {});
    }
  }

  async function selectWhatsAppSession(sessionId) {
    if (!state.whatsappSessions.some((item) => item.session_id === sessionId)) return;
    if (sessionId === state.activeSessionId) return;
    state.activeSessionId = sessionId;
    localStorage.setItem("wagram-active-whatsapp-session", sessionId);
    // [MODIFIED] Close any open chat so content from the previous account cannot remain visible.
    closeConversationUI();
    state.chatsLoaded = false;
    state.callsLoaded = false;
    state.contactsLoaded = false;
    state.chats = [];
    state.calls = [];
    state.contacts = [];
    renderWhatsAppSessions();
    try {
      await loadWhatsAppAccount();
      renderNotificationPreferences(); // [ADDED] Load this account's own notification preferences.
      await Promise.all([loadChats(), loadCalls(), loadContacts()]);
      state.callsLoaded = true;
      state.contactsLoaded = true;
      closeWhatsAppSessions();
      showToast("Session WhatsApp diganti");
    } catch (error) { showToast(error.message); }
  }

  async function createWhatsAppSession() {
    const button = $("#createWhatsAppSessionButton");
    if (state.whatsappSessions.length >= state.whatsappSessionLimit) {
      showToast("Batas session paket Anda sudah tercapai.");
      return;
    }
    button.disabled = true;
    try {
      const created = await api("/sessions", { method: "POST", body: JSON.stringify({}) });
      const sessionId = created.session && created.session.session_id;
      if (!sessionId) throw new Error("Server tidak mengembalikan session baru.");
      // [MODIFIED] Keep the current connected account active while the new account is only pairing.
      pendingWhatsAppSessionId = sessionId;
      await api("/sessions/" + enc(sessionId) + "/connect", { method: "POST" });
      await loadWhatsAppSessions();
      await showWhatsAppSessionQr(sessionId);
      renderWhatsAppSessions();
    } catch (error) {
      if (pendingWhatsAppSessionId) {
        const failedSessionId = pendingWhatsAppSessionId;
        pendingWhatsAppSessionId = null;
        await api("/sessions/" + enc(failedSessionId), {
          method: "DELETE",
          headers: { "X-WAGRAM-Session-ID": failedSessionId }
        }).catch(() => {});
      }
      showToast(error.message);
      await loadWhatsAppSessions().catch(() => {});
    } finally { button.disabled = false; }
  }

  let whatsappQrPollTimer = null;

  async function showWhatsAppSessionQr(sessionId) {
    openWhatsAppSessions();
    // [MODIFIED] Show a focused QR popup instead of the account manager list.
    $("#whatsappSessionsModal").classList.add("is-pairing");
    $("#whatsappSessionsTitle").textContent = "Tambah WhatsApp";
    $("#closeWhatsAppSessions").setAttribute("aria-label", "Cancel pairing");
    $("#whatsappSessionQrWrap").classList.remove("hidden");
    const refreshQr = async () => {
      try {
        const data = await api("/sessions/" + enc(sessionId) + "/connection");
        if (data.status === "connected") {
          // [MODIFIED] Activate the new account only after pairing has actually succeeded.
          if (pendingWhatsAppSessionId === sessionId) pendingWhatsAppSessionId = null;
          state.activeSessionId = sessionId;
          localStorage.setItem("wagram-active-whatsapp-session", sessionId);
          if (whatsappQrPollTimer) clearInterval(whatsappQrPollTimer);
          whatsappQrPollTimer = null;
          $("#whatsappSessionQrWrap").classList.add("hidden");
          await loadWhatsAppSessions();
          await loadWhatsAppAccount();
          renderNotificationPreferences();
          renderWhatsAppSessions();
          closeWhatsAppSessions();
          showToast("WhatsApp berhasil terhubung");
          return;
        }
        if (data.qr) {
          const image = $("#whatsappSessionQrImage");
          if (image.src !== data.qr) image.src = data.qr;
          $("#whatsappSessionQrStatus").textContent = "Pindai QR melalui WhatsApp → Perangkat tertaut";
        } else {
          $("#whatsappSessionQrStatus").textContent = "QR sedang disiapkan. Tunggu beberapa detik.";
        }
      } catch (error) { $("#whatsappSessionQrStatus").textContent = error.message; }
    };
    if (whatsappQrPollTimer) clearInterval(whatsappQrPollTimer);
    await refreshQr();
    whatsappQrPollTimer = setInterval(refreshQr, 1800);
  }

  async function connectSelectedWhatsAppSession() {
    const id = state.activeSessionId;
    if (!id) return;
    try {
      await api("/sessions/" + enc(id) + "/connect", { method: "POST" });
      await showWhatsAppSessionQr(id);
      await loadWhatsAppAccount();
    } catch (error) { showToast(error.message); }
  }

  // [ADDED] Disconnect only the account whose own Profile row was selected.
  async function disconnectWhatsAppSession(sessionId) {
    const session = state.whatsappSessions.find((item) => item.session_id === sessionId);
    if (!session) return;
    if (!(await confirmAction("Putuskan koneksi " + (session.label || "WhatsApp") + "?"))) return;
    try {
      await api("/sessions/" + enc(sessionId) + "/disconnect", {
        method: "POST",
        body: JSON.stringify({}),
        headers: { "X-WAGRAM-Session-ID": sessionId }
      });
      showToast("Akun WhatsApp berhasil diputuskan.");
      await loadWhatsAppSessions();
      if (state.activeSessionId === sessionId) await loadWhatsAppAccount();
    } catch (error) {
      showToast(error.message);
    }
  }

  async function deleteSelectedWhatsAppSession() {
    const session = state.whatsappSessions.find((item) => item.session_id === state.activeSessionId);
    if (!session || session.is_primary) { showToast("Session utama tidak dapat dihapus."); return; }
    if (!(await confirmAction("Hapus session WhatsApp ini?"))) return;
    try {
      await api("/sessions/" + enc(session.session_id), { method: "DELETE" });
      const primary = state.whatsappSessions.find((item) => item.is_primary);
      state.activeSessionId = primary ? primary.session_id : null;
      if (state.activeSessionId) localStorage.setItem("wagram-active-whatsapp-session", state.activeSessionId);
      await loadWhatsAppAccount();
      await Promise.all([loadChats(), loadCalls(), loadContacts()]);
      showToast("Session dihapus");
    } catch (error) { showToast(error.message); }
  }

  /* ---------------------------------------------------------
     Event
     --------------------------------------------------------- */

  function bindEvents() {
    // [MODIFIED] Use document-level delegation so the Premium trigger remains reliable
    // even if another optional control fails to initialize earlier in this function.
    document.addEventListener("click", (event) => {
      const premiumMediaButton = event.target.closest("[data-premium-media]");
      if (premiumMediaButton) {
        event.preventDefault();
        openPremiumSheet();
        return;
      }

      const addSessionButton = event.target.closest("#addWhatsAppSessionButton");
      if (addSessionButton) {
        event.preventDefault();
        if (state.whatsappSessions.length >= state.whatsappSessionLimit) {
          openPremiumSheet();
        } else {
          createWhatsAppSession();
        }
        return;
      }
      const accountSettingsButton = event.target.closest("[data-account-settings]");
      if (accountSettingsButton) {
        selectWhatsAppSession(accountSettingsButton.dataset.accountSettings).then(() => {
          const panel = $("#whatsappAccountControls");
          panel.classList.remove("is-collapsed");
          $("#whatsappControlsToggle").setAttribute("aria-expanded", "true");
          renderNotificationPreferences();
        });
        return;
      }
      const accountDisconnectButton = event.target.closest("[data-account-disconnect]");
      if (accountDisconnectButton) {
        disconnectWhatsAppSession(accountDisconnectButton.dataset.accountDisconnect);
        return;
      }
      if (event.target.closest("#closeWhatsAppSessions") || event.target.closest("#whatsappSessionBackdrop") || event.target.closest("#cancelWhatsAppPairingButton")) { closeWhatsAppSessions(); return; }
      const sessionItem = event.target.closest("[data-session-select]");
      if (sessionItem) { selectWhatsAppSession(sessionItem.dataset.sessionSelect); return; }
      if (event.target.closest("#createWhatsAppSessionButton")) {
        if (state.whatsappSessions.length >= state.whatsappSessionLimit) {
          closeWhatsAppSessions();
          openPremiumSheet();
        } else {
          createWhatsAppSession();
        }
        return;
      }
      if (event.target.closest("#whatsappSessionConnectButton")) { connectSelectedWhatsAppSession(); return; }
      if (event.target.closest("#whatsappSessionDeleteButton")) { deleteSelectedWhatsAppSession(); return; }

      const upgradeButton = event.target.closest("#upgradePremiumButton");
      if (!upgradeButton) return;
      event.preventDefault();
      openPremiumSheet();
    });

    // [ADDED] Animated global search control in the top bar.
    $("#searchToggleButton").addEventListener("click", () => {
      if ($("#topbar").classList.contains("search-open")) {
        closeTopbarSearch();
      } else {
        openTopbarSearch();
      }
    });
    $("#topbarSearchInput").addEventListener("input", handleTopbarSearch);
    $("#topbarSearchInput").addEventListener("keydown", (event) => {
      if (event.key === "Escape") closeTopbarSearch();
    });

    // [ADDED] Clear search text from the X inside the expanded input.
    $("#topbarSearchClear").addEventListener("click", () => {
      $("#topbarSearchInput").value = "";
      handleTopbarSearch();
      $("#topbarSearchInput").focus();
    });

    // [ADDED] Close expanded search when tapping anywhere outside its control.
    document.addEventListener("click", (event) => {
      if (!$("#topbar").classList.contains("search-open")) return;
      if (event.target.closest("#topbarSearchWrap")) return;
      closeTopbarSearch(false);
    });

    $("#backButton").addEventListener("click", () => setPage("chats"));

    // Tema
    $("#themeButton").addEventListener("click", () => {
      setThemePref(resolveScheme() === "dark" ? "light" : "dark");
    });

    // [ADDED] Profile theme control mirrors the global light/dark toggle.
    $("#profileThemeButton").addEventListener("click", () => {
      setThemePref(resolveScheme() === "dark" ? "light" : "dark");
    });

    // [ADDED] Open the Premium plan selector from the Profile page.
    const premiumSheet = $("#premiumPage");
    let selectedPremiumPeriod = "3d";
    const premiumPlans = {
      "3d": {
        label: "PREMIUM 3 HARI",
        oldPrice: "Rp24.000",
        price: "Rp14.000",
        note: "Harga spesial untuk langganan pertama",
        sessions: 2,
        sessionDescription: "Hubungkan hingga 2 akun WhatsApp secara bersamaan."
      },
      "7d": {
        label: "PREMIUM 7 HARI",
        oldPrice: "Rp56.000",
        price: "Rp44.000",
        note: "Akses Premium selama 7 hari",
        sessions: 3,
        sessionDescription: "Hubungkan hingga 3 akun WhatsApp secara bersamaan."
      },
      "30d": {
        label: "PREMIUM 30 HARI",
        oldPrice: "Rp240.000",
        price: "Rp149.000",
        note: "Akses Premium selama 30 hari",
        sessions: 5,
        sessionDescription: "Hubungkan hingga 5 akun WhatsApp secara bersamaan."
      }
    };

    function renderPremiumPlan(period) {
      selectedPremiumPeriod = period;
      const plan = premiumPlans[period];
      $("#premiumPlanLabel").textContent = plan.label;
      $("#premiumOldPrice").textContent = plan.oldPrice;
      $("#premiumOldPrice").hidden = !plan.oldPrice;
      $("#premiumCurrentPrice").textContent = plan.price;
      $("#premiumPriceNote").textContent = plan.note;
      $("#premiumSessionCount").textContent = `${plan.sessions} WhatsApp session`;
      $("#premiumSessionDescription").textContent = plan.sessionDescription;
      $("#premiumTableSessions").textContent = String(plan.sessions);
      $("#premiumButtonOldPrice").textContent = plan.oldPrice;
      $("#premiumButtonOldPrice").hidden = !plan.oldPrice;
      $("#premiumButtonCurrentPrice").textContent = `Lanjutkan · ${plan.price}`;
      document.querySelectorAll("[data-period]").forEach((tab) => {
        const active = tab.dataset.period === period;
        tab.classList.toggle("active", active);
        tab.setAttribute("aria-selected", String(active));
      });
    }

    function openPremiumSheet() {
      renderPremiumPlan("3d");
      setPage("premium");
      tg?.BackButton?.show?.();
    }

    function closePremiumSheet() {
      setPage("account");
      tg?.BackButton?.show?.();
    }

    $("#premiumBackButton").addEventListener("click", closePremiumSheet);

    $("#premiumDurationTabs").addEventListener("click", (event) => {
      const tab = event.target.closest("[data-period]");
      if (tab && premiumPlans[tab.dataset.period]) renderPremiumPlan(tab.dataset.period);
    });
    // [MODIFIED] Request a server-generated QRIS order and render its raw payload.
    $("#premiumContinueButton").addEventListener("click", async () => {
      const plan = premiumPlans[selectedPremiumPeriod];
      const button = $("#premiumContinueButton");
      const canvas = $("#premiumPaymentQr");
      button.disabled = true;
      $("#premiumPaymentPlan").textContent = plan.label;
      $("#premiumPaymentAmount").textContent = "Menyiapkan…";
      $("#premiumPaymentUniqueCode").textContent = "Membuat pesanan pembayaran";
      $("#premiumPaymentStatus").textContent = "Menghubungi server…";
      $("#premiumPaymentModal").classList.remove("hidden");
      document.body.classList.add("premium-payment-open");

      try {
        const result = await api("/premium/orders", {
          method: "POST",
          body: JSON.stringify({ period: selectedPremiumPeriod })
        });
        if (!result.rawQris || !result.qrDataUrl || !result.order?.amount) {
          throw new Error("Server tidak mengirim data QRIS yang valid.");
        }

        const order = result.order;
        activePremiumOrderId = order.id;
        $("#premiumPaymentDownloadButton").disabled = false;
        $("#premiumPaymentPaidButton").disabled = false;
        $("#premiumPaymentPaidButton").textContent = "Saya sudah bayar";
        $("#premiumPaymentConfirmation").textContent = "";
        $("#premiumPaymentAmount").textContent = new Intl.NumberFormat("id-ID", {
          style: "currency",
          currency: "IDR",
          maximumFractionDigits: 0
        }).format(order.amount);
        $("#premiumPaymentUniqueCode").textContent = "Kode unik: " + order.uniqueCode;
        const qrImage = new Image();
        await new Promise((resolve, reject) => {
          qrImage.onload = resolve;
          qrImage.onerror = reject;
          qrImage.src = result.qrDataUrl;
        });
        const context = canvas.getContext("2d");
        context.clearRect(0, 0, canvas.width, canvas.height);
        context.drawImage(qrImage, 0, 0, canvas.width, canvas.height);
        $("#premiumPaymentStatus").textContent = "QRIS siap dipindai";
      } catch (error) {
        const context = canvas.getContext("2d");
        context.clearRect(0, 0, canvas.width, canvas.height);
        activePremiumOrderId = null;
        $("#premiumPaymentDownloadButton").disabled = true;
        $("#premiumPaymentPaidButton").disabled = true;
        $("#premiumPaymentAmount").textContent = "—";
        $("#premiumPaymentUniqueCode").textContent = "";
        $("#premiumPaymentStatus").textContent = error.message || "QRIS gagal dimuat.";
      } finally {
        button.disabled = false;
      }
    });
    // [MODIFIED] Keep the current server-created order for download and payment reporting.
    let activePremiumOrderId = null;
    const downloadPremiumQr = async () => {
      const sourceCanvas = $("#premiumPaymentQr");
      const exportCanvas = document.createElement("canvas");
      exportCanvas.width = sourceCanvas.width;
      exportCanvas.height = sourceCanvas.height;
      const context = exportCanvas.getContext("2d");

      if (!context || !sourceCanvas.width || !sourceCanvas.height) {
        throw new Error("Gambar QRIS belum siap diunduh.");
      }

      // [MODIFIED] Export the QR and centered WAGRAM logo as a single PNG.
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, exportCanvas.width, exportCanvas.height);
      context.drawImage(sourceCanvas, 0, 0, exportCanvas.width, exportCanvas.height);

      const logo = $("#premiumPaymentModal .premium-payment-logo");
      if (logo?.complete && logo.naturalWidth > 0) {
        const tileSize = Math.round(exportCanvas.width * 0.207);
        const tileX = Math.round((exportCanvas.width - tileSize) / 2);
        const tileY = Math.round((exportCanvas.height - tileSize) / 2);
        const radius = Math.round(tileSize * 0.18);
        const logoPadding = Math.round(tileSize * 0.12);

        context.save();
        context.beginPath();
        if (typeof context.roundRect === "function") {
          context.roundRect(tileX, tileY, tileSize, tileSize, radius);
        } else {
          context.rect(tileX, tileY, tileSize, tileSize);
        }
        context.fillStyle = "#092016";
        context.fill();
        context.lineWidth = Math.max(2, Math.round(exportCanvas.width * 0.01));
        context.strokeStyle = "#ffffff";
        context.stroke();
        context.drawImage(
          logo,
          tileX + logoPadding,
          tileY + logoPadding,
          tileSize - logoPadding * 2,
          tileSize - logoPadding * 2
        );
        context.restore();
      }

      // [MODIFIED] Use Telegram's native file download API instead of a WebView blob download.
      const imageData = exportCanvas.toDataURL("image/png");
      const prepared = await api("/premium/orders/" + encodeURIComponent(activePremiumOrderId) + "/qr-download", {
        method: "POST",
        body: JSON.stringify({ imageData })
      });
      if (!prepared.downloadUrl) throw new Error("Server tidak menyiapkan file QRIS.");

      const downloadUrl = new URL(prepared.downloadUrl, new URL(API_BASE, window.location.href)).toString();
      if (tg?.downloadFile && (!tg.isVersionAtLeast || tg.isVersionAtLeast("8.0"))) {
        tg.downloadFile({
          url: downloadUrl,
          file_name: "WAGRAM-Premium-QRIS.png"
        }, (accepted) => {
          $("#premiumPaymentStatus").textContent = accepted
            ? "Download QRIS dimulai."
            : "Download QRIS dibatalkan.";
        });
        return;
      }

      // [ADDED] Fallback for older Telegram clients: open the attachment URL in the browser.
      if (tg?.openLink) {
        tg.openLink(downloadUrl);
      } else {
        window.location.href = downloadUrl;
      }
    };

    $("#premiumPaymentDownloadButton").addEventListener("click", async () => {
      if (!activePremiumOrderId) {
        $("#premiumPaymentStatus").textContent = "QRIS belum siap diunduh.";
        return;
      }
      const button = $("#premiumPaymentDownloadButton");
      const originalLabel = button.textContent;
      button.disabled = true;
      button.textContent = "Menyiapkan gambar…";
      try {
        await downloadPremiumQr();
        $("#premiumPaymentStatus").textContent = "Gambar QRIS siap disimpan.";
      } catch (error) {
        if (error?.name !== "AbortError") {
          $("#premiumPaymentStatus").textContent = error.message || "Gagal mengunduh QRIS.";
        }
      } finally {
        button.disabled = false;
        button.textContent = originalLabel;
      }
    });

    // [ADDED] Require an image proof before the user can report a Premium payment.
    let selectedPremiumProof = null;
    const proofModal = $("#premiumProofModal");
    const proofInput = $("#premiumProofInput");
    const proofPreview = $("#premiumProofPreview");
    const proofPlaceholder = $("#premiumProofPlaceholder");
    const proofConfirmButton = $("#premiumProofConfirmButton");

    $("#premiumPaymentPaidButton").addEventListener("click", () => {
      if (!activePremiumOrderId) return;
      selectedPremiumProof = null;
      proofInput.value = "";
      proofPreview.removeAttribute("src");
      proofPreview.classList.add("hidden");
      proofPlaceholder.classList.remove("hidden");
      proofConfirmButton.disabled = true;
      $("#premiumProofError").textContent = "";
      proofModal.classList.remove("hidden");
    });

    proofInput.addEventListener("change", () => {
      const file = proofInput.files?.[0] || null;
      selectedPremiumProof = null;
      proofConfirmButton.disabled = true;
      $("#premiumProofError").textContent = "";
      if (!file) return;
      if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
        $("#premiumProofError").textContent = "Format gambar harus JPG, PNG, atau WEBP.";
        proofInput.value = "";
        return;
      }
      if (file.size > 5 * 1024 * 1024) {
        $("#premiumProofError").textContent = "Ukuran gambar maksimal 5 MB.";
        proofInput.value = "";
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        selectedPremiumProof = String(reader.result || "");
        proofPreview.src = selectedPremiumProof;
        proofPreview.classList.remove("hidden");
        proofPlaceholder.classList.add("hidden");
        proofConfirmButton.disabled = false;
      };
      reader.onerror = () => {
        $("#premiumProofError").textContent = "Gambar gagal dibaca. Silakan pilih ulang.";
      };
      reader.readAsDataURL(file);
    });

    $("#premiumProofCancelButton").addEventListener("click", () => {
      proofModal.classList.add("hidden");
      selectedPremiumProof = null;
    });

    proofModal.addEventListener("click", (event) => {
      if (event.target === proofModal) {
        proofModal.classList.add("hidden");
        selectedPremiumProof = null;
      }
    });

    proofConfirmButton.addEventListener("click", async () => {
      if (!activePremiumOrderId || !selectedPremiumProof) return;
      const paidButton = $("#premiumPaymentPaidButton");
      proofConfirmButton.disabled = true;
      $("#premiumProofCancelButton").disabled = true;
      proofConfirmButton.textContent = "Mengirim…";
      $("#premiumProofError").textContent = "";
      try {
        await api("/premium/orders/" + encodeURIComponent(activePremiumOrderId) + "/paid", {
          method: "POST",
          body: JSON.stringify({ proofImage: selectedPremiumProof })
        });
        proofModal.classList.add("hidden");
        paidButton.disabled = true;
        paidButton.textContent = "Konfirmasi terkirim";
        $("#premiumPaymentConfirmation").textContent = "Bukti pembayaran terkirim. Premium aktif setelah diverifikasi admin.";
      } catch (error) {
        $("#premiumProofError").textContent = error.message || "Bukti pembayaran gagal dikirim.";
      } finally {
        proofConfirmButton.disabled = !selectedPremiumProof;
        $("#premiumProofCancelButton").disabled = false;
        proofConfirmButton.textContent = "Confirm";
      }
    });

    // [MODIFIED] Close the payment dialog without navigating away from Premium.
    function closePremiumPaymentModal() {
      $("#premiumPaymentModal").classList.add("hidden");
      document.body.classList.remove("premium-payment-open");
    }
    $("#premiumPaymentBackButton").addEventListener("click", closePremiumPaymentModal);
    $("#premiumPaymentModal").addEventListener("click", (event) => {
      if (event.target === $("#premiumPaymentModal")) closePremiumPaymentModal();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !$("#premiumPaymentModal").classList.contains("hidden")) {
        closePremiumPaymentModal();
      }
    });

    // [ADDED] Expand or collapse all WhatsApp account controls from the status row.
    $("#whatsappControlsToggle").addEventListener("click", () => {
      const panel = $("#whatsappAccountControls");
      const collapsed = panel.classList.toggle("is-collapsed");
      $("#whatsappControlsToggle").setAttribute("aria-expanded", String(!collapsed));
      $("#whatsappControlsToggle").setAttribute(
        "aria-label",
        collapsed ? "Buka pengaturan akun WhatsApp" : "Tutup pengaturan akun WhatsApp"
      );
    });

    // [ADDED] Expand or collapse notification preferences within the same card.
    $("#notificationCardToggle").addEventListener("click", () => {
      // [MODIFIED] The notification dropdown now belongs to the embedded WhatsApp card.
      const section = $("#notificationCardToggle").closest(".embedded-notification-section");
      const collapsed = section.classList.toggle("is-collapsed");
      $("#notificationCardToggle").setAttribute("aria-expanded", String(!collapsed));
    });


    // [ADDED] Confirm each cleanup action before deleting account-owned records.
    $("#historyCleanupOptions").addEventListener("click", async (event) => {
      const button = event.target.closest("[data-cleanup]");
      if (!button || button.disabled) return;

      const type = button.dataset.cleanup;
      const confirmations = {
        media: "Hapus semua media tersimpan? Pesan teks dan riwayat chat tetap ada.",
        messages: "Hapus seluruh riwayat pesan? Daftar chat tetap ada, tetapi isi percakapan tidak dapat dipulihkan.",
        calls: "Hapus seluruh riwayat panggilan? Tindakan ini tidak dapat dibatalkan.",
        contacts: "Hapus semua kontak manual yang tersimpan di WAGRAM? Tindakan ini tidak dapat dibatalkan.",
        cache: "Bersihkan cache media sementara di perangkat ini?"
      };

      if (!confirmations[type]) return;
      if (!(await confirmAction(confirmations[type]))) return;

      button.disabled = true;
      try {
        if (type === "cache") {
          clearMediaCache();
          showToast("Cache media sementara berhasil dibersihkan.");
          return;
        }

        const cleanupSessionId = state.activeSessionId;
        const result = await api("/data/cleanup", {
          method: "POST",
          body: JSON.stringify({ type }),
          headers: cleanupSessionId ? { "X-WAGRAM-Session-ID": cleanupSessionId } : {}
        });

        clearMediaCache();

        if (type === "messages") {
          state.chatsLoaded = false;
          state.chats = [];
          if (state.page === "chats") loadChats();
        } else if (type === "calls") {
          state.callsLoaded = false;
          state.calls = [];
          if (state.page === "calls") loadCalls();
        } else if (type === "contacts") {
          state.contactsLoaded = false;
          state.contacts = [];
          if (state.page === "contacts") loadContacts();
        }

        const count = Number(result.deleted || 0);
        const names = {
          media: "media",
          messages: "pesan",
          calls: "riwayat panggilan",
          contacts: "kontak"
        };
        showToast(count > 0
          ? `${count} data ${names[type]} berhasil dihapus.`
          : `Tidak ada ${names[type]} yang perlu dihapus.`);
      } catch (error) {
        showToast(error.message || "Penghapusan data gagal.");
      } finally {
        button.disabled = false;
      }
    });

    // [ADDED] Expand or collapse the history and data cleanup list.
    $("#historyCleanupToggle").addEventListener("click", () => {
      const section = $("#historyCleanupToggle").closest(".embedded-history-section");
      const collapsed = section.classList.toggle("is-collapsed");
      $("#historyCleanupToggle").setAttribute("aria-expanded", String(!collapsed));
    });

    // [ADDED] Notification switches are saved locally on this device.
    $("#notificationOptions").addEventListener("click", (event) => {
      const button = event.target.closest("[data-notification]");
      if (!button) return;
      const key = button.dataset.notification;
      if (!isPremiumMembership() && isPremiumNotification(key)) {
        openPremiumSheet();
        return;
      }
      toggleNotificationPreference(button);
    });

    // [MODIFIED] Pair the currently selected WhatsApp session.
    $("#accountWhatsAppState").addEventListener("click", async () => {
      const button = $("#accountWhatsAppState");
      if (button.disabled) return;
      button.disabled = true;
      button.classList.add("is-connecting");
      button.innerHTML = "<i></i> Connecting…";
      try {
        await api("/sessions/" + enc(state.activeSessionId) + "/connect", { method: "POST" });
        await showWhatsAppSessionQr(state.activeSessionId);
        await loadWhatsAppAccount();
      } catch (error) { showToast(error.message); await loadWhatsAppAccount(); }
    });

    // [ADDED] Restore the profile status only after the pairing flow confirms success.
    window.addEventListener("wagram:connected", () => {
      loadWhatsAppAccount();
    });

    // [ADDED] Disconnect the currently linked WhatsApp session.
    $("#disconnectWhatsAppButton").addEventListener("click", async () => {
      if (!window.confirm("Putuskan koneksi WhatsApp dari WAGRAM?")) return;
      const button = $("#disconnectWhatsAppButton");
      button.disabled = true;
      try {
        await api("/sessions/" + enc(state.activeSessionId) + "/disconnect", { method: "POST", body: JSON.stringify({}) });
        showToast("WhatsApp berhasil diputuskan.");
        await loadWhatsAppAccount();
      } catch (error) {
        showToast(error.message);
        await loadWhatsAppAccount();
      }
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
      // [ADDED] Open the current conversation in WhatsApp; the View Once media remains protected.
      const viewOnceButton = event.target.closest("[data-view-once-open]");
      if (viewOnceButton) {
        event.stopPropagation();
        const phone = state.currentChat?.phone_number;
        if (!phone) {
          showToast("Buka percakapan ini langsung dari WhatsApp untuk melihat media sekali lihat.");
          return;
        }
        openWhatsApp(phone);
        return;
      }

      const profile = event.target.closest("[data-profile-jid]");
      if (profile) {
        openProfile(profile.dataset.profileJid, profile.dataset.profileName);
        return;
      }

      const editedMessage = event.target.closest(".message-history-group[data-edit-expandable='true']");
      if (editedMessage) {
        editedMessage.classList.toggle("show-original");
        return;
      }

      const img = event.target.closest("[data-media-img]");

      if (img) {
        if (img.getAttribute("src") && !img.closest(".sticker")) {
          openLightbox(img.src);
        }

        return;
      }

      const video = event.target.closest("[data-media-video]");

      if (video) {
        playVideo(video);
        return;
      }

      const audio = event.target.closest("[data-media-audio]");
      if (audio) {
        playAudio(audio);
        return;
      }

      const documentFile = event.target.closest("[data-media-document]");
      if (documentFile) openDocument(documentFile);
    });

    $("#lightbox").addEventListener("click", closeLightbox);
    // [MODIFIED] Save the current chat number to WAGRAM contacts.
    $("#saveChatContactButton").addEventListener("click", () => {
      const chat = state.currentChat;
      if (!chat?.phone_number) {
        showToast("Nomor telepon tidak tersedia.");
        return;
      }
      openContactSheet(null, {
        name: chatName(chat),
        phone: chat.phone_number
      });
    });

    // [MODIFIED] Open a direct WhatsApp conversation with this contact.
    $("#openChatWhatsAppButton").addEventListener("click", () => {
      const chat = state.currentChat;
      if (!chat?.phone_number) {
        showToast("Nomor telepon tidak tersedia.");
        return;
      }
      openWhatsApp(chat.phone_number);
    });

    $("#messagesNav").addEventListener("click", () => setPage("chats"));
    $("#callsNav").addEventListener("click", () => setPage("calls"));
    $("#contactsNav").addEventListener("click", () => setPage("contacts"));
    $("#profileNav").addEventListener("click", () => setPage("account"));
    updateTopbarTitle();
    $("#backToMessagesCalls").addEventListener("click", () => setPage("chats"));
    $("#backToMessagesContacts").addEventListener("click", () => setPage("chats"));

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

    // [MODIFIED] Chat rows support long-press and left-swipe to reveal one archive action.
    let chatPressTimer = null;
    let chatPointerStart = null;
    let suppressChatClick = false;

    $("#chatList").addEventListener("pointerdown", (event) => {
      const row = event.target.closest(".chat-swipe-row");
      if (!row || event.target.closest("button[data-archive-chat]")) return;

      chatPointerStart = { row, x: event.clientX, y: event.clientY, revealed: row.classList.contains("is-revealed") };
      clearTimeout(chatPressTimer);
      chatPressTimer = setTimeout(() => {
        row.classList.add("is-revealed");
        suppressChatClick = true;
      }, 430);
    });

    $("#chatList").addEventListener("pointermove", (event) => {
      if (!chatPointerStart) return;
      const dx = event.clientX - chatPointerStart.x;
      const dy = event.clientY - chatPointerStart.y;
      if (Math.abs(dy) > 12 && Math.abs(dy) > Math.abs(dx)) {
        clearTimeout(chatPressTimer);
        return;
      }
      if (dx < -38) {
        clearTimeout(chatPressTimer);
        chatPointerStart.row.classList.add("is-revealed");
        suppressChatClick = true;
      } else if (dx > 38 && chatPointerStart.revealed) {
        clearTimeout(chatPressTimer);
        chatPointerStart.row.classList.remove("is-revealed");
        suppressChatClick = true;
      }
    });

    const finishChatPointer = () => {
      clearTimeout(chatPressTimer);
      chatPressTimer = null;
      chatPointerStart = null;
    };
    $("#chatList").addEventListener("pointerup", finishChatPointer);
    $("#chatList").addEventListener("pointercancel", finishChatPointer);

    $("#chatList").addEventListener("click", (event) => {
      const favorite = event.target.closest("[data-favorite-chat]");
      if (favorite) {
        event.stopPropagation();
        toggleFavoriteFromList(favorite.dataset.favoriteChat, favorite);
        return;
      }

      const archive = event.target.closest("[data-archive-chat]");
      if (archive) {
        event.stopPropagation();
        archiveChatFromList(archive.dataset.archiveChat, archive);
        return;
      }

      const row = event.target.closest("[data-chat]");
      if (!row) return;

      if (row.dataset.premiumChat === "true") {
        event.preventDefault();
        openPremiumSheet();
        return;
      }

      const wrapper = row.closest(".chat-swipe-row");
      if (suppressChatClick) {
        suppressChatClick = false;
        return;
      }
      if (wrapper?.classList.contains("is-revealed")) {
        wrapper.classList.remove("is-revealed");
        return;
      }
      openChat(row.dataset.chat);
    });

    // [ADDED] Open the active chat or group profile from its header.
    $("#conversationHeader").addEventListener("click", (event) => {
      const target = event.target.closest("[data-profile-jid]");
      if (target) openProfile(target.dataset.profileJid, target.dataset.profileName, state.currentChat?.phone_number || "");
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

    // [MODIFIED] Call cards reveal favorite and archive actions on long-press or left-swipe.
    let callPressTimer = null;
    let callPointerStart = null;
    let suppressCallClick = false;

    $("#callsList").addEventListener("pointerdown", (event) => {
      const row = event.target.closest(".call-swipe-row");
      if (!row || event.target.closest("button")) return;
      callPointerStart = { row, x: event.clientX, y: event.clientY, revealed: row.classList.contains("is-revealed") };
      clearTimeout(callPressTimer);
      callPressTimer = setTimeout(() => { row.classList.add("is-revealed"); suppressCallClick = true; }, 430);
    });

    $("#callsList").addEventListener("pointermove", (event) => {
      if (!callPointerStart) return;
      const dx = event.clientX - callPointerStart.x;
      const dy = event.clientY - callPointerStart.y;
      if (Math.abs(dy) > 12 && Math.abs(dy) > Math.abs(dx)) { clearTimeout(callPressTimer); return; }
      if (dx < -38) {
        clearTimeout(callPressTimer);
        callPointerStart.row.classList.add("is-revealed");
        suppressCallClick = true;
      } else if (dx > 38 && callPointerStart.revealed) {
        clearTimeout(callPressTimer);
        callPointerStart.row.classList.remove("is-revealed");
        suppressCallClick = true;
      }
    });

    const finishCallPointer = () => { clearTimeout(callPressTimer); callPressTimer = null; callPointerStart = null; };
    $("#callsList").addEventListener("pointerup", finishCallPointer);
    $("#callsList").addEventListener("pointercancel", finishCallPointer);

    // [MODIFIED] Call favorite/archive actions update the call record itself, never a WhatsApp chat.
    async function updateCallAction(callId, action) {
      const call = state.calls.find((item) => String(item.id) === String(callId));
      if (!call) return;

      try {
        if (action === "favorite") {
          const favorite = !Boolean(call.is_favorite);
          await api(`/calls/${enc(callId)}/favorite`, {
            method: "PUT",
            body: JSON.stringify({ favorite })
          });
          showToast(favorite ? "Panggilan ditambahkan ke favorit" : "Panggilan dihapus dari favorit");
        } else {
          await api(`/calls/${enc(callId)}/archive`, {
            method: "PUT",
            body: JSON.stringify({ archived: true })
          });
          showToast("Riwayat panggilan diarsipkan");
        }
        await loadCalls();
      } catch (error) {
        showToast(error.message);
      }
    }

    $("#callsList").addEventListener("click", async (event) => {
      const save = event.target.closest("[data-save-call]");
      if (save) {
        event.stopPropagation();
        const call = state.calls.find((item) => String(item.id) === save.dataset.saveCall);
        if (!call?.phone_number) { showToast("Nomor telepon tidak tersedia."); return; }

        // [MODIFIED] The same person-plus action opens add or edit contact, even when already saved.
        if (!state.contactsLoaded) await loadContacts();
        const digits = String(call.phone_number).replace(/\D/g, "");
        const contact = state.contacts.find((item) =>
          String(item.phone_number || "").replace(/\D/g, "") === digits
        );
        openContactSheet(contact || null, {
          name: contact?.name || call.display_name,
          phone: call.phone_number
        });
        return;
      }
      const favorite = event.target.closest("[data-call-favorite]");
      if (favorite) { event.stopPropagation(); updateCallAction(favorite.dataset.callFavorite, "favorite"); return; }
      const archive = event.target.closest("[data-call-archive]");
      if (archive) { event.stopPropagation(); updateCallAction(archive.dataset.callArchive, "archive"); return; }
      const row = event.target.closest(".call-swipe-row");
      if (!row) return;
      if (suppressCallClick) { suppressCallClick = false; return; }
      if (row.classList.contains("is-revealed")) row.classList.remove("is-revealed");
    });

    // Kontak
    $("#addContactButton").addEventListener("click", () => openContactSheet());

    $("#contactsSearchInput").addEventListener("input", (event) => {
      state.contactSearch = event.target.value;
      renderContacts();
    });

    // [ADDED] Contact cards reveal WhatsApp, Edit and Delete actions on long-press or left swipe.
    let contactPressTimer = null;
    let contactPointerStart = null;
    let suppressContactClick = false;

    $("#contactsList").addEventListener("pointerdown", (event) => {
      const row = event.target.closest(".contact-swipe-row");
      if (!row || event.target.closest("button")) return;
      contactPointerStart = { row, x: event.clientX, y: event.clientY, revealed: row.classList.contains("is-revealed") };
      clearTimeout(contactPressTimer);
      contactPressTimer = setTimeout(() => {
        row.classList.add("is-revealed");
        suppressContactClick = true;
      }, 430);
    });

    $("#contactsList").addEventListener("pointermove", (event) => {
      if (!contactPointerStart) return;
      const dx = event.clientX - contactPointerStart.x;
      const dy = event.clientY - contactPointerStart.y;
      if (Math.abs(dy) > 12 && Math.abs(dy) > Math.abs(dx)) {
        clearTimeout(contactPressTimer);
        return;
      }
      if (dx < -38) {
        clearTimeout(contactPressTimer);
        contactPointerStart.row.classList.add("is-revealed");
        suppressContactClick = true;
      } else if (dx > 38 && contactPointerStart.revealed) {
        clearTimeout(contactPressTimer);
        contactPointerStart.row.classList.remove("is-revealed");
        suppressContactClick = true;
      }
    });

    const finishContactPointer = () => {
      clearTimeout(contactPressTimer);
      contactPressTimer = null;
      contactPointerStart = null;
    };
    $("#contactsList").addEventListener("pointerup", finishContactPointer);
    $("#contactsList").addEventListener("pointercancel", finishContactPointer);

    $("#contactsList").addEventListener("click", (event) => {
      if (event.target.closest("[data-add-contact]")) {
        openContactSheet();
        return;
      }

      const contactRow = event.target.closest(".contact-swipe-row");
      if (contactRow && !event.target.closest("button")) {
        if (suppressContactClick) {
          suppressContactClick = false;
          return;
        }
        if (contactRow.classList.contains("is-revealed")) contactRow.classList.remove("is-revealed");
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

    // [ADDED] Profile sheet dismissal.
    $("#profileSheet").addEventListener("click", (event) => {
      if (event.target.closest("[data-close-profile]")) closeProfileSheet();
    });

    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;

      if (!$("#lightbox").classList.contains("hidden")) {
        closeLightbox();
      } else if (!$("#profileSheet").classList.contains("hidden")) {
        closeProfileSheet();
      } else if (!$("#contactSheet").classList.contains("hidden")) {
        closeContactSheet();
      }
    });
  }

  /* ---------------------------------------------------------
     Telegram & tema
     --------------------------------------------------------- */

  const THEME_KEY = "wagram-theme";

  function getThemePref() {
    try {
      const value = localStorage.getItem(THEME_KEY);

      return ["auto", "light", "dark"].includes(value) ? value : "light";
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

  // "auto" mengikuti tema Telegram, lalu tema perangkat. Default WAGRAM adalah tema terang.
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
    $("#profileThemeButton").innerHTML = icon(scheme === "dark" ? "sun" : "moon");

    const pref = getThemePref();



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
      } else if (!$("#profileSheet").classList.contains("hidden")) {
        closeProfileSheet();
      } else if (!$("#contactSheet").classList.contains("hidden")) {
        closeContactSheet();
      } else if (state.page === "premium") {
        closePremiumSheet();
      } else {
        setPage("chats");
      }
    });
  }

  // [ADDED] WebSocket realtime with a polling fallback for mobile WebViews/proxies.
  let chatRefreshInFlight = false;
  let realtimeSocket = null;
  let realtimeRetryTimer = null;
  let realtimeRetryDelay = 1000;
  let realtimeRefreshTimer = null;
  const pendingRealtimeChatIds = new Set();
  let pendingCallsRefresh = false;
  let pendingConnectionStatus = null;

  function getMessageSignature(messages) {
    return messages.map((message) => [
      message.whatsapp_message_id,
      message.message_timestamp,
      message.body || "",
      message.has_media ? 1 : 0,
      message.media_file_name || ""
    ].join(":")).join("|");
  }

  async function refreshOpenChat() {
    const chatId = state.currentChat?.whatsapp_chat_id;
    if (
      !chatId ||
      chatRefreshInFlight ||
      document.visibilityState !== "visible"
    ) {
      return;
    }

    chatRefreshInFlight = true;

    try {
      const data = await api(`/chats/${enc(chatId)}/messages?limit=200`);

      if (state.currentChat?.whatsapp_chat_id !== chatId) return;

      const messages = data.messages || [];
      const signature = getMessageSignature(messages);

      if (signature !== state.currentChatMessageSignature) {
        state.currentChatMessageSignature = signature;
        state.currentChat = { ...state.currentChat, ...data.chat };
        updateConversationHeader();
        renderMessages(messages, { preservePosition: true });

        // Messages received while this conversation is open are locally read.
        await api(`/chats/${enc(chatId)}/read`, { method: "POST" });

        if (state.currentChat?.whatsapp_chat_id === chatId) {
          await loadChats();
          const openedChat = state.chats.find(
            (chat) => chat.whatsapp_chat_id === chatId
          );
          if (openedChat) openedChat.unread_count = 0;
          state.chatCounts.unread = state.chats.filter(
            (chat) => Number(chat.unread_count) > 0
          ).length;
          updateChatFilterCounts();
          renderChats();
          updateBottomNavBadges();
        }
      }
    } catch (error) {
      console.warn("Could not refresh open Mini App chat:", error.message);
    } finally {
      chatRefreshInFlight = false;
    }
  }

  function scheduleRealtimeRefresh(event) {
    if (event.data?.sessionId && state.activeSessionId && event.data.sessionId !== state.activeSessionId) return;
    if (
      event.type === "message.created" ||
      event.type === "message.deleted" ||
      event.type === "message.edited" ||
      event.type === "media.ready"
    ) {
      if (event.data?.chatId) pendingRealtimeChatIds.add(event.data.chatId);
    } else if (event.type === "calls.updated") {
      pendingCallsRefresh = true;
    } else if (event.type === "connection.status") {
      pendingConnectionStatus = event.data?.status || null;
    } else if (event.type === "membership.updated") {
      // [ADDED] Refresh Premium access immediately after the server changes a user's plan.
      loadMembership();
      if (state.chatsLoaded) loadChats();
    }

    clearTimeout(realtimeRefreshTimer);
    realtimeRefreshTimer = setTimeout(() => {
      if (pendingRealtimeChatIds.size > 0) {
        const chatIds = [...pendingRealtimeChatIds];
        pendingRealtimeChatIds.clear();
        loadChats();

        const currentChatId = state.currentChat?.whatsapp_chat_id;
        if (currentChatId && chatIds.includes(currentChatId)) {
          refreshOpenChat();
        }
      }

      if (pendingCallsRefresh) loadCalls();
      pendingCallsRefresh = false;

      if (pendingConnectionStatus) {
        if (state.page === "account") loadWhatsAppAccount();
        $("#connectionStatus").textContent = pendingConnectionStatus === "connected"
          ? "WhatsApp terhubung"
          : `WhatsApp ${pendingConnectionStatus}`;
        pendingConnectionStatus = null;
      }
    }, 180);
  }

  function connectRealtime() {
    if (!tg?.initData || typeof WebSocket === "undefined") return;
    if (
      realtimeSocket &&
      [WebSocket.CONNECTING, WebSocket.OPEN].includes(realtimeSocket.readyState)
    ) return;

    clearTimeout(realtimeRetryTimer);

    const apiUrl = new URL(API_BASE, window.location.href);
    const socketUrl = new URL("/ws/miniapp", apiUrl.origin);
    socketUrl.protocol = apiUrl.protocol === "https:" ? "wss:" : "ws:";

    const socket = new WebSocket(socketUrl.toString());
    realtimeSocket = socket;

    socket.addEventListener("open", () => {
      realtimeRetryDelay = 1000;
      socket.send(JSON.stringify({
        type: "auth",
        initData: tg.initData
      }));
    });

    socket.addEventListener("message", (message) => {
      try {
        const event = JSON.parse(message.data);
        if (event?.type && event.type !== "connected") {
          scheduleRealtimeRefresh(event);
        }
      } catch {
        /* abaikan payload WebSocket yang tidak valid */
      }
    });

    socket.addEventListener("close", () => {
      if (realtimeSocket === socket) realtimeSocket = null;
      if (document.visibilityState !== "visible") return;

      realtimeRetryTimer = setTimeout(() => {
        connectRealtime();
      }, realtimeRetryDelay);

      realtimeRetryDelay = Math.min(realtimeRetryDelay * 2, 30000);
    });

    socket.addEventListener("error", () => {
      socket.close();
    });
  }

  function handleVisibilityChange() {
    if (document.visibilityState !== "visible") return;

    connectRealtime();

    // [ADDED] One database snapshot after returning from background.
    if (state.chatsLoaded) loadChats();
    if (state.callsLoaded) loadCalls();
    loadMembership(); // [MODIFIED] Always refresh Premium access when returning to the Mini App.
  }


  // [ADDED] Show the two-step introduction once per Telegram account on this device.
  const ONBOARDING_STORAGE_KEY = "wagram-onboarding-completed";
  function initOnboarding() {
    const overlay = $("#wagramOnboarding");
    if (!overlay) return;

    let completed = false;
    let forcePreview = false; // [ADDED] Keep preview flag available after the try block.
    try {
      const telegramUserId = String(tg?.initDataUnsafe?.user?.id || "guest");
      completed = localStorage.getItem(`${ONBOARDING_STORAGE_KEY}:${telegramUserId}`) === "1";
      // [MODIFIED] Admin preview query bypasses the completed flag without resetting it.
      forcePreview = new URLSearchParams(window.location.search).get("previewOnboarding") === "1";
    } catch {
      completed = false;
    }

    // [MODIFIED] Allow an explicit admin preview even when onboarding was already completed.
    if (completed && !forcePreview) return;

    const welcome = $("#onboardingWelcome");
    const plans = $("#onboardingFeatures");
    const dotOne = $("#onboardingDotOne");
    const dotTwo = $("#onboardingDotTwo");

    // [MODIFIED] Two-step onboarding: custom visual welcome followed by plan comparison.
    const showStep = (step) => {
      welcome.classList.toggle("hidden", step !== 1);
      plans.classList.toggle("hidden", step !== 2);
      dotOne.classList.toggle("active", step === 1);
      dotTwo.classList.toggle("active", step === 2);
    };

    $("#onboardingNextButton")?.addEventListener("click", () => showStep(2));
    $("#onboardingBackButton")?.addEventListener("click", () => showStep(1));
    $("#onboardingFinishButton")?.addEventListener("click", () => {
      try {
        const telegramUserId = String(tg?.initDataUnsafe?.user?.id || "guest");
        localStorage.setItem(`${ONBOARDING_STORAGE_KEY}:${telegramUserId}`, "1");
      } catch {
        // Continue into WAGRAM even when local storage is unavailable.
      }
      overlay.classList.add("is-dismissed");
      window.setTimeout(() => overlay.remove(), 320);
    });

    overlay.classList.remove("hidden");
  }

  function init() {
    initTelegram();
    bindEvents();

    // [ADDED] Keep the WAGRAM splash visible until the first account, WhatsApp
    // connection, and chat requests have all completed (successfully or with an error).
    const loadingScreen = $("#appLoadingScreen");
    // [MODIFIED] Resolve the authenticated membership through loadMe() before the first chat render.
    // This prevents Premium groups from being rendered as locked while /account is still loading.
    loadMe().finally(() => {
      loadChats().finally(() => {
        requestAnimationFrame(() => {
          loadingScreen?.classList.add("is-hidden");
          window.setTimeout(() => loadingScreen?.remove(), 380);
          initOnboarding(); // [ADDED] Show onboarding after the initial app load settles.
        });
      });
    });

    // [ADDED] Load call history in the background so new incoming calls can badge the tab.
    loadCalls();
    // [ADDED] Keep HH.MM countdown aligned with the 08:00 WITA pause.
    window.setInterval(renderFreePauseCountdown, 15000);
    // [ADDED] Refresh the Premium expiry timer displayed in the tier badge.
    window.setInterval(renderMembership, 15000);
    connectRealtime();
    // [ADDED] Poll only while a conversation is open; WebSocket remains the fast path.
    window.setInterval(() => {
      if (state.currentChat) refreshOpenChat();
    }, 2000);
    window.addEventListener("online", connectRealtime);
    document.addEventListener("visibilitychange", handleVisibilityChange);
  }

  init();
})();
