/* [MODIFIED] WhatsApp QR pairing is opened only after the user presses Connect in Profile. */
(() => {
  "use strict";

  const tg = window.Telegram?.WebApp || null;
  const apiBase = String(window.MINIAPP_API_BASE || "/api/miniapp").replace(/\/+$/, "");
  const gate = document.createElement("section");
  gate.className = "connection-gate";
  gate.id = "connectionGate";
  gate.innerHTML = `
    <div class="connection-panel">
      <div class="connection-brand">
        <div class="connection-brand-mark" aria-hidden="true"><img src="./assets/wagram-logo.svg" alt=""></div>
        <div class="connection-brand-name">WAGRAM<span>WhatsApp Messenger</span></div>
      </div>
      <div class="connection-eyebrow">WhatsApp pairing</div>
      <h1 class="connection-title" id="connectionTitle">Hubungkan WhatsApp</h1>
      <p class="connection-description" id="connectionDescription">Pindai QR ini menggunakan WhatsApp di ponsel Anda untuk mulai menggunakan Mini App.</p>
      <div class="connection-qr-wrap" id="connectionQrWrap">
        <div class="connection-wait"><span class="connection-pulse"></span> Menyiapkan QR Connect…</div>
      </div>
      <div class="connection-wait" id="connectionStatus"><span class="connection-pulse"></span> Menghubungkan ke server…</div>
      <div class="connection-steps" id="connectionSteps">
        <strong>Cara menghubungkan</strong>
        1. Buka WhatsApp di ponsel Anda<br>
        2. Pilih Setelan → Perangkat tertaut → Tautkan perangkat<br>
        3. Pindai QR yang tampil di atas
      </div>
      <p class="connection-error" id="connectionError" hidden></p>
      <button class="connection-retry" id="connectionRetry" type="button" hidden>Coba hubungkan lagi</button>
    </div>`;
  document.body.appendChild(gate);

  let timer = null;
  let starting = false;
  let completed = false;

  async function request(path, options = {}) {
    const response = await fetch(apiBase + path, {
      ...options,
      headers: {
        "X-Telegram-Init-Data": tg?.initData || "",
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...options.headers
      },
      cache: "no-store"
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false) {
      throw new Error(data.message || "Tidak dapat memeriksa koneksi WhatsApp.");
    }
    return data;
  }

  function showError(message) {
    const error = document.getElementById("connectionError");
    error.textContent = message;
    error.hidden = false;
    document.getElementById("connectionRetry").hidden = false;
    document.getElementById("connectionStatus").innerHTML = "Koneksi belum siap";
  }

  function showConnected() {
    if (completed) return;
    completed = true;
    if (timer) clearInterval(timer);
    document.body.classList.remove("connection-pending");
    gate.remove();
    tg?.ready?.();
    tg?.expand?.();
  }

  async function beginConnection() {
    if (starting) return;
    starting = true;
    document.getElementById("connectionError").hidden = true;
    document.getElementById("connectionRetry").hidden = true;
    try {
      await request("/connection/connect", { method: "POST" });
    } catch (error) {
      showError(error.message);
    } finally {
      starting = false;
    }
  }

  async function checkConnection() {
    if (completed) return;
    try {
      const data = await request("/connection");
      const status = data.status || "disconnected";

      if (status === "connected") {
        showConnected();
        return;
      }

      if (status === "qr" && data.qr) {
        const wrap = document.getElementById("connectionQrWrap");
        if (wrap.dataset.qr !== data.qr) {
          wrap.dataset.qr = data.qr;
          wrap.innerHTML = "";
          const image = document.createElement("img");
          image.src = data.qr;
          image.alt = "QR WhatsApp untuk menghubungkan perangkat";
          wrap.appendChild(image);
        }
        document.getElementById("connectionTitle").textContent = "Pindai QR WhatsApp";
        document.getElementById("connectionDescription").textContent = "Buka WhatsApp di ponsel, masuk ke Perangkat tertaut, lalu pindai QR berikut.";
        document.getElementById("connectionStatus").innerHTML = '<span class="connection-pulse"></span> Menunggu pemindaian QR…';
        document.getElementById("connectionSteps").hidden = false;
        return;
      }

      const labels = {
        connecting: "Menyiapkan koneksi WhatsApp…",
        logged_out: "Sesi WhatsApp berakhir. Siapkan koneksi baru…",
        replaced: "Sesi WhatsApp perlu dihubungkan ulang…",
        disconnected: "Memulai koneksi WhatsApp…"
      };
      document.getElementById("connectionStatus").innerHTML = '<span class="connection-pulse"></span> ' + (labels[status] || "Menunggu koneksi…");
      if (!starting && ["disconnected", "logged_out", "replaced"].includes(status)) {
        await beginConnection();
      }
    } catch (error) {
      showError(error.message);
    }
  }

  document.getElementById("connectionRetry").addEventListener("click", () => {
    beginConnection().then(checkConnection);
  });

  // [MODIFIED] Keep the normal Mini App navigation visible on launch.
  tg?.ready?.();
  tg?.expand?.();

  window.addEventListener("wagram:connect", () => {
    if (completed || document.body.classList.contains("connection-pending")) return;
    document.body.classList.add("connection-pending");
    gate.classList.add("is-active");
    beginConnection().then(checkConnection);
    if (timer) clearInterval(timer);
    timer = setInterval(checkConnection, 1800);
  });
})();