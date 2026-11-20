import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// [ADDED] Keep the confirmation test isolated from the configured business database.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "wagram-order-confirmation-"));
process.env.SQLITE_PATH = path.join(tempDir, "test.sqlite");

const database = await import("../../src/database.js");
const { buildAIBusinessDecisionContext, buildConversationRecognition, buildScheduledOrderFallbackReply, normalizeOpenRouterMessageContent, normalizeCustomerChatJid, validateScheduledOrderConfirmation } = await import("../../src/ai/customer-service.js");

const order = {
  outletName: "Outlet Banjarbaru",
  pickupAt: "2026-12-01T12:30:00+07:00",
  timezone: "Asia/Jakarta",
  items: [{ name: "Ayam Panggang", quantity: 2 }],
  totalAmount: 50000,
  paymentStatus: "unpaid"
};
const approvedSummary = {
  role: "assistant",
  content: "Ringkasan pesanan: Outlet Banjarbaru, Ayam Panggang x2, total Rp50.000, ambil 01/12/2026 pukul 12:30 WIB, pembayaran belum dibayar dan bayar di tempat."
};

try {
  assert.equal(normalizeOpenRouterMessageContent("  respons teks  "), "respons teks");
  assert.equal(normalizeOpenRouterMessageContent([{ text: "bagian satu" }, { type: "text", text: "bagian dua" }]), "bagian satu\nbagian dua");
  assert.equal(normalizeOpenRouterMessageContent(null), "");

  const decisionContext = buildAIBusinessDecisionContext({
    message: "Saya mau pesan ayam panggang 3 porsi di Outlet Banjarbaru",
    history: [{ role: "user", content: "Saya mau pesan ayam panggang" }],
    businessData: {
      outlets: [{ name: "Outlet Banjarbaru", timezone: "Asia/Makassar" }],
      products: [
        { name: "Ayam Panggang", price: 45000, stock: 8 },
        { name: "Nasi Putih", price: 6000, stock: 20 }
      ]
    },
    recognition: { intent: "purchase_intent", interpretation: "Pelanggan ingin memesan ayam panggang." },
    toolAudit: [{ tool: "read_business_profile" }],
    decisionSummary: { action: "Memeriksa opsi pelengkap.", marketingProduct: "Nasi Putih", saveToDatabase: true },
    createdScheduledOrder: null
  });
  assert.equal(decisionContext.time.zoneLabel, "WITA");
  assert.equal(decisionContext.time.timezone, "Asia/Makassar");
  assert.equal(decisionContext.psychologySkill.id, "human-behavior-decision-psychology");
  assert.equal(decisionContext.marketingSkill.id, "consumer-psychology-and-persuasion");
  assert.equal(decisionContext.productCheck.status, "checked");
  assert.equal(decisionContext.productCheck.availableProducts.length, 2);
  assert.equal(decisionContext.database.shouldSave, false, "The model must not authorize business database writes.");
  assert.equal(decisionContext.database.label, "Tidak");

  const complaintDecision = buildAIBusinessDecisionContext({
    message: "Saya kecewa ayamnya kering",
    history: [],
    businessData: { outlets: [], products: [] },
    recognition: { intent: "conversation", interpretation: "Pelanggan menyampaikan keluhan." },
    toolAudit: [],
    decisionSummary: null,
    createdScheduledOrder: null
  });
  assert.equal(complaintDecision.marketingSkill.id, "service-recovery-marketing-and-trust-building");
  assert.equal(complaintDecision.productCheck.status, "not_required");

  const savedOrderDecision = buildAIBusinessDecisionContext({
    message: "iya setuju",
    history: [],
    businessData: { outlets: [], products: [] },
    recognition: { intent: "purchase_intent", interpretation: "Persetujuan pesanan." },
    toolAudit: [],
    decisionSummary: null,
    createdScheduledOrder: { id: 12 }
  });
  assert.equal(savedOrderDecision.database.shouldSave, true);
  assert.equal(savedOrderDecision.database.label, "Ya");

  const orderContext = buildConversationRecognition("pesen ayam panggang apakah bisa kak", [
    { role: "user", content: "saya mau pesan ayam panggang 3 porsi" },
    { role: "assistant", content: "Maaf, saya sedang memeriksa pesanan." }
  ]);
  assert.equal(orderContext.intent, "purchase_intent", "The classifier hint must retain purchase intent from conversation history.");
  assert.equal(orderContext.needs_business_data, true);
  assert.equal(orderContext.context_message_count, 2);
  assert.equal(
    buildConversationRecognition("saya mau pesan ayam panggang 3 porsi", []).intent,
    "purchase_intent",
    "A direct order request must be recognized without a separate model call."
  );
  assert.equal(
    buildConversationRecognition("halo kak", []).intent,
    "conversation",
    "A greeting must not be forced into a business-question intent."
  );
  assert.equal(buildScheduledOrderFallbackReply({ id: 42, paymentStatus: "unpaid" }), "Pesanan #42 sudah berhasil dicatat, Kak. Pembayaran di tempat.");
  assert.equal(buildScheduledOrderFallbackReply({ id: 43, paymentStatus: "pending_verification" }), "Pesanan #43 sudah berhasil dicatat, Kak. Pembayaran menunggu verifikasi pengelola.");
  assert.equal(buildScheduledOrderFallbackReply(null), "");

  assert.equal(normalizeCustomerChatJid("6281234567890@s.whatsapp.net"), "6281234567890@s.whatsapp.net");
  assert.equal(normalizeCustomerChatJid("6281234567890:17@s.whatsapp.net"), "6281234567890@s.whatsapp.net");
  assert.equal(normalizeCustomerChatJid("123456789012345@lid"), "123456789012345@lid");
  assert.equal(normalizeCustomerChatJid("123456789012345:4@lid"), "123456789012345@lid");
  assert.equal(normalizeCustomerChatJid("6281234567890@g.us"), null, "Group JIDs must not be accepted.");
  assert.equal(normalizeCustomerChatJid("status@broadcast"), null, "Broadcast JIDs must not be accepted.");
  assert.equal(normalizeCustomerChatJid("6281234567890:device@s.whatsapp.net"), null, "Malformed device JIDs must be rejected.");
  assert.equal(normalizeCustomerChatJid("12345@s.whatsapp.net"), null, "Invalid phone JIDs must be rejected.");
  assert.equal(normalizeCustomerChatJid(""), null);

  assert.equal(
    validateScheduledOrderConfirmation({ ...order, message: "Iya", history: [approvedSummary] }).valid,
    true,
    "An explicit approval after a matching complete summary must pass."
  );
  assert.equal(
    validateScheduledOrderConfirmation({ ...order, message: "Iya, tapi ganti outlet", history: [approvedSummary] }).valid,
    false,
    "A mixed or conditional response must not count as approval."
  );
  assert.equal(
    validateScheduledOrderConfirmation({ ...order, message: "Iya", history: [{ ...approvedSummary, content: "Mau pesan Ayam Panggang x2." }] }).valid,
    false,
    "Approval without a complete matching summary must be rejected."
  );
  assert.equal(
    validateScheduledOrderConfirmation({ ...order, message: "Oke", history: [approvedSummary], totalAmount: 60000 }).valid,
    false,
    "A summary with a different total must be rejected."
  );
  assert.equal(
    validateScheduledOrderConfirmation({ ...order, message: "Mungkin", history: [approvedSummary] }).valid,
    false,
    "An ambiguous response must not count as approval."
  );

  console.log("PASS: scheduled order approval requires explicit customer confirmation and a matching complete summary.");
} finally {
  database.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
}
