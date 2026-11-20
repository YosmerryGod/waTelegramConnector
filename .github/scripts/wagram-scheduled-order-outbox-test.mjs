import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// [ADDED] Run outbox integration checks against an isolated SQLite database.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "wagram-order-outbox-"));
process.env.SQLITE_PATH = path.join(tempDir, "test.sqlite");

const database = await import("../../src/database.js");
const { processPendingScheduledOrderNotifications } = await import("../../src/ai/auto-reply.js");
const db = database.default;
const ownerId = "99001";
const sessionId = "session-outbox";
const now = Date.now();

try {
  db.prepare(`
    INSERT INTO telegram_users (telegram_id, username, first_name, created_at, updated_at, is_active)
    VALUES (?, ?, ?, ?, ?, 1)
  `).run(ownerId, "outbox-test", "Outbox Test", now, now);
  db.prepare(`
    INSERT INTO ai_business_profiles (telegram_id, session_id, settings_json, updated_at)
    VALUES (?, ?, ?, ?)
  `).run(ownerId, sessionId, JSON.stringify({ manager: { phone: "628123456789" } }), now);

  const orderId = Number(db.prepare(`
    INSERT INTO ai_scheduled_orders (
      telegram_id, session_id, customer_chat_id, customer_name, outlet_name,
      outlet_address, pickup_at, timezone, items_json, total_amount,
      payment_status, payment_note, fingerprint, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    ownerId, sessionId, "628111111111@s.whatsapp.net", "Pelanggan Uji",
    "Outlet Uji", "Alamat Uji", "2026-12-01T12:30:00+07:00", "Asia/Jakarta",
    JSON.stringify([{ name: "Ayam Panggang", quantity: 2, subtotal: 50000 }]),
    50000, "unpaid", "Bayar di tempat", "outbox-test-fingerprint", now
  ).lastInsertRowid);

  db.prepare(`
    INSERT INTO ai_scheduled_order_outbox
      (order_id, telegram_id, session_id, status, created_at, updated_at)
    VALUES (?, ?, ?, 'pending', ?, ?)
  `).run(orderId, ownerId, sessionId, now, now);

  let delivered = 0;
  const socket = {
    async sendMessage(jid, payload) {
      delivered += 1;
      assert.equal(jid, "628123456789@s.whatsapp.net");
      assert.match(payload.text, /PESANAN TERJADWAL/);
      return { key: { id: "manager-message-1" } };
    }
  };

  const first = await processPendingScheduledOrderNotifications({ telegramId: ownerId, sessionId, socket });
  assert.equal(first.sent, 1, "A due outbox entry must be delivered.");
  assert.equal(delivered, 1);
  assert.equal(db.prepare("SELECT status FROM ai_scheduled_order_outbox WHERE order_id = ?").get(orderId).status, "sent");
  assert.equal(db.prepare("SELECT notification_status FROM ai_scheduled_orders WHERE id = ?").get(orderId).notification_status, "sent");

  const second = await processPendingScheduledOrderNotifications({ telegramId: ownerId, sessionId, socket });
  assert.equal(second.sent, 0, "A sent outbox entry must not be delivered again.");
  assert.equal(delivered, 1, "The manager must not receive a duplicate after successful delivery.");

  const failedOrderId = Number(db.prepare(`
    INSERT INTO ai_scheduled_orders (
      telegram_id, session_id, customer_chat_id, customer_name, outlet_name,
      outlet_address, pickup_at, timezone, items_json, total_amount,
      payment_status, payment_note, fingerprint, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    ownerId, sessionId, "628111111111@s.whatsapp.net", "Pelanggan Gagal",
    "Outlet Uji", "Alamat Uji", "2026-12-01T12:30:00+07:00", "Asia/Jakarta",
    JSON.stringify([{ name: "Ayam Panggang", quantity: 1, subtotal: 25000 }]),
    25000, "unpaid", "Bayar di tempat", "outbox-failure-fingerprint", now + 1
  ).lastInsertRowid);
  db.prepare(`
    INSERT INTO ai_scheduled_order_outbox
      (order_id, telegram_id, session_id, status, created_at, updated_at)
    VALUES (?, ?, ?, 'pending', ?, ?)
  `).run(failedOrderId, ownerId, sessionId, now + 1, now + 1);

  const failed = await processPendingScheduledOrderNotifications({
    telegramId: ownerId, sessionId,
    socket: { async sendMessage() { throw new Error("SIMULATED_WHATSAPP_FAILURE"); } }
  });
  assert.equal(failed.failed, 1, "A failed send must be recorded for retry.");
  const retryState = db.prepare("SELECT status, attempts, next_attempt_at, last_error FROM ai_scheduled_order_outbox WHERE order_id = ?").get(failedOrderId);
  assert.equal(retryState.status, "pending");
  assert.equal(retryState.attempts, 1);
  assert.ok(retryState.next_attempt_at > Date.now());
  assert.match(retryState.last_error, /SIMULATED_WHATSAPP_FAILURE/);

  db.prepare("UPDATE ai_scheduled_order_outbox SET next_attempt_at = 0 WHERE order_id = ?").run(failedOrderId);
  const recovered = await processPendingScheduledOrderNotifications({ telegramId: ownerId, sessionId, socket });
  assert.equal(recovered.sent, 1, "A failed notification must be retried successfully when due.");
  assert.equal(db.prepare("SELECT status FROM ai_scheduled_order_outbox WHERE order_id = ?").get(failedOrderId).status, "sent");

  console.log("PASS: scheduled-order outbox persistence, retry, successful delivery, and duplicate suppression.");
} finally {
  database.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
}
