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

test("falls back to customer communication when no trigger matches", () => {
  const result = runtime.routeAndLoadSkills({ message: "halo", history: [] });
  assert.deepEqual(result.activeSkillIds, ["customer-communication"]);
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
  assert.deepEqual(result.activeSkillIds, ["consumer-psychology", "business-context", "customer-communication"]);
  assert.equal(result.productOfferCandidates.length, 1);
  assert.match(result.marketingDirective, /sinyal pembelian/i);
  assert.match(result.instructions, /MARKETING STRATEGY/);
});

test("selects a different psychology and persuasion combination for price objections", () => {
  const result = runtime.routeAndLoadSkills({
    message: "harganya agak mahal buat saya",
    mode: "customer-auto-reply"
  });
  assert.equal(result.customerState, "price_objection");
  assert.deepEqual(result.activeSkillIds, [
    "human-behavior-decision-psychology",
    "consumer-psychology",
    "persuasive-communication-and-negotiation"
  ]);
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
  assert.match(result.marketingDirective, /Jangan mengubah komplain menjadi promosi/);
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
