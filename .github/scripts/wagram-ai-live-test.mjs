import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const appDir = path.resolve(process.env.WAGRAM_APP_DIR || "/opt/waTelegramConnector");
process.chdir(appDir);

const databaseUrl = pathToFileURL(path.join(appDir, "src/database.js")).href;
const aiUrl = pathToFileURL(path.join(appDir, "src/ai/customer-service.js")).href;

const database = await import(databaseUrl);
const ai = await import(aiUrl);

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
console.log("Ollama model:", process.env.OLLAMA_MODEL || "qwen2.5:1.5b");

const results = [];
const normalize = (value) => String(value || "").toLocaleLowerCase("id-ID");

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
