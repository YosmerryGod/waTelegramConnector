/* WAMO AI conversation enhancements.
 * Owner corrections are saved as session-scoped examples through the existing API.
 */
(() => {
  "use strict";

  const API_BASE = String(window.MINIAPP_API_BASE || "/api/miniapp").replace(/\/+$/, "");
  const HISTORY_KEY = "wagram-ai-business-history-v1";
  const ACTIVE_SESSION_KEY = "wagram-active-whatsapp-session";
  let observer = null;
  let modal = null;
  let noticeTimer = null;

  const escapeHTML = (value) => String(value ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

  function activeSessionId() {
    return localStorage.getItem(ACTIVE_SESSION_KEY) || "default";
  }

  function getHistory() {
    try {
      const all = JSON.parse(localStorage.getItem(HISTORY_KEY) || "{}");
      const history = all[activeSessionId()];
      return Array.isArray(history) ? history.slice(-30) : [];
    } catch {
      return [];
    }
  }

  function saveHistory(history) {
    try {
      const all = JSON.parse(localStorage.getItem(HISTORY_KEY) || "{}");
      all[activeSessionId()] = history.slice(-30);
      localStorage.setItem(HISTORY_KEY, JSON.stringify(all));
    } catch {
      throw new Error("Riwayat chat tidak dapat disimpan di perangkat ini.");
    }
  }

  function getHeaders() {
    const sessionId = localStorage.getItem(ACTIVE_SESSION_KEY);
    return {
      "Content-Type": "application/json",
      "X-Telegram-Init-Data": window.Telegram?.WebApp?.initData || "",
      ...(sessionId ? { "X-WAGRAM-Session-ID": sessionId } : {})
    };
  }

  async function requestJSON(path, body) {
    const response = await fetch(API_BASE + path, {
      method: "POST",
      headers: getHeaders(),
      body: JSON.stringify(body)
    });
    let result = {};
    try { result = await response.json(); } catch {}
    if (!response.ok || result.ok === false) {
      throw new Error(result.message || "Permintaan belum berhasil disimpan.");
    }
    return result;
  }

  function showNotice(message) {
    let notice = document.getElementById("wamoCorrectionNotice");
    if (!notice) {
      notice = document.createElement("div");
      notice.id = "wamoCorrectionNotice";
      notice.className = "wamo-correction-notice";
      document.body.appendChild(notice);
    }
    notice.textContent = message;
    notice.classList.add("is-visible");
    if (noticeTimer) window.clearTimeout(noticeTimer);
    noticeTimer = window.setTimeout(() => notice.classList.remove("is-visible"), 2800);
  }

  function closeModal() {
    if (modal) modal.remove();
    modal = null;
  }

  function appendChatMessage(role, content) {
    const history = getHistory();
    const time = new Intl.DateTimeFormat("id-ID", { hour: "2-digit", minute: "2-digit" }).format(new Date());
    history.push({ role, content, time });
    saveHistory(history);
    const container = document.getElementById("aiBusinessMessages");
    const intro = document.getElementById("aiBusinessIntro");
    if (intro) intro.classList.add("hidden");
    if (container) {
      const bubble = document.createElement("div");
      bubble.className = "message " + (role === "user" ? "outgoing" : "ai-business-reply");
      bubble.innerHTML = '<div class="message-text">' + escapeHTML(content) + '</div><div class="message-time">' + escapeHTML(time) + '</div>';
      container.appendChild(bubble);
      container.scrollTop = container.scrollHeight;
    }
    decorateReplies();
  }

  function parsePrice(raw, multiplier) {
    const digits = String(raw || "").replace(/[^0-9]/g, "");
    if (!digits) return null;
    const amount = Number(digits) * (multiplier || 1);
    return Number.isSafeInteger(amount) && amount <= 1000000000000 ? amount : null;
  }

  function parseProductCommand(raw) {
    const text = String(raw || "").trim();
    const actionMatch = text.match(/^(tambahkan|tambah|catat|input|masukkan|ubah|update|perbarui)\s+(?:menu|produk)\s+/i);
    if (!actionMatch) return null;

    const match = text.match(/^(tambahkan|tambah|catat|input|masukkan|ubah|update|perbarui)\s+(?:menu|produk)\s+(.+?)\s*[,;]\s*harga\s*(?:rp\.?\s*)?([0-9][0-9.,]*)\s*(ribu|rb|k)?\s*[,;]\s*stok\s*([0-9]+)\s*$/i);
    if (!match) return { invalid: true };

    const action = /^(ubah|update|perbarui)$/i.test(match[1]) ? "update" : "create";
    const name = String(match[2] || "").trim().replace(/[.,;]+$/, "");
    const multiplier = /^(ribu|rb|k)$/i.test(match[4] || "") ? 1000 : 1;
    const price = parsePrice(match[3], multiplier);
    const stock = Number(match[5]);
    if (!name || name.length > 120 || price === null || !Number.isSafeInteger(stock) || stock < 0 || stock > 100000000) {
      return { invalid: true };
    }
    return { action, product: { name, price, stock } };
  }

  function openProductConfirmation(command, originalText, submitButton) {
    closeModal();
    modal = document.createElement("div");
    modal.className = "wamo-correction-modal";
    const actionLabel = command.action === "create" ? "Tambahkan produk" : "Ubah produk";
    modal.innerHTML = `
      <button class="wamo-correction-backdrop" type="button" data-correction-close aria-label="Tutup"></button>
      <section class="wamo-correction-panel" role="dialog" aria-modal="true" aria-labelledby="wamoDataChangeTitle">
        <header>
          <div><small>PERUBAHAN DATA BISNIS</small><h2 id="wamoDataChangeTitle">Konfirmasi perubahan</h2></div>
          <button type="button" class="wamo-correction-close" data-correction-close aria-label="Tutup">×</button>
        </header>
        <div class="wamo-correction-question"><strong>${actionLabel}</strong>
          <p>Nama: ${escapeHTML(command.product.name)}</p>
          <p>Harga: Rp${command.product.price.toLocaleString("id-ID")}</p>
          <p>Stok: ${command.product.stock}</p>
        </div>
        <p class="wamo-correction-question">Data hanya disimpan setelah kamu menekan tombol konfirmasi.</p>
        <div class="wamo-correction-actions">
          <button type="button" data-correction-close class="wamo-correction-cancel">Batal</button>
          <button type="button" id="wamoDataChangeConfirm" class="wamo-correction-save">Konfirmasi & simpan</button>
        </div>
      </section>`;
    document.body.appendChild(modal);
    modal.addEventListener("click", (event) => {
      if (event.target.closest("[data-correction-close]")) closeModal();
    });

    const confirm = modal.querySelector("#wamoDataChangeConfirm");
    confirm.addEventListener("click", async () => {
      confirm.disabled = true;
      confirm.textContent = "Menyimpan…";
      try {
        const result = await requestJSON("/ai-business/data-change", {
          action: command.action,
          product: command.product
        });
        closeModal();
        appendChatMessage("user", originalText);
        appendChatMessage("assistant", (result.action === "create" ? "Produk berhasil ditambahkan: " : "Produk berhasil diperbarui: ") +
          result.product.name + " · Rp" + Number(result.product.price).toLocaleString("id-ID") +
          " · Stok " + result.product.stock + ".");
        if (submitButton) submitButton.disabled = false;
        showNotice("Data produk tersimpan di profil bisnis sesi ini.");
      } catch (error) {
        confirm.disabled = false;
        confirm.textContent = "Konfirmasi & simpan";
        showNotice(error.message || "Perubahan data gagal disimpan.");
      }
    });
  }

  async function saveCorrection(question, idealAnswer) {
    return requestJSON("/ai-business/examples", {
      question,
      idealAnswer,
      intent: "owner_correction",
      data: { source: "wamo_ai_reply_correction" }
    });
  }

  function openCorrection(index, button) {
    const history = getHistory();
    const target = history[index];
    if (!target || target.role !== "assistant") {
      showNotice("Balasan ini tidak ditemukan di riwayat.");
      return;
    }

    let question = "";
    for (let i = index - 1; i >= 0; i -= 1) {
      if (history[i]?.role === "user") {
        question = String(history[i].content || "").trim();
        break;
      }
    }
    if (!question) {
      showNotice("Pertanyaan asal tidak ditemukan.");
      return;
    }

    closeModal();
    modal = document.createElement("div");
    modal.className = "wamo-correction-modal";
    modal.innerHTML = `
      <button class="wamo-correction-backdrop" type="button" data-correction-close aria-label="Tutup"></button>
      <section class="wamo-correction-panel" role="dialog" aria-modal="true" aria-labelledby="wamoCorrectionTitle">
        <header>
          <div><small>KOREKSI WAMO AI</small><h2 id="wamoCorrectionTitle">Perbaiki jawaban</h2></div>
          <button type="button" class="wamo-correction-close" data-correction-close aria-label="Tutup">×</button>
        </header>
        <div class="wamo-correction-question"><strong>Pertanyaan</strong><p>${escapeHTML(question)}</p></div>
        <label for="wamoCorrectionAnswer">Jawaban yang benar</label>
        <textarea id="wamoCorrectionAnswer" rows="5" maxlength="2000" required>${escapeHTML(target.content || "")}</textarea>
        <div class="wamo-correction-actions">
          <button type="button" data-correction-close class="wamo-correction-cancel">Batal</button>
          <button type="button" id="wamoCorrectionSave" class="wamo-correction-save">Simpan koreksi</button>
        </div>
      </section>`;
    document.body.appendChild(modal);

    modal.addEventListener("click", (event) => {
      if (event.target.closest("[data-correction-close]")) closeModal();
    });

    const answer = modal.querySelector("#wamoCorrectionAnswer");
    const save = modal.querySelector("#wamoCorrectionSave");
    answer.focus();
    answer.setSelectionRange(answer.value.length, answer.value.length);

    save.addEventListener("click", async () => {
      const corrected = String(answer.value || "").trim();
      if (!corrected) {
        answer.focus();
        showNotice("Isi jawaban yang benar terlebih dahulu.");
        return;
      }
      save.disabled = true;
      save.textContent = "Menyimpan…";
      try {
        await saveCorrection(question, corrected);
        closeModal();
        button.disabled = true;
        button.textContent = "Tersimpan";
        button.classList.add("is-saved");
        showNotice("Koreksi tersimpan dan menjadi referensi WAMO AI.");
      } catch (error) {
        showNotice(error.message || "Koreksi gagal disimpan.");
        save.disabled = false;
        save.textContent = "Simpan koreksi";
      }
    });
  }

  function decorateReplies() {
    const container = document.getElementById("aiBusinessMessages");
    if (!container) return;
    const history = getHistory();
    const assistantIndexes = [];
    history.forEach((item, index) => {
      if (item?.role === "assistant") assistantIndexes.push(index);
    });

    const bubbles = [...container.querySelectorAll(".message.ai-business-reply:not(.ai-business-thinking):not(.ai-business-error):not(.ai-business-qris-image-bubble)")];
    bubbles.forEach((bubble, position) => {
      if (bubble.querySelector(".wamo-correction-button")) return;
      const historyIndex = assistantIndexes[position];
      if (!Number.isInteger(historyIndex)) return;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "wamo-correction-button";
      button.textContent = "Perbaiki";
      button.setAttribute("aria-label", "Perbaiki jawaban WAMO AI");
      button.addEventListener("click", () => openCorrection(historyIndex, button));
      bubble.appendChild(button);
    });
  }

  function installStyles() {
    if (document.getElementById("wamoCorrectionStyles")) return;
    const style = document.createElement("style");
    style.id = "wamoCorrectionStyles";
    style.textContent = `
      .wamo-correction-button{display:inline-flex;align-items:center;justify-content:center;margin-top:9px;padding:6px 11px;border:1px solid var(--border);border-radius:999px;background:transparent;color:var(--text-secondary,var(--muted));font:inherit;font-size:11px;cursor:pointer}
      .wamo-correction-button:disabled{opacity:.65;cursor:default}
      .wamo-correction-button.is-saved{color:var(--accent);border-color:var(--accent)}
      .wamo-correction-modal{position:fixed;inset:0;z-index:10020;display:grid;place-items:center;padding:18px}
      .wamo-correction-backdrop{position:absolute;inset:0;border:0;background:rgba(0,0,0,.62)}
      .wamo-correction-panel{position:relative;width:min(100%,440px);max-height:min(88vh,720px);overflow:auto;padding:20px;border:1px solid var(--border);border-radius:20px;background:var(--surface);color:var(--text);box-shadow:0 22px 70px rgba(0,0,0,.32)}
      .wamo-correction-panel header{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;margin-bottom:18px}
      .wamo-correction-panel header small{color:var(--accent);font-size:10px;font-weight:750;letter-spacing:.1em}
      .wamo-correction-panel h2{margin:5px 0 0;font-size:19px}
      .wamo-correction-close{width:32px;height:32px;border:0;border-radius:50%;background:var(--surface-2);color:var(--text);font-size:22px}
      .wamo-correction-question{padding:11px 12px;margin-bottom:15px;border-radius:12px;background:var(--surface-2)}
      .wamo-correction-question strong,.wamo-correction-panel label{font-size:12px;font-weight:700}
      .wamo-correction-question p{margin:5px 0 0;color:var(--text-secondary,var(--muted));font-size:13px;line-height:1.5;overflow-wrap:anywhere}
      .wamo-correction-panel label{display:block;margin-bottom:7px}
      .wamo-correction-panel textarea{display:block;width:100%;min-height:120px;resize:vertical;padding:12px;border:1px solid var(--border);border-radius:12px;background:var(--surface-2);color:var(--text);font:inherit;font-size:14px;line-height:1.5}
      .wamo-correction-panel textarea:focus{outline:2px solid var(--accent);outline-offset:1px}
      .wamo-correction-actions{display:flex;justify-content:flex-end;gap:9px;margin-top:16px}
      .wamo-correction-actions button{min-height:40px;padding:0 14px;border:0;border-radius:11px;font:inherit;font-size:13px;font-weight:700}
      .wamo-correction-cancel{background:var(--surface-2);color:var(--text)}
      .wamo-correction-save{background:var(--accent);color:#fff}
      .wamo-correction-save:disabled{opacity:.6}
      .wamo-correction-notice{position:fixed;z-index:10030;left:50%;bottom:calc(24px + env(safe-area-inset-bottom));max-width:calc(100% - 32px);padding:11px 15px;border-radius:12px;background:var(--surface-2);color:var(--text);font-size:12px;box-shadow:0 8px 28px rgba(0,0,0,.24);opacity:0;pointer-events:none;transform:translate(-50%,8px);transition:opacity .18s ease,transform .18s ease}
      .wamo-correction-notice.is-visible{opacity:1;transform:translate(-50%,0)}
    `;
    document.head.appendChild(style);
  }

  function bindProductCommand() {
    const form = document.getElementById("aiBusinessComposer");
    const input = document.getElementById("aiBusinessInput");
    const button = document.getElementById("sendAIBusinessMessageButton");
    if (!form || form.dataset.wamoDataChangeBound === "true") return;
    form.dataset.wamoDataChangeBound = "true";
    form.addEventListener("submit", (event) => {
      const text = String(input?.value || "").trim();
      if (!text) return;
      const command = parseProductCommand(text);
      if (!command) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (command.invalid) {
        showNotice("Format: Tambahkan menu Nama Produk, harga 25 ribu, stok 30.");
        return;
      }
      if (input) input.value = "";
      openProductConfirmation(command, text, button);
    }, true);
  }

  function init() {
    const container = document.getElementById("aiBusinessMessages");
    if (!container) return;
    installStyles();
    bindProductCommand();
    decorateReplies();
    observer?.disconnect();
    observer = new MutationObserver(decorateReplies);
    observer.observe(container, { childList: true, subtree: true });
    window.addEventListener("storage", decorateReplies);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
