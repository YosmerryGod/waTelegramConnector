// [MODIFIED] Context-aware progressive skill runtime with customer-state routing.
import fs from "node:fs";
import path from "node:path";
import db from "../../database.js";

const MAX_ACTIVE_SKILLS = 3;
const HISTORY_WINDOW = 6;
const CATALOG_DIR = path.resolve(process.cwd(), "src/ai/skills/catalog");

// [MODIFIED] Skills are selected by customer state and decision task, not keyword volume alone.
const SKILL_REGISTRY = [
  { id: "business-context", name: "Business Context", description: "Fakta bisnis tervalidasi: produk, harga, stok, promo, outlet, dan kebijakan.", domain: "business", priority: 100, triggers: ["produk", "menu", "harga", "stok", "outlet", "promo", "tersedia", "bisnis"], file: "business-context.md" },
  { id: "customer-communication", name: "Customer Communication", description: "Percakapan natural, relevansi, klarifikasi, dan kesinambungan dialog.", domain: "communication", priority: 80, triggers: ["pelanggan", "chat", "balas", "tanya", "jawab", "pesan"], file: "customer-communication.md" },
  { id: "consumer-psychology", name: "Consumer Psychology & Persuasion", description: "Membaca niat beli, persepsi nilai, hambatan, dan memilih penawaran etis.", domain: "marketing", priority: 90, triggers: ["beli", "pesan", "harga", "promo", "penawaran", "pilih", "tersedia", "masih ada", "mau"], file: "consumer-psychology.md" },
  { id: "human-behavior-decision-psychology", name: "Human Behavior & Decision Psychology", description: "Memahami kebutuhan, motivasi, keraguan, dan hambatan keputusan sebagai hipotesis.", domain: "psychology", priority: 70, triggers: ["bingung", "ragu", "takut", "khawatir", "keberatan", "belum yakin", "mahal"], file: "human-behavior-decision-psychology.md" },
  { id: "persuasive-communication-and-negotiation", name: "Persuasive Communication & Negotiation", description: "Menjelaskan manfaat, menangani keberatan, dan mengajak keputusan tanpa tekanan.", domain: "communication", priority: 65, triggers: ["yakinkan", "keberatan", "nego", "tawar", "bandingkan"], file: "persuasive-communication-and-negotiation.md" },
  { id: "service-recovery", name: "Service Recovery Marketing & Trust Building", description: "Menangani keluhan, remedy, goodwill, dan pemulihan kepercayaan.", domain: "marketing", priority: 110, triggers: ["komplain", "keluhan", "kecewa", "refund", "salah", "kering", "terlambat", "rusak", "ulasan", "review"], file: "service-recovery.md" },
  { id: "message-design-and-storytelling", name: "Message Design & Storytelling", description: "Menyusun penjelasan yang mudah dipahami dan tidak seperti membaca katalog.", domain: "communication", priority: 55, triggers: ["jelaskan", "penjelasan", "susun pesan", "deskripsi"], file: "message-design-and-storytelling.md" },
  { id: "brand-awareness-and-brand-activation", name: "Brand Awareness & Brand Activation", description: "Memperkuat positioning, asosiasi produk, dan ingatan merek.", domain: "marketing", priority: 50, triggers: ["branding", "citra merek", "brand", "keunikan"], file: "brand-awareness-and-brand-activation.md" },
  { id: "human-decision-psychology", name: "Human Decision Psychology", description: "Panduan keputusan manusia umum untuk konteks non-pelanggan.", domain: "psychology", priority: 60, triggers: ["keputusan", "pertimbangan", "alasan"], file: "human-decision-psychology.md" }
];

const CUSTOMER_STATE_SKILLS = {
  availability: ["consumer-psychology", "business-context", "customer-communication"],
  purchase_intent: ["consumer-psychology", "business-context", "customer-communication"],
  price_question: ["business-context", "consumer-psychology", "customer-communication"],
  price_objection: ["human-behavior-decision-psychology", "consumer-psychology", "persuasive-communication-and-negotiation"],
  product_comparison: ["consumer-psychology", "message-design-and-storytelling", "business-context"],
  complaint: ["service-recovery", "customer-communication", "business-context"],
  refusal: ["customer-communication", "human-behavior-decision-psychology"],
  greeting: ["customer-communication"],
  general: ["customer-communication", "business-context"]
};

db.exec(`
  CREATE TABLE IF NOT EXISTS ai_skill_change_proposals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    skill_id TEXT NOT NULL,
    proposal TEXT NOT NULL,
    evidence_summary TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending', 'approved', 'rejected', 'applied')),
    created_at INTEGER NOT NULL,
    reviewed_at INTEGER,
    reviewed_by TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_ai_skill_proposals_owner
    ON ai_skill_change_proposals(telegram_id, session_id, status, created_at DESC);
`);

function normalizeText(value) {
  return String(value || "").toLocaleLowerCase("id-ID").normalize("NFKC")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ").trim();
}

function tokenize(value) {
  return normalizeText(value).split(" ").filter(Boolean);
}

function matchesTrigger(tokens, normalizedText, trigger) {
  const normalizedTrigger = normalizeText(trigger);
  if (!normalizedTrigger) return false;
  if (normalizedTrigger.includes(" ")) return normalizedText.includes(normalizedTrigger);
  if (tokens.has(normalizedTrigger)) return true;
  if (normalizedTrigger.length >= 5) {
    for (const token of tokens) {
      if (token.length >= 5 && (token.startsWith(normalizedTrigger) || normalizedTrigger.startsWith(token))) return true;
    }
  }
  return false;
}

// [ADDED] Classify the customer's current state before selecting specialist skills.
export function classifyCustomerState(message = "", history = []) {
  const current = normalizeText(message);
  const tokens = new Set(tokenize(current));
  const has = (...words) => words.some((word) => tokens.has(word) || current.includes(normalizeText(word)));
  if (has("komplain", "keluhan", "kecewa", "refund", "salah", "kering", "terlambat", "rusak", "tidak sesuai")) return "complaint";
  if (has("gak jadi", "nggak jadi", "tidak jadi", "enggak usah", "nggak usah", "gak usah", "ga usah", "tidak mau", "belum dulu", "lain kali", "skip", "tidak berminat")) return "refusal";
  if (has("mahal", "kemahalan", "budget", "anggaran", "uang pas-pasan")) return "price_objection";
  if (has("banding", "beda", "perbedaan", "yang lebih", "mending", "mana enak")) return "product_comparison";
  if (has("berapa", "harganya", "harga", "rp")) return "price_question";
  if (has("masih ada", "tersedia", "ready", "ada kah", "ada gak", "ada nggak", "stok")) return "availability";
  if (has("pesan", "order", "mau", "ambil", "beli", "booking", "pesenin", "dada", "paha")) return "purchase_intent";
  if (has("halo", "hai", "assalamualaikum", "permisi", "pagi", "siang", "sore", "malam")) return "greeting";
  const recentHistory = Array.isArray(history) ? history.slice(-HISTORY_WINDOW) : [];
  const recentCustomerText = recentHistory
    .filter((item) => item?.role === "customer" || item?.direction === "incoming")
    .map((item) => item?.content || item?.text || item?.body || "").join(" ");
  const recentBusinessText = normalizeText(recentHistory
    .filter((item) => item?.role === "business" || item?.role === "assistant" || item?.direction === "outgoing")
    .map((item) => item?.content || item?.text || item?.body || "").join(" "));
  // [ADDED] Keep the buying state when the customer is answering the business's latest choice/quantity question.
  if (recentBusinessText && /(mau yang|pilih dada|pilih paha|berapa porsi|mau pesan|ingin pesan|jumlah porsi)/.test(recentBusinessText)) return "purchase_intent";
  if (normalizeText(recentCustomerText).includes("pesan")) return "purchase_intent";
  return "general";
}

function readSkillInstructions(skill) {
  try {
    const skillPath = path.resolve(CATALOG_DIR, skill.file);
    if (!skillPath.startsWith(CATALOG_DIR + path.sep)) throw new Error("SKILL_PATH_INVALID");
    const instructions = fs.readFileSync(skillPath, "utf8").trim().slice(0, 6500);
    if (!instructions) throw new Error("SKILL_FILE_EMPTY");
    return instructions;
  } catch (error) {
    console.warn("[WAGRAM AI] Skill file unavailable:", skill.id, error.message);
    return "Gunakan keahlian ini hanya sesuai tanggung jawabnya. Jangan mengarang fakta, mengambil alih keputusan skill lain, atau menjanjikan tindakan yang belum diotorisasi.";
  }
}

export function listAvailableSkills() {
  return SKILL_REGISTRY.map(({ id, name, description, domain, triggers }) => ({
    id, name, description, domain, triggers: [...triggers]
  }));
}

function buildProductOfferCandidates(products, message) {
  const source = Array.isArray(products) ? products : [];
  const normalizedMessage = normalizeText(message);
  return source.map((product) => {
    const name = String(product?.name || "").trim();
    const description = String(product?.description || "").trim();
    const searchable = normalizeText(name + " " + description);
    let score = 0;
    if (/jumbo|paket|promo|spesial|unggulan|best seller/i.test(name + " " + description)) score += 3;
    if (normalizedMessage.includes("ayam") && searchable.includes("ayam")) score += 2;
    if (product?.featured === true || product?.isFeatured === true || product?.recommended === true) score += 4;
    if (product?.promo || product?.promotion) score += 2;
    return {
      name,
      description,
      price: product?.price ?? null,
      stock: product?.stock ?? null,
      available: product?.available ?? product?.isAvailable ?? null,
      variants: Array.isArray(product?.variants) ? product.variants : [],
      promotion: product?.promotion || product?.promo || null,
      score
    };
  }).filter((item) => item.name && item.score > 0 && item.available !== false && !(item.stock !== null && item.stock !== "" && Number.isFinite(Number(item.stock)) && Number(item.stock) <= 0))
    .sort((a, b) => b.score - a.score).slice(0, 5)
    .map(({ score, ...product }) => product);
}

export function routeAndLoadSkills({ message = "", history = [], mode = "owner", businessContext = null } = {}) {
  const currentMessage = String(message || "");
  const historyText = Array.isArray(history)
    ? history.slice(-HISTORY_WINDOW).map((item) => item?.content || item?.text || item?.body || "").join(" ")
    : "";
  const context = [currentMessage, historyText].filter(Boolean).join(" ").slice(0, 8000);
  const normalizedContext = normalizeText(context);
  const tokens = new Set(tokenize(context));
  const isCustomerMode = String(mode).startsWith("customer");
  const customerState = isCustomerMode ? classifyCustomerState(currentMessage, history) : null;

  let selectedIds;
  if (isCustomerMode) {
    selectedIds = CUSTOMER_STATE_SKILLS[customerState] || CUSTOMER_STATE_SKILLS.general;
  } else {
    const ranked = SKILL_REGISTRY.map((skill) => {
      const matched = skill.triggers.filter((trigger) => matchesTrigger(tokens, normalizedContext, trigger));
      return { skill, matched, score: matched.length * skill.priority };
    }).filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || b.skill.priority - a.skill.priority)
      .slice(0, MAX_ACTIVE_SKILLS);
    selectedIds = ranked.length ? ranked.map((item) => item.skill.id) : ["customer-communication"];
  }

  const selected = selectedIds.slice(0, MAX_ACTIVE_SKILLS)
    .map((id) => SKILL_REGISTRY.find((skill) => skill.id === id))
    .filter(Boolean);
  const loadedSkills = selected.map((skill) => ({
    id: skill.id,
    name: skill.name,
    domain: skill.domain,
    matchedTriggers: skill.triggers.filter((trigger) => matchesTrigger(tokens, normalizedContext, trigger)),
    instructions: readSkillInstructions(skill)
  }));
  const products = Array.isArray(businessContext?.products) ? businessContext.products : [];
  const productOfferCandidates = isCustomerMode && ["availability", "purchase_intent", "product_comparison"].includes(customerState)
    ? buildProductOfferCandidates(products, currentMessage)
    : [];
  const marketingDirective = isCustomerMode && ["availability", "purchase_intent"].includes(customerState)
    ? "Pelanggan menunjukkan sinyal pembelian. Jawab pertanyaan utama, lalu evaluasi satu penawaran produk utama/unggulan yang benar-benar relevan dari kandidat terverifikasi. Jelaskan isi dan pilihan produk dengan bahasa sendiri; jangan menyalin nama menu mentah. Sebut harga dan promo hanya jika tercantum di fakta produk. Tutup dengan satu pertanyaan pilihan atau jumlah yang memudahkan pemesanan."
    : isCustomerMode && customerState === "price_objection"
      ? "Pahami alasan keberatan harga. Jelaskan nilai atau pilihan alternatif yang benar-benar tersedia tanpa menekan atau menganggap pelanggan tidak mampu."
      : isCustomerMode && customerState === "complaint"
        ? "Prioritaskan pemahaman masalah dan penyelesaian yang adil. Jangan mengubah komplain menjadi promosi atau upsell."
        : "Jangan memaksakan promosi. Pilih informasi atau langkah berikutnya yang paling relevan dengan keadaan pelanggan.";

  const strategyInstructions = "CUSTOMER STATE: " + String(customerState || "not_applicable") + "\nMARKETING STRATEGY: " + marketingDirective;

  return {
    mode: String(mode || "owner"),
    availableSkills: listAvailableSkills(),
    customerState,
    activeSkillIds: loadedSkills.map((skill) => skill.id),
    loadedSkills,
    productOfferCandidates,
    marketingDirective,
    contextPacket: {
      userGoal: currentMessage.slice(0, 1000),
      recentContext: context.slice(0, 3500),
      mode: String(mode || "owner"),
      customerState,
      activeSkills: loadedSkills.map((skill) => skill.id)
    },
    instructions: strategyInstructions + "\n\n" + loadedSkills.map((skill) => "SKILL: " + skill.name + " (" + skill.domain + ")\n" + skill.instructions).join("\n\n")
  };
}

export function createSkillChangeProposal({ telegramId, sessionId, skillId, proposal, evidenceSummary }) {
  const ownerId = String(telegramId || "").trim();
  const session = String(sessionId || "").trim();
  const skill = SKILL_REGISTRY.find((item) => item.id === String(skillId || ""));
  const change = String(proposal || "").trim();
  const evidence = String(evidenceSummary || "").trim();
  if (!ownerId || !session || !skill || !change || !evidence) throw new Error("SKILL_PROPOSAL_INVALID");
  const result = db.prepare(`
    INSERT INTO ai_skill_change_proposals
      (telegram_id, session_id, skill_id, proposal, evidence_summary, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(ownerId, session, skill.id, change.slice(0, 5000), evidence.slice(0, 3000), Date.now());
  return { id: Number(result.lastInsertRowid), status: "pending", skillId: skill.id };
}

export function listSkillChangeProposals(telegramId, sessionId, limit = 30) {
  return db.prepare(`
    SELECT id, skill_id, proposal, evidence_summary, status, created_at, reviewed_at, reviewed_by
    FROM ai_skill_change_proposals
    WHERE telegram_id = ? AND session_id = ?
    ORDER BY created_at DESC LIMIT ?
  `).all(String(telegramId), String(sessionId), Math.max(1, Math.min(100, Number(limit) || 30)));
}

export function reviewSkillChangeProposal({ telegramId, sessionId, proposalId, approved, reviewer }) {
  const decision = approved === true ? "approved" : "rejected";
  const result = db.prepare(`
    UPDATE ai_skill_change_proposals
    SET status = ?, reviewed_at = ?, reviewed_by = ?
    WHERE id = ? AND telegram_id = ? AND session_id = ? AND status = 'pending'
  `).run(decision, Date.now(), String(reviewer || "owner").slice(0, 120),
    Number(proposalId), String(telegramId), String(sessionId));
  return { updated: result.changes === 1, status: result.changes === 1 ? decision : "unchanged" };
}
