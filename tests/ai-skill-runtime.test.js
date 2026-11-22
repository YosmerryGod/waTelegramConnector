import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "wagram-skill-runtime-"));
process.env.SQLITE_PATH = path.join(temporaryDirectory, "test.sqlite");

let runtime;

before(async () => {
  runtime = await import("../src/ai/skills/runtime.js");
});

after(() => {
  try {
    runtime?.default?.close?.();
  } catch {
    // The database connection is owned by the shared database module.
  }
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});

test("routes service recovery and caps active skills at three", () => {
  const result = runtime.routeAndLoadSkills({
    message: "Pelanggan komplain karena ayam kering dan kecewa dengan pesanan",
    mode: "customer-auto-reply"
  });
  assert.ok(result.activeSkillIds.includes("service-recovery"));
  assert.ok(result.loadedSkills.length <= 3);
  assert.equal(result.mode, "customer-auto-reply");
  assert.ok(result.instructions.includes("Service Recovery"));
});

test("loads communication and psychology for greetings", () => {
  const result = runtime.routeAndLoadSkills({ message: "halo", history: [], mode: "customer-auto-reply" });
  assert.deepEqual(result.activeSkillIds, ["customer-communication", "consumer-psychology"]);
  assert.deepEqual(result.customerIntents, ["greeting"]);
});

test("creates proposals and isolates them by owner and WhatsApp session", () => {
  const created = runtime.createSkillChangeProposal({
    telegramId: "owner-1",
    sessionId: "session-a",
    skillId: "customer-communication",
    proposal: "Gunakan bahasa yang lebih ringkas",
    evidenceSummary: "Contoh balasan terlalu panjang"
  });
  assert.equal(created.status, "pending");
  assert.equal(runtime.listSkillChangeProposals("owner-1", "session-a").length, 1);
  assert.equal(runtime.listSkillChangeProposals("owner-1", "session-b").length, 0);
  assert.equal(runtime.listSkillChangeProposals("owner-2", "session-a").length, 0);
});

test("records approval and prevents reviewing the same proposal twice", () => {
  const created = runtime.createSkillChangeProposal({
    telegramId: "owner-3",
    sessionId: "session-c",
    skillId: "service-recovery",
    proposal: "Tampilkan langkah perbaikan secara spesifik",
    evidenceSummary: "Pemilik meminta jawaban komplain lebih bertanggung jawab"
  });
  const approved = runtime.reviewSkillChangeProposal({
    telegramId: "owner-3",
    sessionId: "session-c",
    proposalId: created.id,
    approved: true,
    reviewer: "owner-3"
  });
  assert.deepEqual(approved, { updated: true, status: "approved" });
  const repeated = runtime.reviewSkillChangeProposal({
    telegramId: "owner-3",
    sessionId: "session-c",
    proposalId: created.id,
    approved: false,
    reviewer: "owner-3"
  });
  assert.deepEqual(repeated, { updated: false, status: "unchanged" });
  assert.equal(runtime.listSkillChangeProposals("owner-3", "session-c")[0].status, "approved");
});


// [ADDED] Regression coverage for customer-state routing and first-response marketing.
test("routes first-contact availability questions to marketing, business facts and natural communication", () => {
  const result = runtime.routeAndLoadSkills({
    message: "ayam panggang nya masih ada kah",
    history: [],
    mode: "customer-auto-reply",
    businessContext: {
      products: [{
        name: "Ayam Panggang Jumbo Dada/Paha",
        description: "Pilihan dada atau paha, harga Rp20.000, gratis minuman",
        price: "20000",
        stock: "12",
        available: true,
        promo: "Gratis minuman"
      }]
    }
  });
  assert.equal(result.customerState, "availability");
  assert.deepEqual(result.activeSkillIds, ["customer-communication", "consumer-psychology"]);
  assert.equal(result.productOfferCandidates.length, 0);
  assert.ok(result.dataRequirements.includes("stock"));
  assert.equal(result.requiresBusinessData, true);
  assert.match(result.instructions, /MARKETING STRATEGY/);
});


test("does not offer products marked unavailable or out of stock", () => {
  const result = runtime.routeAndLoadSkills({
    message: "ayam panggang masih ada kah",
    mode: "customer-auto-reply",
    businessContext: {
      products: [
        { name: "Ayam Panggang Jumbo", price: "20000", stock: "0", available: true },
        { name: "Ayam Panggang Paket", price: "25000", stock: "4", available: false }
      ]
    }
  });
  assert.equal(result.productOfferCandidates.length, 0);
});

test("selects a different psychology and persuasion combination for price objections", () => {
  const result = runtime.routeAndLoadSkills({
    message: "harganya agak mahal buat saya",
    mode: "customer-auto-reply"
  });
  assert.equal(result.customerState, "price_objection");
  assert.deepEqual(result.activeSkillIds, ["customer-communication", "consumer-psychology"]);
});


test("preserves purchase intent when the customer answers a product-choice question", () => {
  assert.equal(runtime.classifyCustomerState("dada", [
    { role: "business", content: "Mau yang dada atau paha, Kak?" }
  ]), "purchase_intent");
});

test("does not confuse availability questions with customer refusal", () => {
  assert.equal(runtime.classifyCustomerState("ayam panggang ada gak"), "availability");
  assert.equal(runtime.classifyCustomerState("gak jadi pesan dulu"), "refusal");
});

test("does not route complaints into promotional selling", () => {
  const result = runtime.routeAndLoadSkills({
    message: "ayamnya kemarin kering dan saya kecewa",
    mode: "customer-auto-reply"
  });
  assert.equal(result.customerState, "complaint");
  assert.ok(result.activeSkillIds.includes("service-recovery"));
  assert.match(result.marketingDirective, /jangan melakukan upsell/i);
});

test("rejects invalid proposals and cross-session review attempts", () => {
  assert.throws(() => runtime.createSkillChangeProposal({
    telegramId: "owner-4",
    sessionId: "session-d",
    skillId: "unknown-skill",
    proposal: "Isi",
    evidenceSummary: "Bukti"
  }), /SKILL_PROPOSAL_INVALID/);

  const created = runtime.createSkillChangeProposal({
    telegramId: "owner-4",
    sessionId: "session-d",
    skillId: "business-context",
    proposal: "Jangan menebak stok",
    evidenceSummary: "Stok harus berasal dari data backend"
  });
  const crossSession = runtime.reviewSkillChangeProposal({
    telegramId: "owner-4",
    sessionId: "another-session",
    proposalId: created.id,
    approved: true,
    reviewer: "owner-4"
  });
  assert.deepEqual(crossSession, { updated: false, status: "unchanged" });
  assert.equal(runtime.listSkillChangeProposals("owner-4", "session-d")[0].status, "pending");
});


// [ADDED] Workflow routing tests for all customer reply categories.
test("routes information, price and product questions to the two base skills and database fields", () => {
  const cases = [
    ["Warungnya di mana?", "information_question", "outlet"],
    ["Berapa harga ayam panggang?", "price_question", "price"],
    ["Ayamnya rasanya seperti apa?", "product_question", "description"], // [ADDED] Covers the "rasanya" inflection.
    ["Bagaimana rasa ayamnya?", "product_question", "description"]
  ];
  for (const [message, intent, field] of cases) {
    const result = runtime.routeAndLoadSkills({ message, mode: "customer-auto-reply" });
    assert.ok(result.customerIntents.includes(intent), message);
    assert.deepEqual(result.activeSkillIds, ["customer-communication", "consumer-psychology"]);
    assert.ok(result.dataRequirements.includes(field), message);
  }
});

test("routes purchase intent to communication, psychology and persuasion with complementary product data", () => {
  const result = runtime.routeAndLoadSkills({
    message: "Saya mau pesan ayam panggang 2 porsi",
    mode: "customer-auto-reply",
    businessContext: { products: [{ name: "Nasi putih", description: "Pelengkap ayam", price: 5000, stock: 10, available: true, featured: true }] }
  });
  assert.ok(result.customerIntents.includes("purchase_intent"));
  assert.deepEqual(result.activeSkillIds, ["customer-communication", "consumer-psychology", "persuasive-communication-and-negotiation"]);
  assert.ok(result.dataRequirements.includes("relevant_complements"));
  assert.equal(result.productOfferCandidates.length, 1);
});

test("routes order changes and confirmations without automatically loading marketing", () => {
  const changed = runtime.routeAndLoadSkills({ message: "Tolong ubah jumlah pesanan menjadi dua", mode: "customer-auto-reply" });
  assert.ok(changed.customerIntents.includes("order_change"));
  assert.deepEqual(changed.activeSkillIds, ["customer-communication", "consumer-psychology"]);
  assert.ok(changed.dataRequirements.includes("current_order"));

  const confirmed = runtime.routeAndLoadSkills({ message: "Saya konfirmasi pesanan ini", mode: "customer-auto-reply" });
  assert.ok(confirmed.customerIntents.includes("order_confirmation"));
  assert.ok(confirmed.dataRequirements.includes("order_status"));
});

test("routes payment and delivery messages to the relevant database fields", () => {
  const payment = runtime.routeAndLoadSkills({ message: "Saya mau bayar pakai QRIS", mode: "customer-auto-reply" });
  assert.ok(payment.customerIntents.includes("payment"));
  assert.ok(payment.dataRequirements.includes("qris_image"));
  assert.ok(payment.dataRequirements.includes("payment_methods"));

  const delivery = runtime.routeAndLoadSkills({ message: "Bisa diantar ke rumah?", mode: "customer-auto-reply" });
  assert.ok(delivery.customerIntents.includes("delivery_pickup"));
  assert.ok(delivery.dataRequirements.includes("delivery_options"));
});

test("routes objections and comparisons with optional versus required persuasion", () => {
  const objection = runtime.routeAndLoadSkills({ message: "Harganya agak mahal", mode: "customer-auto-reply" });
  assert.ok(objection.customerIntents.includes("objection"));
  assert.deepEqual(objection.activeSkillIds, ["customer-communication", "consumer-psychology"]);

  const comparison = runtime.routeAndLoadSkills({ message: "Mana yang lebih enak dibanding paket biasa?", mode: "customer-auto-reply" });
  assert.ok(comparison.customerIntents.includes("comparison"));
  assert.ok(comparison.activeSkillIds.includes("persuasive-communication-and-negotiation"));
  assert.ok(comparison.dataRequirements.includes("compared_products"));
});

test("routes complaints through service recovery without promotional upselling", () => {
  const result = runtime.routeAndLoadSkills({ message: "Saya kecewa, ayam yang datang kering", mode: "customer-auto-reply" });
  assert.ok(result.customerIntents.includes("complaint"));
  assert.ok(result.activeSkillIds.includes("service-recovery"));
  assert.ok(result.dataRequirements.includes("order_history"));
  assert.match(result.marketingDirective, /jangan melakukan upsell/i);
});

test("routes appreciation and feedback through the two base skills", () => {
  const result = runtime.routeAndLoadSkills({ message: "Terima kasih, ayamnya enak", mode: "customer-auto-reply" });
  assert.ok(result.customerIntents.includes("appreciation_feedback"));
  assert.deepEqual(result.activeSkillIds, ["customer-communication", "consumer-psychology"]);
});

test("detects multiple intents in a single customer message", () => {
  const result = runtime.routeAndLoadSkills({
    message: "Ayam panggang masih ada? Saya mau pesan dua porsi dan sekalian nasi",
    mode: "customer-auto-reply"
  });
  assert.ok(result.customerIntents.includes("availability"));
  assert.ok(result.customerIntents.includes("purchase_intent"));
  assert.ok(result.dataRequirements.includes("stock"));
  assert.ok(result.dataRequirements.includes("relevant_complements"));
  assert.equal(new Set(result.activeSkillIds).size, result.activeSkillIds.length);
  assert.ok(result.activeSkillIds.length <= 3);
});


test("inherits order confirmation from the active conversation when customer replies yes", () => {
  const result = runtime.routeAndLoadSkills({
    message: "Iya benar",
    history: [{ role: "business", content: "Boleh saya konfirmasi pesanan ini sudah benar?" }],
    mode: "customer-auto-reply"
  });
  assert.ok(result.customerIntents.includes("order_confirmation"));
  assert.ok(result.dataRequirements.includes("order_summary"));
});

test("recognizes pickup questions and optional marketing for relevant order changes", () => {
  const pickup = runtime.routeAndLoadSkills({ message: "Bisa saya ambil sendiri?", mode: "customer-auto-reply" });
  assert.ok(pickup.customerIntents.includes("delivery_pickup"));
  assert.ok(pickup.dataRequirements.includes("pickup_instructions"));

  const changed = runtime.routeAndLoadSkills({ message: "Tolong tambahkan nasi dan minuman", mode: "customer-auto-reply" });
  assert.ok(changed.customerIntents.includes("order_change"));
  assert.ok(changed.activeSkillIds.includes("persuasive-communication-and-negotiation"));
});
