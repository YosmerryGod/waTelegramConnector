import "dotenv/config";
import db from "../database.js";
import {
  listMessages,
  getAIBusinessProfile,
  getAIBusinessAutoReplyEnabled
} from "../database.js"; // [MODIFIED] Include the server-side Auto Reply preference.
import {
  getAICustomerServiceStatus,
  createAICustomerServiceSuggestion,
  createAIBusinessReply,
  analyzeAIPaymentProofImage,
  createAIPaymentProofCustomerReply,
  createAIBusinessImageCustomerReply
} from "./customer-service.js";

// [ADDED] Drain the durable scheduled-order notification outbox with retry and stale-claim recovery.
export async function processPendingScheduledOrderNotifications({ telegramId, sessionId, socket, limit = 10 } = {}) {
  const ownerId = String(telegramId || "");
  const accountId = String(sessionId || telegramId || "");
  if (!ownerId || !accountId || !socket || typeof socket.sendMessage !== "function") {
    return { sent: 0, failed: 0, skipped: true };
  }

  let sent = 0;
  let failed = 0;
  const maxItems = Math.max(1, Math.min(25, Number(limit) || 10));
  console.info("[WAGRAM Scheduled Order Outbox] Drain started:", JSON.stringify({
    telegramId: ownerId, sessionId: accountId, limit: maxItems
  }));

  for (let index = 0; index < maxItems; index += 1) {
    const now = Date.now();
    const claim = db.transaction(() => {
      const candidate = db.prepare(`
        SELECT o.order_id
        FROM ai_scheduled_order_outbox o
        WHERE o.telegram_id = ? AND o.session_id = ?
          AND (
            (o.status = 'pending' AND o.next_attempt_at <= ?)
            OR (o.status = 'sending' AND o.claimed_at <= ?)
          )
        ORDER BY o.created_at ASC
        LIMIT 1
      `).get(ownerId, accountId, now, now - 5 * 60 * 1000);
      if (!candidate) return null;
      const changed = db.prepare(`
        UPDATE ai_scheduled_order_outbox
        SET status = 'sending', attempts = attempts + 1,
            claimed_at = ?, updated_at = ?, last_error = NULL
        WHERE order_id = ? AND telegram_id = ? AND session_id = ?
          AND (
            (status = 'pending' AND next_attempt_at <= ?)
            OR (status = 'sending' AND claimed_at <= ?)
          )
      `).run(now, now, candidate.order_id, ownerId, accountId, now, now - 5 * 60 * 1000);
      if (changed.changes !== 1) return null;
      return db.prepare(`
        SELECT o.order_id, o.attempts, s.customer_name, s.customer_chat_id,
          s.outlet_name, s.outlet_address, s.pickup_at, s.timezone,
          s.items_json, s.total_amount, s.payment_status, s.payment_note
        FROM ai_scheduled_order_outbox o
        JOIN ai_scheduled_orders s ON s.id = o.order_id
        WHERE o.order_id = ? AND o.telegram_id = ? AND o.session_id = ?
      `).get(candidate.order_id, ownerId, accountId);
    });

    const order = claim();
    if (!order) break;

    console.info("[WAGRAM Scheduled Order Outbox] Notification claimed:", JSON.stringify({
      telegramId: ownerId, sessionId: accountId, orderId: order.order_id,
      attempt: order.attempts, paymentStatus: order.payment_status,
      proofImageRequired: order.payment_status !== "unpaid"
    }));
    try {
      const managerDigits = normalizeManagerPhone(
        getAIBusinessProfile(ownerId, accountId)?.settings?.manager?.phone
      );
      if (!managerDigits) throw new Error("SCHEDULED_ORDER_MANAGER_PHONE_NOT_CONFIGURED");
      const items = JSON.parse(order.items_json || "[]");
      const paymentLabel = order.payment_status === "unpaid"
        ? "Belum dibayar — bayar di tempat di outlet"
        : "Mengaku sudah dibayar — WAJIB verifikasi pengelola";
      const itemLines = items.map((item) =>
        "- " + item.name + " x" + item.quantity + " = Rp" + Number(item.subtotal).toLocaleString("id-ID")
      );
      const managerNotice = [
        "PESANAN TERJADWAL",
        "ID: #" + order.order_id,
        "Pelanggan: " + order.customer_name,
        "WhatsApp: " + (order.customer_chat_id.endsWith("@s.whatsapp.net")
          ? "+" + order.customer_chat_id.replace(/@s\.whatsapp\.net$/, "")
          : "ID chat " + order.customer_chat_id),
        "Outlet: " + order.outlet_name,
        "Alamat: " + (order.outlet_address || "Belum tersedia"),
        "Waktu ambil: " + order.pickup_at + " (" + order.timezone + ")",
        "Menu:",
        ...itemLines,
        "Total: Rp" + Number(order.total_amount).toLocaleString("id-ID"),
        "Pembayaran: " + paymentLabel,
        "Catatan: " + order.payment_note
      ].join("\n").slice(0, 3500);

      const result = await socket.sendMessage(managerDigits + "@s.whatsapp.net", { text: managerNotice });
      const messageId = result?.key?.id || null;
      db.transaction(() => {
        db.prepare(`
          UPDATE ai_scheduled_order_outbox
          SET status = 'sent', manager_message_id = ?, claimed_at = NULL,
              last_error = NULL, updated_at = ?
          WHERE order_id = ? AND telegram_id = ? AND session_id = ? AND status = 'sending'
        `).run(messageId, Date.now(), order.order_id, ownerId, accountId);
        db.prepare(`
          UPDATE ai_scheduled_orders SET notification_status = 'sent'
          WHERE id = ? AND telegram_id = ? AND session_id = ?
        `).run(order.order_id, ownerId, accountId);
      })();
      sent += 1;
      console.info("[WAGRAM Scheduled Order Outbox] Manager notification sent:", JSON.stringify({
        telegramId: ownerId, sessionId: accountId, orderId: order.order_id,
        managerMessageId: messageId, paymentStatus: order.payment_status,
        deliveryType: "text"
      }));
    } catch (error) {
      const attempt = Number(order.attempts) || 1;
      const delay = Math.min(30 * 60 * 1000, 30 * 1000 * (2 ** Math.min(attempt - 1, 6)));
      db.prepare(`
        UPDATE ai_scheduled_order_outbox
        SET status = 'pending', next_attempt_at = ?, claimed_at = NULL,
            last_error = ?, updated_at = ?
        WHERE order_id = ? AND telegram_id = ? AND session_id = ? AND status = 'sending'
      `).run(Date.now() + delay, String(error?.message || "NOTIFICATION_FAILED").slice(0, 300),
        Date.now(), order.order_id, ownerId, accountId);
      failed += 1;
      console.error("[WAGRAM Scheduled Order Outbox] Delivery failed:", {
        telegramId: ownerId, sessionId: accountId, orderId: order.order_id,
        attempt, retryInMs: delay, error: String(error?.message || "NOTIFICATION_FAILED").slice(0, 200)
      });
    }
  }

  console.info("[WAGRAM Scheduled Order Outbox] Drain completed:", JSON.stringify({
    telegramId: ownerId, sessionId: accountId, sent, failed
  }));
  return { sent, failed, skipped: false };
}

// [ADDED] Durable at-most-once processing guard for WhatsApp auto replies.
// A claimed job is never automatically retried: this prevents duplicate sends
// after reconnects, repeated Baileys events, or a process restart.
db.exec(`
  CREATE TABLE IF NOT EXISTS ai_manager_escalations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    customer_chat_id TEXT NOT NULL,
    customer_phone TEXT,
    customer_message_id TEXT NOT NULL,
    manager_chat_id TEXT NOT NULL,
    manager_message_id TEXT,
    question TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at INTEGER NOT NULL,
    answered_at INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_ai_manager_escalations_pending
    ON ai_manager_escalations(telegram_id, session_id, manager_chat_id, status, created_at DESC);

  CREATE TABLE IF NOT EXISTS ai_customer_image_context (
    telegram_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    image_message_id TEXT NOT NULL,
    image_type TEXT NOT NULL,
    image_description TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (telegram_id, session_id, chat_id)
  );

  CREATE TABLE IF NOT EXISTS ai_auto_reply_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    incoming_message_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'processing'
      CHECK (status IN ('processing', 'sent', 'failed', 'skipped')),
    generated_reply TEXT,
    reply_message_id TEXT,
    error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (telegram_id, session_id, chat_id, incoming_message_id)
  );

  CREATE INDEX IF NOT EXISTS idx_ai_auto_reply_jobs_owner
    ON ai_auto_reply_jobs(telegram_id, session_id, created_at DESC);
`);

// [MODIFIED] Wait for a full 5-second quiet window so customers can send
// multiple WhatsApp bubbles before the AI reads the conversation and replies.
const AUTO_REPLY_SETTLE_MS = Math.max(
  300,
  Math.min(5000, Number(process.env.WAGRAM_AUTO_REPLY_SETTLE_MS || 5000))
);

export function claimAIAutoReplyJob(telegramId, sessionId, chatId, messageId) {
  const now = Date.now();
  return db.prepare(`
    INSERT OR IGNORE INTO ai_auto_reply_jobs (
      telegram_id, session_id, chat_id, incoming_message_id,
      status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'processing', ?, ?)
  `).run(
    String(telegramId),
    String(sessionId || telegramId),
    String(chatId),
    String(messageId),
    now,
    now
  ).changes === 1;
}

function updateAutoReply(telegramId, sessionId, chatId, messageId, values = {}) {
  const fields = [];
  const params = [];

  if (Object.prototype.hasOwnProperty.call(values, "status")) {
    fields.push("status = ?");
    params.push(String(values.status));
  }
  if (Object.prototype.hasOwnProperty.call(values, "generatedReply")) {
    fields.push("generated_reply = ?");
    params.push(values.generatedReply == null ? null : String(values.generatedReply));
  }
  if (Object.prototype.hasOwnProperty.call(values, "replyMessageId")) {
    fields.push("reply_message_id = ?");
    params.push(values.replyMessageId == null ? null : String(values.replyMessageId));
  }
  if (Object.prototype.hasOwnProperty.call(values, "error")) {
    fields.push("error = ?");
    params.push(values.error == null ? null : String(values.error).slice(0, 300));
  }

  if (!fields.length) return;
  fields.push("updated_at = ?");
  params.push(Date.now(), String(telegramId), String(sessionId || telegramId), String(chatId), String(messageId));

  db.prepare(`
    UPDATE ai_auto_reply_jobs
    SET ${fields.join(", ")}
    WHERE telegram_id = ? AND session_id = ? AND chat_id = ? AND incoming_message_id = ?
  `).run(...params);
}

// [ADDED] Identify an outgoing message generated by this auto-reply worker.
// These replies must not be learned again as if they were human admin answers.
export function isAIAutoReplyMessage(telegramId, sessionId, chatId, body) {
  const text = String(body || "").trim();
  if (!text) return false;

  return Boolean(db.prepare(`
    SELECT 1
    FROM ai_auto_reply_jobs
    WHERE telegram_id = ?
      AND session_id = ?
      AND chat_id = ?
      AND generated_reply = ?
      AND status IN ('processing', 'sent')
    LIMIT 1
  `).get(
    String(telegramId),
    String(sessionId || telegramId),
    String(chatId),
    text
  ));
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeManagerPhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return "";
  return digits.startsWith("0") ? "62" + digits.slice(1) : digits.startsWith("8") ? "62" + digits : digits;
}

async function escalateToManager({ telegramId, sessionId, customerChatId, customerPhone, customerMessageId, question, socket }) {
  const profile = getAIBusinessProfile(telegramId, sessionId);
  const manager = profile?.settings?.manager || {};
  const managerDigits = normalizeManagerPhone(manager.phone);
  if (!managerDigits) throw new Error("AI_MANAGER_PHONE_NOT_CONFIGURED");
  const managerJid = managerDigits + "@s.whatsapp.net";
  const managerText = [
    "🔔 *WAGRAM — Butuh Informasi Pengelola*",
    "",
    "Pelanggan: " + (customerPhone ? "+" + customerPhone : customerChatId),
    "Pertanyaan pelanggan:",
    String(question || "").slice(0, 1000),
    "",
    "Silakan balas pesan ini (Reply) dengan jawabannya. WAGRAM akan meneruskan jawaban ke pelanggan."
  ].join("\n");
  const sent = await socket.sendMessage(managerJid, { text: managerText });
  const now = Date.now();
  db.prepare(`
    INSERT INTO ai_manager_escalations (
      telegram_id, session_id, customer_chat_id, customer_phone,
      customer_message_id, manager_chat_id, manager_message_id, question, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
  `).run(
    String(telegramId), String(sessionId || telegramId), String(customerChatId),
    customerPhone ? String(customerPhone) : null, String(customerMessageId),
    managerJid, String(sent?.key?.id || ""), String(question || "").slice(0, 1000), now
  );
  return { managerJid, managerMessageId: sent?.key?.id || null };
}

// [ADDED] Manager-only commands for scheduled order lifecycle and payment verification.
function formatScheduledOrderManagerRow(order) {
  const statusLabels = {
    scheduled: "Terjadwal",
    preparing: "Sedang disiapkan",
    ready: "Siap diambil",
    completed: "Selesai",
    cancelled: "Dibatalkan"
  };
  const paymentLabel = order.payment_verified_at
    ? "Terverifikasi pengelola"
    : order.payment_status === "unpaid" ? "Belum dibayar" : "Menunggu verifikasi";
  return [
    "#" + order.id + " — " + (order.customer_name || "Pelanggan"),
    order.outlet_name + " | " + order.pickup_at,
    "Status: " + (statusLabels[order.order_status] || order.order_status),
    "Pembayaran: " + paymentLabel,
    "Total: Rp" + Number(order.total_amount).toLocaleString("id-ID")
  ].join("\n");
}

async function handleScheduledOrderManagerCommand({ ownerId, accountId, managerJid, text, socket }) {
  const command = String(text || "").trim();
  if (!/^#(?:pesanan|order|status|proses|siap|selesai|batal|verifikasi)(?:\s|$)/i.test(command)) {
    return { handled: false };
  }
  const match = command.match(/^#(pesanan|order|status|proses|siap|selesai|batal|verifikasi)(?:\s+(\d+))?$/i);
  if (!match) {
    await socket.sendMessage(managerJid, { text: "Format perintah tidak valid. Gunakan #pesanan atau #proses 123, #siap 123, #selesai 123, #batal 123, #verifikasi 123." });
    return { handled: true, success: false };
  }
  const action = match[1].toLowerCase();
  const orderId = match[2] ? Number(match[2]) : null;
  const now = Date.now();

  if (["pesanan", "order"].includes(action)) {
    const orders = db.prepare(`
      SELECT id, customer_name, outlet_name, pickup_at, order_status,
        payment_status, payment_verified_at, total_amount
      FROM ai_scheduled_orders
      WHERE telegram_id = ? AND session_id = ?
        AND order_status NOT IN ('completed', 'cancelled')
      ORDER BY pickup_at ASC LIMIT 10
    `).all(ownerId, accountId);
    const message = orders.length
      ? "PESANAN TERJADWAL AKTIF\\n\\n" + orders.map(formatScheduledOrderManagerRow).join("\\n\\n")
      : "Tidak ada pesanan terjadwal aktif.";
    await socket.sendMessage(managerJid, { text: message.slice(0, 3500) });
    return { handled: true, success: true, count: orders.length };
  }

  if (!orderId || !Number.isSafeInteger(orderId)) {
    await socket.sendMessage(managerJid, { text: "Sertakan ID pesanan. Contoh: #" + action + " 123." });
    return { handled: true, success: false };
  }
  const order = db.prepare(`
    SELECT id, customer_name, outlet_name, pickup_at, order_status,
      payment_status, payment_verified_at, total_amount, customer_chat_id
    FROM ai_scheduled_orders
    WHERE id = ? AND telegram_id = ? AND session_id = ?
  `).get(orderId, ownerId, accountId);
  if (!order) {
    await socket.sendMessage(managerJid, { text: "Pesanan #" + orderId + " tidak ditemukan." });
    return { handled: true, success: false };
  }

  const transitions = {
    status: null,
    proses: { from: ["scheduled"], to: "preparing", label: "Sedang disiapkan" },
    siap: { from: ["scheduled", "preparing"], to: "ready", label: "Siap diambil" },
    selesai: { from: ["scheduled", "preparing", "ready"], to: "completed", label: "Selesai" },
    batal: { from: ["scheduled", "preparing", "ready"], to: "cancelled", label: "Dibatalkan" }
  };
  if (action === "status") {
    await socket.sendMessage(managerJid, { text: formatScheduledOrderManagerRow(order) });
    return { handled: true, success: true };
  }
  if (action === "verifikasi") {
    if (order.payment_status !== "pending_verification" || order.payment_verified_at) {
      await socket.sendMessage(managerJid, { text: "Pembayaran pesanan #" + orderId + " tidak sedang menunggu verifikasi atau sudah diverifikasi." });
      return { handled: true, success: false };
    }
    db.prepare(`
      UPDATE ai_scheduled_orders
      SET payment_verified_at = ?, payment_verified_by = ?, updated_at = ?
      WHERE id = ? AND telegram_id = ? AND session_id = ?
        AND payment_status = 'pending_verification' AND payment_verified_at IS NULL
    `).run(now, managerJid, now, orderId, ownerId, accountId);
    await socket.sendMessage(managerJid, { text: "Verifikasi pembayaran pesanan #" + orderId + " dicatat. Pastikan mutasi dana benar-benar sudah masuk." });
    try {
      await socket.sendMessage(order.customer_chat_id, { text: "Pembayaran untuk pesanan #" + orderId + " sudah diverifikasi oleh pengelola." });
    } catch (error) {
      console.error("[WAGRAM Scheduled Order] Customer payment status notification failed:", error.message);
    }
    return { handled: true, success: true };
  }

  const transition = transitions[action];
  if (!transition || !transition.from.includes(order.order_status)) {
    await socket.sendMessage(managerJid, { text: "Status pesanan #" + orderId + " saat ini " + order.order_status + " dan tidak dapat diubah dengan perintah tersebut." });
    return { handled: true, success: false };
  }
  const timestampColumn = action === "selesai" ? ", completed_at = ?" : action === "batal" ? ", cancelled_at = ?" : "";
  const values = [transition.to, now];
  if (timestampColumn) values.push(now);
  values.push(orderId, ownerId, accountId, ...transition.from);
  db.prepare(`
    UPDATE ai_scheduled_orders
    SET order_status = ?, updated_at = ? ${timestampColumn}
    WHERE id = ? AND telegram_id = ? AND session_id = ?
      AND order_status IN (${transition.from.map(() => "?").join(", ")})
  `).run(...values);
  await socket.sendMessage(managerJid, { text: "Pesanan #" + orderId + " diperbarui: " + transition.label + "." });
  try {
    const customerStatusMessages = {
      preparing: "Pesanan #" + orderId + " sedang disiapkan.",
      ready: "Pesanan #" + orderId + " sudah siap diambil di " + order.outlet_name + ".",
      completed: "Pesanan #" + orderId + " telah ditandai selesai. Terima kasih.",
      cancelled: "Pesanan #" + orderId + " telah dibatalkan oleh pengelola."
    };
    await socket.sendMessage(order.customer_chat_id, { text: customerStatusMessages[transition.to] });
  } catch (error) {
    console.error("[WAGRAM Scheduled Order] Customer status notification failed:", error.message);
  }
  return { handled: true, success: true, status: transition.to };
}

// Called for incoming private text messages; only a reply to a pending escalation from
// the configured manager is forwarded to the original customer.
export async function handleIncomingManagerReply({ telegramId, sessionId, chatId, message, socket }) {
  const ownerId = String(telegramId || "");
  const accountId = String(sessionId || ownerId);
  const managerJid = String(chatId || "");
  const profile = getAIBusinessProfile(ownerId, accountId);
  const managerDigits = normalizeManagerPhone(profile?.settings?.manager?.phone);
  const key = message?.key || {};
  const senderCandidates = [
    managerJid,
    key.remoteJidAlt,
    key.remoteJidPn,
    message?.remoteJidAlt,
    message?.remoteJidPn
  ].map((value) => normalizeManagerPhone(value));
  if (!managerDigits || !senderCandidates.includes(managerDigits)) return { handled: false };
  const content = message?.message || {};
  const incomingText = String(content.conversation || content.extendedTextMessage?.text || "").trim();
  const managerCommand = await handleScheduledOrderManagerCommand({
    ownerId, accountId, managerJid, text: incomingText, socket
  });
  if (managerCommand.handled) return managerCommand;
  const context = content.extendedTextMessage?.contextInfo ||
    content.imageMessage?.contextInfo || content.videoMessage?.contextInfo ||
    content.documentMessage?.contextInfo || {};
  const quotedId = String(context.stanzaId || "");
  if (!quotedId) return { handled: false };
  const pending = db.prepare(`
    SELECT * FROM ai_manager_escalations
    WHERE telegram_id = ? AND session_id = ? AND manager_chat_id = ?
      AND manager_message_id = ? AND status = 'pending'
    ORDER BY created_at DESC LIMIT 1
  `).get(ownerId, accountId, managerJid, quotedId);
  if (!pending) return { handled: false };
  const answer = String(
    content.conversation || content.extendedTextMessage?.text ||
    content.imageMessage?.caption || content.documentMessage?.caption || ""
  ).trim();
  if (!answer) return { handled: true, forwarded: false, reason: "empty_manager_reply" };
  await socket.sendMessage(pending.customer_chat_id, {
    text: answer
  });
  db.prepare(`
    UPDATE ai_manager_escalations SET status = 'answered', answered_at = ?
    WHERE id = ? AND status = 'pending'
  `).run(Date.now(), pending.id);
  return { handled: true, forwarded: true, customerChatId: pending.customer_chat_id };
}

// [ADDED] Keep the latest recognized customer image as short-lived conversation context.
function saveCustomerImageContext(telegramId, sessionId, chatId, messageId, analysis) {
  const description = String(analysis?.imageDescription || analysis?.notes || "").trim().slice(0, 700);
  if (!description) return;
  db.prepare(`
    INSERT INTO ai_customer_image_context (
      telegram_id, session_id, chat_id, image_message_id, image_type, image_description, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(telegram_id, session_id, chat_id) DO UPDATE SET
      image_message_id = excluded.image_message_id,
      image_type = excluded.image_type,
      image_description = excluded.image_description,
      created_at = excluded.created_at
  `).run(
    String(telegramId), String(sessionId || telegramId), String(chatId), String(messageId),
    String(analysis?.imageType || "unclear"), description, Date.now()
  );
}

function getCustomerImageContext(telegramId, sessionId, chatId) {
  const row = db.prepare(`
    SELECT image_type, image_description, created_at
    FROM ai_customer_image_context
    WHERE telegram_id = ? AND session_id = ? AND chat_id = ?
  `).get(String(telegramId), String(sessionId || telegramId), String(chatId));
  if (!row || Date.now() - Number(row.created_at || 0) > 30 * 60 * 1000) return null;
  return row;
}

export async function handleIncomingAIPaymentProof({telegramId,sessionId,chatId,messageId,phoneNumber,customerName,imageBuffer,mimetype,socket,quotedMessage}) {
  const ownerId=String(telegramId||""), accountId=String(sessionId||telegramId), chat=String(chatId||""), incomingId=String(messageId||"");
  if (!ownerId||!accountId||!chat||!incomingId) return {handled:false,reason:"invalid_input"};
  const profile=getAIBusinessProfile(ownerId,accountId);
  if (!profile||!Buffer.isBuffer(imageBuffer)||!imageBuffer.length) return {handled:false,reason:"business_ai_or_image_missing"};
  // [ADDED] Respect the Profile switch before analyzing or forwarding payment-proof images.
  if (!getAIBusinessAutoReplyEnabled(ownerId,accountId)) return {handled:false,reason:"business_auto_reply_disabled"};
  if (!claimAIAutoReplyJob(ownerId,accountId,chat,incomingId)) return {handled:false,reason:"duplicate"};
  try {
    const conversation=listMessages(ownerId,chat,20,accountId).filter((item)=>item.body&&!item.is_deleted).reverse().map((item)=>({role:item.direction==="outgoing"?"business":"customer",text:String(item.body||"").slice(0,1000)}));
    const products=Array.isArray(profile.settings?.products)?profile.settings.products.slice(0,100):[];
    const result=await analyzeAIPaymentProofImage({imageBuffer,mimetype,conversation,products});
    // [ADDED] Stop an in-flight image workflow if Auto Reply was switched off during analysis.
    if (!getAIBusinessAutoReplyEnabled(ownerId,accountId)) {
      updateAutoReply(ownerId,accountId,chat,incomingId,{status:"skipped",error:"Business Auto Reply was disabled during image analysis."});
      return {handled:false,reason:"business_auto_reply_disabled"};
    }
    if (!socket||typeof socket.sendMessage!=="function") throw new Error("WHATSAPP_SOCKET_UNAVAILABLE");
    if (!result.isPaymentProof) {
      saveCustomerImageContext(ownerId, accountId, chat, incomingId, result);
      const customerReply = await createAIBusinessImageCustomerReply(ownerId, accountId, chat, result);
      if (!customerReply) throw new Error("AI_IMAGE_REPLY_EMPTY");
      if (!getAIBusinessAutoReplyEnabled(ownerId,accountId)) {
        updateAutoReply(ownerId,accountId,chat,incomingId,{status:"skipped",error:"Business Auto Reply was disabled before sending."});
        return {handled:false,reason:"business_auto_reply_disabled"};
      }
      updateAutoReply(ownerId,accountId,chat,incomingId,{generatedReply:customerReply});
      await socket.sendMessage(chat,{text:customerReply},quotedMessage?{quoted:quotedMessage}:{});
      updateAutoReply(ownerId,accountId,chat,incomingId,{status:"sent"});
      console.info("[WAGRAM AI Image Reply] Non-payment image handled:",JSON.stringify({telegramId:ownerId,sessionId:accountId,messageId:incomingId,imageType:result.imageType}));
      return {handled:true,forwarded:false,imageType:result.imageType};
    }
    if (typeof socket.onWhatsApp!=="function") throw new Error("WHATSAPP_SOCKET_UNAVAILABLE");
    const manager=profile.settings?.manager && typeof profile.settings.manager==="object" ? profile.settings.manager : {};
    if (!manager.phone) throw new Error("PAYMENT_MANAGER_PHONE_NOT_CONFIGURED");
    const managerDigits=manager.phone.replace(/\D/g,"");
    const managerInternational=managerDigits.startsWith("0") ? "62"+managerDigits.slice(1) : managerDigits.startsWith("8") ? "62"+managerDigits : managerDigits;
    if (!/^62\d{8,13}$/.test(managerInternational)) throw new Error("PAYMENT_MANAGER_PHONE_INVALID");
    if (managerInternational===String(phoneNumber||"").replace(/\D/g,"").replace(/^0/,"62")) throw new Error("PAYMENT_MANAGER_IS_CUSTOMER_NUMBER");
    const managerLookup=await socket.onWhatsApp(managerInternational);
    const managerJid=managerLookup?.find((entry)=>entry?.exists&&entry?.jid)?.jid;
    if (!managerJid) throw new Error("PAYMENT_MANAGER_WHATSAPP_NOT_REGISTERED");
    if (!getAIBusinessAutoReplyEnabled(ownerId,accountId)) {
      updateAutoReply(ownerId,accountId,chat,incomingId,{status:"skipped",error:"Business Auto Reply was disabled before payment-proof forwarding."});
      return {handled:false,reason:"business_auto_reply_disabled"};
    }
    const val=(v)=>v===null||v===undefined||String(v).trim()===""?"Belum terbaca":String(v).trim();
    const p=result.payment||{}, o=result.order||{};
    const caption=["BUKTI PEMBAYARAN BARU — PERLU VERIFIKASI","Pelanggan: "+val(customerName),"WhatsApp: "+val(phoneNumber?"+"+phoneNumber:chat),"DETAIL PESANAN","Produk: "+val(o.product),"Jumlah: "+val(o.quantity),"Harga satuan: "+val(o.unit_price),"Total pesanan: "+val(o.total),"INFORMASI BUKTI","Nominal: "+val(p.amount)+" "+val(p.currency),"Tanggal/waktu: "+val(p.date)+" "+val(p.time),"Pengirim: "+val(p.payer),"Penerima: "+val(p.recipient),"Metode: "+val(p.method),"Referensi: "+val(p.reference),"Status tertulis: "+val(p.status_text),"Keyakinan klasifikasi: "+Math.round(result.confidence*100)+"%","PERLU VERIFIKASI MUTASI. Gambar bukan bukti dana sudah masuk."].join("\n").slice(0,1024);
    await socket.sendMessage(managerJid,{
      image:imageBuffer,
      mimetype:mimetype||"image/jpeg",
      caption
    });
    const customerReply = await createAIPaymentProofCustomerReply(ownerId,accountId,chat,result);
    if (!customerReply) throw new Error("AI_PAYMENT_PROOF_REPLY_EMPTY");
    if (!getAIBusinessAutoReplyEnabled(ownerId,accountId)) {
      updateAutoReply(ownerId,accountId,chat,incomingId,{status:"skipped",error:"Business Auto Reply was disabled before customer response."});
      return {handled:false,reason:"business_auto_reply_disabled"};
    }
    updateAutoReply(ownerId,accountId,chat,incomingId,{generatedReply:customerReply});
    await socket.sendMessage(chat,{text:customerReply},quotedMessage?{quoted:quotedMessage}:{});
    updateAutoReply(ownerId,accountId,chat,incomingId,{status:"sent"});
    return {handled:true,forwarded:true};
  } catch(error) {
    // [MODIFIED] Never send a hardcoded customer-facing reply when AI generation fails.
    // Keep the failure visible for diagnosis instead of pretending an AI response was generated.
    console.error("[WAGRAM AI Image] Processing failed; no canned reply sent:",JSON.stringify({telegramId:ownerId,sessionId:accountId,messageId:incomingId,error:error.message}));
    updateAutoReply(ownerId,accountId,chat,incomingId,{status:"failed",error:error.message||"IMAGE_ANALYSIS_FAILED"});
    return {handled:false,reason:"ai_processing_failed"};
  }
}

// [ADDED] Send exactly one AI reply for one incoming private text message.
// This worker uses the configured AI Business profile when available, otherwise
// the enabled Premium-C AI Customer Service. Group/outgoing messages never enter.
export async function handleIncomingAIAutoReply({
  telegramId,
  sessionId,
  chatId,
  messageId,
  socket,
  quotedMessage
}) {
  const ownerId = String(telegramId || "");
  const accountId = String(sessionId || ownerId);
  const whatsappChatId = String(chatId || "");
  const incomingId = String(messageId || "");
  let processingStage = "input_validation";
  const chatDigits = whatsappChatId.replace(/\D/g, "");
  const maskedChatId = chatDigits.length > 4 ? "***" + chatDigits.slice(-4) : "[masked]";
  const logContext = { telegramId: ownerId, sessionId: accountId, chatId: maskedChatId, messageId: incomingId };

  if (!/^\d+$/.test(ownerId) || !accountId || !whatsappChatId || !incomingId) {
    return { sent: false, reason: "invalid_input" };
  }

  // [ADDED] Prefer the configured AI Business profile for this WhatsApp session.
  // The AI Business API previously generated text for Mini App only; this worker
  // now connects that answer to the live Baileys socket.sendMessage() path.
  const businessProfile = getAIBusinessProfile(ownerId, accountId);
  const useBusinessAI = Boolean(businessProfile);
  // [ADDED] The Profile switch gates only automatic WhatsApp replies, not WAMO AI chat.
  if (useBusinessAI && !getAIBusinessAutoReplyEnabled(ownerId, accountId)) {
    return { sent: false, reason: "business_auto_reply_disabled" };
  }
  const aiStatus = useBusinessAI ? null : getAICustomerServiceStatus(ownerId, accountId);
  if (!useBusinessAI && (!aiStatus?.eligible || !aiStatus?.enabled)) {
    return { sent: false, reason: "ai_disabled" };
  }

  if (!claimAIAutoReplyJob(ownerId, accountId, whatsappChatId, incomingId)) {
    return { sent: false, reason: "duplicate" };
  }

  console.info("[WAGRAM AI Auto Reply] Processing started:", JSON.stringify({
    ...logContext, mode: useBusinessAI ? "business" : "customer_service"
  }));
  try {
    processingStage = "settle_and_load_messages";
    // [ADDED] Wait briefly so multiple customer messages sent together are
    // treated as one latest context, instead of replying to every fragment.
    await wait(AUTO_REPLY_SETTLE_MS);

    const latestMessages = listMessages(ownerId, whatsappChatId, 10, accountId)
      .filter((item) =>
        ["text", "view_once"].includes(item.message_type) &&
        item.body?.trim() &&
        !item.is_deleted
      );

    const latest = latestMessages[0];
    if (
      !latest ||
      latest.direction !== "incoming" ||
      String(latest.whatsapp_message_id) !== incomingId
    ) {
      updateAutoReply(ownerId, accountId, whatsappChatId, incomingId, {
        status: "skipped",
        error: "A newer message arrived before this reply was generated."
      });
      return { sent: false, reason: "superseded" };
    }

    if (!socket || typeof socket.sendMessage !== "function") {
      throw new Error("WHATSAPP_SOCKET_UNAVAILABLE");
    }

    // [ADDED] Build chronological conversation history for the AI Business agent.
    // listMessages returns newest-first, while the model expects oldest-first.
    const conversationHistory = listMessages(ownerId, whatsappChatId, 12, accountId)
      .filter((item) =>
        ["text", "view_once"].includes(item.message_type) &&
        item.body?.trim() &&
        !item.is_deleted &&
        String(item.whatsapp_message_id) !== incomingId
      )
      .reverse()
      .map((item) => ({
        role: item.direction === "outgoing" ? "assistant" : "user",
        content: String(item.body || "").trim().slice(0, 1000)
      }));
    const recentImageContext = getCustomerImageContext(ownerId, accountId, whatsappChatId);
    if (recentImageContext) {
      conversationHistory.push({
        role: "user",
        content: "[KONTEKS FOTO PELANGGAN TERAKHIR, dikirim " +
          new Date(Number(recentImageContext.created_at)).toISOString() +
          "]: Jenis gambar: " + recentImageContext.image_type +
          ". Deskripsi: " + recentImageContext.image_description +
          ". Gunakan konteks ini untuk memahami pertanyaan pelanggan berikutnya."
      });
    }

    processingStage = "openrouter_generate_reply";
    console.info("[WAGRAM AI Auto Reply] Generating reply:", JSON.stringify({
      ...logContext, historyMessageCount: conversationHistory.length,
      recentImageContext: Boolean(recentImageContext)
    }));
    const suggestion = useBusinessAI
      ? await createAIBusinessReply(
          ownerId,
          accountId,
          String(latest.body || "").trim(),
          conversationHistory,
          whatsappChatId
        )
      : await createAICustomerServiceSuggestion(
          ownerId,
          accountId,
          whatsappChatId,
          { autoReply: true, expectedMessageId: incomingId }
        );
    const reply = String(suggestion?.reply || suggestion?.draft || "").trim();
    console.info("[WAGRAM AI Auto Reply] Reply generated:", JSON.stringify({
      ...logContext, hasReply: Boolean(reply), replyLength: reply.length,
      model: suggestion?.model || null, needsManager: suggestion?.needsManager === true,
      hasScheduledOrder: Boolean(suggestion?.scheduledOrder)
    }));

    // [MODIFIED] Process due outbox notifications independently from the current reply.
    if (useBusinessAI) {
      await processPendingScheduledOrderNotifications({
        telegramId: ownerId, sessionId: accountId, socket, limit: 10
      });
    }

    if (useBusinessAI && suggestion?.needsManager) {
      processingStage = "manager_escalation";
      const managerQuestion = String(suggestion.managerQuestion || latest.body || "").trim();
      if (!reply) throw new Error("AI_MANAGER_NOTICE_EMPTY");

      // [MODIFIED] Escalate first; never tell the customer the manager was contacted before delivery succeeds.
      try {
        await escalateToManager({
          telegramId: ownerId,
          sessionId: accountId,
          customerChatId: whatsappChatId,
          customerPhone: String(whatsappChatId).replace(/\D/g, ""),
          customerMessageId: incomingId,
          question: managerQuestion,
          socket
        });
      } catch (error) {
        const fallbackReply = "Maaf Kak, pesanan belum tercatat dan saya belum dapat memastikan pengelola menerima permintaan ini. Silakan hubungi outlet langsung untuk memastikan pesanan.";
        await socket.sendMessage(whatsappChatId, { text: fallbackReply }, quotedMessage ? { quoted: quotedMessage } : {});
        updateAutoReply(ownerId, accountId, whatsappChatId, incomingId, {
          generatedReply: fallbackReply, status: "sent", error: null
        });
        console.error("[WAGRAM AI Manager Escalation] Delivery failed:", JSON.stringify({
          telegramId: ownerId, sessionId: accountId, customerMessageId: incomingId,
          error: String(error?.message || "AI_MANAGER_ESCALATION_FAILED").slice(0, 200)
        }));
        return { sent: true, escalated: false };
      }

      const managerNotice = reply;
      await socket.sendMessage(whatsappChatId, { text: managerNotice }, quotedMessage ? { quoted: quotedMessage } : {});
      updateAutoReply(ownerId, accountId, whatsappChatId, incomingId, {
        generatedReply: managerNotice, status: "sent", error: null
      });
      console.info("[WAGRAM AI Manager Escalation] Question sent to manager:", JSON.stringify({
        telegramId: ownerId, sessionId: accountId, customerMessageId: incomingId
      }));
      return { sent: true, escalated: true };
    }

    if (!reply) {
      throw new Error("AI_REPLY_EMPTY");
    }

    processingStage = "validate_before_customer_send";
    // [ADDED] Recheck after model generation. If a newer customer message
    // arrived while OpenRouter was responding, do not send a stale answer.
    const latestAfterGeneration = listMessages(ownerId, whatsappChatId, 10, accountId)
      .filter((item) =>
        ["text", "view_once"].includes(item.message_type) &&
        item.body?.trim() &&
        !item.is_deleted
      )[0];
    if (
      !latestAfterGeneration ||
      latestAfterGeneration.direction !== "incoming" ||
      String(latestAfterGeneration.whatsapp_message_id) !== incomingId
    ) {
      updateAutoReply(ownerId, accountId, whatsappChatId, incomingId, {
        status: "skipped",
        error: "A newer message arrived while the AI was generating the reply."
      });
      return { sent: false, reason: "superseded_during_generation" };
    }

    // [ADDED] Recheck the selected AI mode before sending.
    const latestBusinessProfile = useBusinessAI
      ? getAIBusinessProfile(ownerId, accountId)
      : null;
    const latestBusinessAutoReplyEnabled = useBusinessAI
      ? getAIBusinessAutoReplyEnabled(ownerId, accountId)
      : true;
    const latestAIStatus = useBusinessAI
      ? null
      : getAICustomerServiceStatus(ownerId, accountId);
    if (
      (useBusinessAI && (!latestBusinessProfile || !latestBusinessAutoReplyEnabled)) ||
      (!useBusinessAI && (!latestAIStatus?.eligible || !latestAIStatus?.enabled))
    ) {
      updateAutoReply(ownerId, accountId, whatsappChatId, incomingId, {
        status: "skipped",
        error: "The selected AI mode was disabled before the reply was sent."
      });
      return { sent: false, reason: "ai_disabled_during_generation" };
    }

    // [ADDED] Persist the exact generated text before sending so the outgoing
    // Baileys event cannot accidentally teach the AI its own generated answer.
    updateAutoReply(ownerId, accountId, whatsappChatId, incomingId, {
      generatedReply: reply
    });

    processingStage = "send_customer_reply";
    const sendOptions = quotedMessage ? { quoted: quotedMessage } : {};
    // [ADDED] Send the generated AI Business/Customer Service answer through Baileys.
    // Attach the saved QRIS image when the AI Business response explicitly includes it.
    let sentMessage;
    const qrisDataUri = String(suggestion?.qrisImage || "");
    const qrisMatch = qrisDataUri.match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/);
    if (useBusinessAI && qrisMatch) {
      sentMessage = await socket.sendMessage(
        whatsappChatId,
        {
          image: Buffer.from(qrisMatch[2], "base64"),
          mimetype: qrisMatch[1] === "jpg" ? "image/jpeg" : `image/${qrisMatch[1]}`,
          caption: reply
        },
        sendOptions
      );
    } else {
      sentMessage = await socket.sendMessage(
        whatsappChatId,
        { text: reply },
        sendOptions
      );
    }

    updateAutoReply(ownerId, accountId, whatsappChatId, incomingId, {
      status: "sent",
      replyMessageId: sentMessage?.key?.id || null,
      error: null
    });
    processingStage = "completed";

    console.info(
      "[WAGRAM AI Auto Reply] Reply sent once:",
      JSON.stringify({
        telegramId: ownerId,
        sessionId: accountId,
        messageId: incomingId,
        mode: useBusinessAI ? "business" : "customer_service",
        model: suggestion.model || aiStatus?.model || null
      })
    );

    return { sent: true, replyMessageId: sentMessage?.key?.id || null };
  } catch (error) {
    // [ADDED] Keep the claim after failure. A repeated event must not send a
    // second reply for the same incoming message.
    updateAutoReply(ownerId, accountId, whatsappChatId, incomingId, {
      status: "failed",
      error: error.message || "AUTO_REPLY_FAILED"
    });

    console.error(
      "[WAGRAM AI Auto Reply] Failed:",
      JSON.stringify({
        telegramId: ownerId,
        sessionId: accountId,
        messageId: incomingId,
        stage: processingStage,
        errorName: String(error?.name || "Error"),
        httpStatus: Number(error?.httpStatus) || null,
        requestId: error?.requestId || null,
        providerRequestId: error?.providerRequestId || null,
        error: String(error?.message || "AUTO_REPLY_FAILED").slice(0, 500)
      })
    );

    return { sent: false, reason: "failed" };
  }
}
