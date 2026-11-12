import assert from "node:assert/strict";

const apiBase = process.env.WAGRAM_API_BASE.replace(/\/+$/, "");
const initData = process.env.WAGRAM_INIT_DATA;
const sessionId = process.env.WAGRAM_SESSION_ID;

const headers = {
  "X-Telegram-Init-Data": initData,
  "X-WAGRAM-Session-ID": sessionId,
  "Content-Type": "application/json"
};

async function request(path, options = {}) {
  const response = await fetch(`${apiBase}${path}`, {
    ...options,
    headers: { ...headers, ...(options.headers || {}) },
    signal: AbortSignal.timeout(90000)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) {
    throw new Error(`${path} failed (${response.status}): ${payload.error || payload.message || "unknown error"}`);
  }
  return payload;
}

function normalized(value) {
  return String(value || "").toLocaleLowerCase("id-ID");
}

const settingsResponse = await request("/ai-business/settings");
const settings = settingsResponse.profile?.settings || {};
const manager = settings.manager || {};
const managerName = String(manager.name || manager.fullName || "").trim();
const products = Array.isArray(settings.products) ? settings.products.filter((item) => item?.name) : [];

console.log("Loaded business profile for the configured Premium C session.");
console.log(`Manager data: ${managerName ? "available" : "empty"}`);
console.log(`Product data: ${products.length} item(s)`);

async function ask(message, history = []) {
  const result = await request("/ai-business/chat", {
    method: "POST",
    body: JSON.stringify({ message, history })
  });
  const reply = String(result.reply || "").trim();
  assert.ok(reply.length > 0, `Empty AI reply for: ${message}`);
  console.log(`PASS response received: ${message} [intent=${result.intent || "not reported"}]`);
  return { reply, intent: result.intent, result };
}

// 1) Capabilities question must not be treated as missing business data.
const capability = await ask("Hello, apa saja yang bisa kamu lakukan?");
assert.equal(capability.intent, "capabilities", "Capabilities question was classified incorrectly.");
assert.ok(!/informasi tersebut belum tersedia dalam data usaha/i.test(capability.reply),
  "Capabilities question incorrectly returned the empty-business-data fallback.");

// 2) Manager answer must follow the actual server-side profile.
const managerReply = await ask("Siapa manager saya?");
if (managerName) {
  assert.ok(normalized(managerReply.reply).includes(normalized(managerName)),
    "Manager reply did not include the manager name stored in the server profile.");
} else {
  assert.ok(/belum|tidak tersedia|tidak ada|kosong/i.test(managerReply.reply),
    "Manager data is empty, but the AI did not clearly say the information is unavailable.");
}

// 3) Empty product list must never produce invented menu names.
const menuReply = await ask("Apa saja menu atau produk yang tersedia?");
if (products.length === 0) {
  assert.ok(/belum|tidak tersedia|tidak ada|kosong/i.test(menuReply.reply),
    "Product data is empty, but the AI did not report that honestly.");
  assert.ok(!/\b(burger|pizza|salad)\b/i.test(menuReply.reply),
    "AI invented sample menu names while the product list is empty.");
} else {
  const knownNames = products.map((item) => normalized(item.name));
  assert.ok(knownNames.some((name) => normalized(menuReply.reply).includes(name)),
    "Menu reply did not mention any product stored in the server profile.");
}

console.log("ALL WAGRAM AI LIVE TESTS PASSED.");
