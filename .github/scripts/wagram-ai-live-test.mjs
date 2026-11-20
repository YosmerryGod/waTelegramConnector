import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const appDir = path.resolve(process.env.WAGRAM_APP_DIR || "/opt/waTelegramConnector");
process.chdir(appDir);

const databaseUrl = pathToFileURL(path.join(appDir, "src/database.js")).href;
const aiUrl = pathToFileURL(path.join(appDir, "src/ai/customer-service.js")).href;
const autoReplyUrl = pathToFileURL(path.join(appDir, "src/ai/auto-reply.js")).href;

const database = await import(databaseUrl);
const ai = await import(aiUrl);
const autoReply = await import(autoReplyUrl);
const db = database.default;

const activeUsers = database.getAllActiveUsers();
const premiumUsers = activeUsers.filter((user) => {
  const membership = database.getMembership(user.telegram_id);
  return membership?.plan === "premium-c";
});

assert.equal(
  premiumUsers.length,
  1,
  `Expected exactly one active Premium C user, found ${premiumUsers.length}. Check account membership before testing.`
);

const owner = premiumUsers[0];
const accounts = database.getWhatsAppAccounts(owner.telegram_id);
assert.ok(accounts.length > 0, "Premium C user has no WhatsApp account.");

const sessionCandidates = accounts.map((account) => ({
  account,
  profile: database.getAIBusinessProfile(owner.telegram_id, account.session_id)
}));

const selected = sessionCandidates.find(({ profile }) => {
  const settings = profile?.settings || {};
  return Boolean(
    settings.manager?.name ||
    (Array.isArray(settings.products) && settings.products.length) ||
    (Array.isArray(settings.outlets) && settings.outlets.length) ||
    settings.payment?.merchant
  );
}) || sessionCandidates.find(({ account }) => account.is_primary) || sessionCandidates[0];

const sessionId = selected.account.session_id;
const profile = selected.profile;
const settings = profile?.settings || {};
const manager = settings.manager || {};
const managerName = String(manager.name || manager.fullName || "").trim();
const products = Array.isArray(settings.products)
  ? settings.products.filter((item) => item?.name)
  : [];

console.log("=== WAGRAM AI VPS LIVE TEST ===");
console.log("Active users:", activeUsers.length);
console.log("Premium C users:", premiumUsers.length);
console.log("WhatsApp accounts for Premium C:", accounts.length);
console.log("Selected session:", selected.account.is_primary ? "primary" : "additional");
console.log("AI profile:", profile ? "found" : "NOT FOUND");
console.log("Manager data:", managerName ? "available" : "empty");
console.log("Product records:", products.length);
console.log("OpenRouter model:", process.env.OPENROUTER_MODEL || "deepseek/deepseek-v4.1-flash-1017");

const results = [];
const normalize = (value) => String(value || "").toLocaleLowerCase("id-ID");

// [ADDED] Regression checks for supported real WhatsApp JID namespaces.
for (const jid of ["6281234567890@s.whatsapp.net", "123456789012345@lid", "123456789012345@hosted", "123456789012345@hosted.lid"]) {
  assert.ok(ai.normalizeCustomerChatJid(jid), "Supported customer JID was rejected: " + jid);
}
for (const jid of ["123456789@g.us", "status@broadcast", "sim-123@sim", ""]) {
  assert.equal(ai.normalizeCustomerChatJid(jid), null, "Non-customer JID was accepted: " + jid);
}

console.log("PASS: WhatsApp JID normalization (@s.whatsapp.net, @lid, @hosted)");

// [ADDED] Force a truncated OpenRouter JSON response and verify only the extracted reply is returned.
if (process.env.OPENROUTER_API_KEY) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    id: "wagram-truncated-json-test",
    provider: "DeepSeek",
    model: process.env.OPENROUTER_MODEL || "deepseek/deepseek-v4.1-flash-1017",
    choices: [{
      finish_reason: "length",
      message: { content: '{"reply":"Halo Kak, ada yang bisa saya bantu?","needs_manager":false,"manager_question":"' }
    }],
    usage: { completion_tokens: 1500, reasoning_tokens: 250 }
  }), { status: 200, headers: { "content-type": "application/json" } });
  try {
    const truncated = await ai.createAIBusinessReply(owner.telegram_id, sessionId, "halo", [], "", { isSimulation: true });
    assert.equal(truncated.reply, "Halo Kak, ada yang bisa saya bantu?");
    assert.ok(!String(truncated.reply).startsWith("{"));
    console.log("PASS: truncated JSON never reaches the customer reply");
  } finally {
    globalThis.fetch = originalFetch;
  }
} else {
  console.log("SKIP: truncated JSON test requires OPENROUTER_API_KEY.");
}

// [ADDED] Test durable simulated-order and failed-order reports using a mock socket.
if (String(manager.phone || "").trim()) {
  const now = Date.now();
  const fingerprint = "wagram-live-sim-test-" + now;
  const inserted = db.prepare(`
    INSERT INTO ai_scheduled_orders (
      telegram_id, session_id, customer_chat_id, customer_name, outlet_name,
      outlet_address, pickup_at, timezone, items_json, total_amount,
      payment_status, payment_note, fingerprint, is_simulation, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
  `).run(
    String(owner.telegram_id), String(sessionId), "sim-" + owner.telegram_id + "@sim",
    "WAGRAM Test Simulation", "Outlet Test", "Alamat Test",
    new Date(now + 86400000).toISOString(), "Asia/Jakarta",
    JSON.stringify([{ name: "Menu Test", quantity: 1, unitPrice: 1000, subtotal: 1000 }]),
    1000, "unpaid", "Bayar di tempat", fingerprint, now, now
  );
  const testOrderId = Number(inserted.lastInsertRowid);
  db.prepare(`
    INSERT INTO ai_scheduled_order_outbox (order_id, telegram_id, session_id, status, created_at, updated_at)
    VALUES (?, ?, ?, 'pending', ?, ?)
  `).run(testOrderId, String(owner.telegram_id), String(sessionId), now, now);
  const failureInsert = db.prepare(`
    INSERT INTO ai_scheduled_order_failure_outbox (
      telegram_id, session_id, report_json, error_code, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'pending', ?, ?)
  `).run(
    String(owner.telegram_id), String(sessionId),
    JSON.stringify({
      customerName: "WAGRAM Failure Test", customerChatId: "SIMULASI",
      items: [{ name: "Menu Test", quantity: 2, subtotal: 2000 }],
      totalAmount: 2000, outletName: "Outlet Test",
      pickupAt: new Date(now + 86400000).toISOString(),
      paymentStatus: "unpaid", isSimulation: true
    }),
    "TEST_FAILURE_CODE", now, now
  );
  const delivered = [];
  try {
    const drain = await autoReply.processPendingScheduledOrderNotifications({
      telegramId: owner.telegram_id, sessionId,
      socket: { sendMessage: async (jid, payload) => { delivered.push({ jid, text: payload.text }); return { key: { id: "mock-" + delivered.length } }; } },
      limit: 10
    });
    assert.ok(delivered.some((item) => item.text.includes("[SIMULASI] PESANAN TERJADWAL")), "Simulated successful order was not delivered to the manager outbox.");
    assert.ok(delivered.some((item) => item.text.includes("[SIMULASI] PESANAN GAGAL DISIMPAN") && /catat manual/i.test(item.text)), "Failed order did not produce a manual-entry manager report.");
    assert.ok(delivered.every((item) => !item.jid.includes("@sim")), "Outbox attempted to send to a synthetic customer JID.");
    assert.ok(drain.sent >= 2, "Expected both simulated-order and failed-order outbox messages to be sent.");
    console.log("PASS: simulation order outbox and failed-order manager report");
  } finally {
    db.prepare("DELETE FROM ai_scheduled_order_outbox WHERE order_id = ?").run(testOrderId);
    db.prepare("DELETE FROM ai_scheduled_orders WHERE id = ?").run(testOrderId);
    db.prepare("DELETE FROM ai_scheduled_order_failure_outbox WHERE id = ?").run(Number(failureInsert.lastInsertRowid));
  }
} else {
  console.log("SKIP: outbox delivery regression tests require manager.phone in the selected profile.");
}

async function test(name, message, validate, history = []) {
  console.log(`\n--- ${name} ---`);
  const response = await ai.createAIBusinessReply(
    owner.telegram_id,
    sessionId,
    message,
    history
  );
  const reply = String(response.reply || "").trim();
  assert.ok(reply, `${name}: AI returned an empty response.`);
  assert.ok(!reply.startsWith("{") && !reply.startsWith("["), `${name}: raw JSON reached the customer reply.`);
  assert.ok(!/CUSTOMER_CHAT_INVALID|SCHEDULED_ORDER_[A-Z_]+|OPENROUTER_HTTP_|\\berror\\b|\\bJSON\\b/i.test(reply), `${name}: technical details reached the customer reply.`);
  console.log("Intent:", response.intent || "not reported");
  console.log("AI reply:", reply);
  validate(reply, response);
  results.push({ name, status: "PASS", intent: response.intent, reply });
  console.log("RESULT: PASS");
}

const failures = [];
async function runTest(name, message, validate) {
  try {
    await test(name, message, validate);
  } catch (error) {
    failures.push({ name, error: error.message });
    results.push({ name, status: "FAIL", error: error.message });
    console.error("RESULT: FAIL -", error.message);
  }
}

await runTest("Capabilities", "Hello, apa saja yang bisa kamu lakukan?", (reply, response) => {
  assert.equal(response.intent, "capabilities", "Capabilities intent was not detected.");
  assert.ok(
    !/informasi tersebut belum tersedia dalam data usaha/i.test(reply),
    "Capabilities question incorrectly received the missing-business-data fallback."
  );
});

await runTest("Manager", "Siapa manager saya?", (reply) => {
  if (managerName) {
    assert.ok(normalize(reply).includes(normalize(managerName)),
      "AI did not mention the manager name stored in the selected session profile.");
  } else {
    assert.ok(/belum|tidak tersedia|tidak ada|kosong/i.test(reply),
      "Manager data is empty, but AI did not acknowledge that.");
  }
});

await runTest(
  "Manager follow-up context",
  "Dan nomor teleponnya?",
  (reply) => {
    const managerPhone = String(manager.phone || "").trim();
    if (managerPhone) {
      assert.ok(reply.replace(/[^0-9+]/g, "").includes(managerPhone.replace(/[^0-9+]/g, "")),
        "AI did not resolve the manager phone follow-up from conversation context.");
    } else {
      assert.ok(/belum|tidak tersedia|tidak ada|kosong/i.test(reply),
        "Manager phone is empty, but AI did not acknowledge that.");
    }
  },
  [
    { role: "user", content: "Siapa manager saya?" },
    { role: "assistant", content: managerName ? `Manager kamu adalah ${managerName}.` : "Data manager belum tersedia." }
  ]
);

await runTest("Products", "Apa saja menu atau produk yang tersedia?", (reply) => {
  if (products.length) {
    const knownNames = products.map((item) => normalize(item.name));
    assert.ok(knownNames.some((name) => normalize(reply).includes(name)),
      "AI did not mention any product stored in the selected session profile.");
  } else {
    assert.ok(/belum|tidak tersedia|tidak ada|kosong/i.test(reply),
      "Product data is empty, but AI did not acknowledge that.");
    assert.ok(!/\b(burger|pizza|salad)\b/i.test(reply),
      "AI invented sample product names while the product list is empty.");
  }
});

console.log("\n=== TEST SUMMARY ===");
for (const result of results) {
  console.log(`${result.status}: ${result.name}${result.intent ? ` [${result.intent}]` : ""}`);
}
console.log(`Passed: ${results.filter((item) => item.status === "PASS").length}/${results.length}`);
console.log(`Failed: ${failures.length}`);

if (failures.length) {
  for (const failure of failures) {
    console.error(`::error title=${failure.name}::${failure.error}`);
  }
  process.exitCode = 1;
} else {
  console.log("ALL WAGRAM AI LIVE TESTS PASSED.");
}
