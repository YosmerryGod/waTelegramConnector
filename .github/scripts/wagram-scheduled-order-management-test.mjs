import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// [ADDED] Exercise manager-only scheduled-order commands against an isolated SQLite database.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "wagram-order-management-"));
process.env.SQLITE_PATH = path.join(tempDir, "test.sqlite");
const database = await import("../../src/database.js");
const { handleIncomingManagerReply } = await import("../../src/ai/auto-reply.js");
const db = database.default;
const ownerId = "99002";
const sessionId = "session-management";
const managerJid = "628123456789@s.whatsapp.net";
const customerJid = "628111111111@s.whatsapp.net";
const now = Date.now();

async function managerCommand(text) {
  const sent = [];
  const result = await handleIncomingManagerReply({
    telegramId: ownerId,
    sessionId,
    chatId: managerJid,
    message: { key: { remoteJid: managerJid }, message: { conversation: text } },
    socket: { async sendMessage(jid, payload) { sent.push({ jid, payload }); return { key: { id: "manager-reply" } }; } }
  });
  return { result, sent };
}

try {
  db.prepare(`
    INSERT INTO telegram_users (telegram_id, username, first_name, created_at, updated_at, is_active)
    VALUES (?, ?, ?, ?, ?, 1)
  `).run(ownerId, "management-test", "Management Test", now, now);
  db.prepare(`
    INSERT INTO ai_business_profiles (telegram_id, session_id, settings_json, updated_at)
    VALUES (?, ?, ?, ?)
  `).run(ownerId, sessionId, JSON.stringify({ manager: { phone: "628123456789" } }), now);

  const orderId = Number(db.prepare(`
    INSERT INTO ai_scheduled_orders (
      telegram_id, session_id, customer_chat_id, customer_name, outlet_name,
      outlet_address, pickup_at, timezone, items_json, total_amount,
      payment_status, payment_note, fingerprint, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    ownerId, sessionId, customerJid, "Pelanggan Uji", "Outlet Uji", "Alamat Uji",
    "2026-12-01T12:30:00+07:00", "Asia/Jakarta",
    JSON.stringify([{ name: "Ayam Panggang", quantity: 2, subtotal: 50000 }]),
    50000, "pending_verification", "Menunggu verifikasi", "management-test", now, now
  ).lastInsertRowid);

  const list = await managerCommand("#pesanan");
  assert.equal(list.result.handled, true);
  assert.match(list.sent[0].payload.text, new RegExp("#" + orderId));

  const process = await managerCommand("#proses " + orderId);
  assert.equal(process.result.success, true);
  assert.equal(db.prepare("SELECT order_status FROM ai_scheduled_orders WHERE id = ?").get(orderId).order_status, "preparing");

  const ready = await managerCommand("#siap " + orderId);
  assert.equal(ready.result.success, true);
  assert.equal(db.prepare("SELECT order_status FROM ai_scheduled_orders WHERE id = ?").get(orderId).order_status, "ready");

  const verify = await managerCommand("#verifikasi " + orderId);
  assert.equal(verify.result.success, true);
  assert.ok(db.prepare("SELECT payment_verified_at FROM ai_scheduled_orders WHERE id = ?").get(orderId).payment_verified_at);

  const complete = await managerCommand("#selesai " + orderId);
  assert.equal(complete.result.success, true);
  const completed = db.prepare("SELECT order_status, completed_at FROM ai_scheduled_orders WHERE id = ?").get(orderId);
  assert.equal(completed.order_status, "completed");
  assert.ok(completed.completed_at);

  const cancelCompleted = await managerCommand("#batal " + orderId);
  assert.equal(cancelCompleted.result.success, false);
  assert.equal(db.prepare("SELECT order_status FROM ai_scheduled_orders WHERE id = ?").get(orderId).order_status, "completed");

  const unauthorized = await handleIncomingManagerReply({
    telegramId: ownerId,
    sessionId,
    chatId: customerJid,
    message: { key: { remoteJid: customerJid }, message: { conversation: "#pesanan" } },
    socket: { async sendMessage() { throw new Error("Unauthorized sender must not receive a manager response"); } }
  });
  assert.equal(unauthorized.handled, false);

  console.log("PASS: manager-only order listing, status transitions, payment verification, and invalid transition rejection.");
} finally {
  database.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
}
