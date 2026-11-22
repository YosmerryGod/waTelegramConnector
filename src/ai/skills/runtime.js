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

// [ADDED] Central workflow registry: each customer intent declares only the skills and business data it needs.
const BASE_CUSTOMER_SKILLS = ["customer-communication", "consumer-psychology"];

const CUSTOMER_INTENT_WORKFLOWS = {
  greeting: {
    skills: BASE_CUSTOMER_SKILLS,
    data: [],
    marketing: "none"
  },
  information_question: {
    skills: BASE_CUSTOMER_SKILLS,
    data: ["business_information", "outlet", "operating_hours", "policies"],
    marketing: "none"
  },
  price_question: {
    skills: BASE_CUSTOMER_SKILLS,
    data: ["product", "price", "promotion_terms"],
    marketing: "none"
  },
  product_question: {
    skills: BASE_CUSTOMER_SKILLS,
    data: ["product", "description", "variants", "price"],
    marketing: "none"
  },
  availability: {
    skills: BASE_CUSTOMER_SKILLS,
    data: ["product", "stock", "availability"],
    marketing: "none"
  },
  purchase_intent: {
    skills: [...BASE_CUSTOMER_SKILLS, "persuasive-communication-and-negotiation"],
    data: ["product", "price", "stock", "variants", "relevant_complements", "promotion_terms"],
    marketing: "required"
  },
  order_change: {
    skills: BASE_CUSTOMER_SKILLS,
    optionalSkills: ["persuasive-communication-and-negotiation"],
    data: ["current_order", "product", "price", "stock"],
    marketing: "optional"
  },
  order_confirmation: {
    skills: BASE_CUSTOMER_SKILLS,
    data: ["current_order", "order_status", "order_summary"],
    marketing: "none"
  },
  payment: {
    skills: BASE_CUSTOMER_SKILLS,
    data: ["payment_methods", "qris_image", "payment_instructions", "payment_status"],
    marketing: "none"
  },
  delivery_pickup: {
    skills: BASE_CUSTOMER_SKILLS,
    data: ["outlet_location", "operating_hours", "delivery_options", "delivery_fee", "pickup_instructions"],
    marketing: "none"
  },
  objection: {
    skills: BASE_CUSTOMER_SKILLS,
    optionalSkills: ["persuasive-communication-and-negotiation"],
    data: ["relevant_product_options", "price", "promotion_terms"],
    marketing: "optional"
  },
  comparison: {
    skills: [...BASE_CUSTOMER_SKILLS, "persuasive-communication-and-negotiation"],
    data: ["compared_products", "price", "variants", "product_features", "availability"],
    marketing: "required"
  },
  complaint: {
    skills: BASE_CUSTOMER_SKILLS,
    optionalSkills: ["service-recovery"],
    data: ["order_history", "ordered_items", "business_policy", "previous_resolution"],
    marketing: "conditional"
  },
  refusal: {
    skills: BASE_CUSTOMER_SKILLS,
    data: [],
    marketing: "none"
  },
  appreciation_feedback: {
    skills: BASE_CUSTOMER_SKILLS,
    data: [],
    marketing: "none"
  },
  general: {
    skills: BASE_CUSTOMER_SKILLS,
    data: [],
    marketing: "none"
  }
};

// [ADDED] Backward-compatible primary-state mapping for existing customer-service consumers.
const CUSTOMER_STATE_SKILLS = Object.fromEntries(
  Object.entries(CUSTOMER_INTENT_WORKFLOWS).map(([intent, workflow]) => [intent, workflow.skills])
);

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

// [ADDED] Detect multiple customer intents from the current message without losing the conversation context.
export function classifyCustomerIntents(message = "", history = []) {
  const current = normalizeText(message);
  const recentHistory = Array.isArray(history) ? history.slice(-HISTORY_WINDOW) : [];
  const recentCustomerText = normalizeText(recentHistory
    .filter((item) => item?.role === "customer" || item?.direction === "incoming")
    .map((item) => item?.content || item?.text || item?.body || "").join(" "));
  const recentBusinessText = normalizeText(recentHistory
    .filter((item) => item?.role === "business" || item?.role === "assistant" || item?.direction === "outgoing")
    .map((item) => item?.content || item?.text || item?.body || "").join(" "));
  const text = current || recentCustomerText;
  const has = (pattern) => pattern.test(text);
  const intents = [];

  if (has(/\b(?:komplain|keluhan|kecewa|refund|salah|kering|terlambat|rusak|tidak sesuai|kurang matang|pesanan bermasalah)\b/)) intents.push("complaint");
  if (has(/\b(?:gak jadi|nggak jadi|tidak jadi|enggak usah|nggak usah|gak usah|ga usah|tidak mau|belum dulu|lain kali|skip|tidak berminat)\b/)) intents.push("refusal");
  if (has(/\b(?:qris|qr code|transfer|pembayaran|pembayaran|bayar|sudah transfer|bukti transfer|rekening)\b/)) intents.push("payment");
  if (has(/\b(?:antar|diantar|delivery|kurir|ambil sendiri|pickup|ambil di|lokasi|alamat|jam buka|buka jam|tutup jam)\b/)) intents.push("delivery_pickup");
  if (has(/\b(?:ubah pesanan|ganti pesanan|tambahkan|tambah pesanan|kurangi|ganti jumlah|ubah jumlah|cancel item|hapus item)\b/)) intents.push("order_change");
  if (has(/\b(?:konfirmasi pesanan|pesanan sudah benar|order sudah benar|betul pesanannya|saya konfirmasi|konfirmasi order)\b/)) intents.push("order_confirmation");
  if (has(/\b(?:banding|beda|perbedaan|yang lebih|mending|mana enak|lebih enak|dibanding)\b/)) intents.push("comparison");
  if (has(/\b(?:mahal|kemahalan|budget|anggaran|uang pas|masih pikir|masih ragu|belum yakin|takut|khawatir|pertimbangkan dulu)\b/)) intents.push("objection");
  if (has(/\b(?:berapa|harganya|harga|rp)\b/)) intents.push("price_question");
  if (has(/\b(?:masih ada|tersedia|ready|ada kah|ada gak|ada nggak|stok|habis)\b/)) intents.push("availability");
  if (has(/\b(?:pesan|order|mau beli|mau pesan|ingin pesan|beli|booking|pesenin|pesan.*(?:porsi|ekor|pcs|buah))\b/)) intents.push("purchase_intent");
  if (has(/\b(?:komposisi|isi|rasa|varian|menu|produk|ayam|nasi|minuman|sambal)\b/) && !intents.includes("purchase_intent")) intents.push("product_question");
  if (has(/\b(?:alamat|lokasi|dimana|di mana|jam operasional|jam buka|jam tutup|nomor|kontak|parkir|fasilitas)\b/)) intents.push("information_question");
  if (has(/\b(?:terima kasih|makasih|mantap|enak|puas|suka sekali|rekomendasi|bintang|ulasan|masukan|saran)\b/)) intents.push("appreciation_feedback");
  if (has(/\b(?:halo|hai|assalamualaikum|permisi|pagi|siang|sore|malam)\b/)) intents.push("greeting");

  // [ADDED] Short answers inherit the active workflow when the business asked a clear follow-up question.
  if (intents.length === 0 && recentBusinessText && /(mau yang|pilih dada|pilih paha|berapa porsi|mau pesan|ingin pesan|jumlah porsi|metode pembayaran|alamat pengiriman)/.test(recentBusinessText)) {
    if (/\b(?:dada|paha|iya|ya|betul|jadi|dua|satu|ambil)\b/.test(text)) intents.push("purchase_intent");
    else if (/\b(?:sudah|belum|transfer|qris)\b/.test(text)) intents.push("payment");
    else intents.push("general");
  }
  if (intents.length === 0) intents.push("general");

  // Preserve detection order while removing duplicate intent IDs.
  return [...new Set(intents)];
}

// [ADDED] Select the primary state for legacy callers; the full intent list remains available separately.
export function classifyCustomerState(message = "", history = []) {
  const intents = classifyCustomerIntents(message, history);
  const priority = [
    "complaint", "payment", "order_change", "order_confirmation", "delivery_pickup",
    "refusal", "objection", "comparison", "purchase_intent", "availability",
    "price_question", "product_question", "information_question", "appreciation_feedback",
    "greeting", "general"
  ];
  return priority.find((intent) => intents.includes(intent)) || "general";
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
  const customerIntents = isCustomerMode ? classifyCustomerIntents(currentMessage, history) : [];
  const customerState = isCustomerMode ? classifyCustomerState(currentMessage, history) : null;

  let selectedIds;
  let workflow = null;
  if (isCustomerMode) {
    // [ADDED] Merge skills across all detected intents, then load each skill only once.
    workflow = customerIntents.reduce((combined, intent) => {
      const definition = CUSTOMER_INTENT_WORKFLOWS[intent] || CUSTOMER_INTENT_WORKFLOWS.general;
      combined.skills.push(...definition.skills);
      combined.data.push(...definition.data);
      if (definition.optionalSkills?.length) combined.optionalSkills.push(...definition.optionalSkills);
      if (definition.marketing === "required") combined.marketingRequired = true;
      if (definition.marketing === "conditional") combined.marketingConditional = true;
      if (definition.marketing === "optional") combined.marketingOptional = true;
      return combined;
    }, { skills: [], data: [], optionalSkills: [], marketingRequired: false, marketingConditional: false, marketingOptional: false });
    selectedIds = [...new Set(workflow.skills)];
    const normalizedMessage = normalizeText(currentMessage);
    const marketingSignals = /\b(?:rekomendasi|tambahan|sekalian|paket|promo|alternatif|pilihan lain|upsell|produk serupa)\b/.test(normalizedMessage);
    if (workflow.marketingRequired || (workflow.marketingConditional && marketingSignals) || (workflow.marketingOptional && marketingSignals)) {
      selectedIds.push(...workflow.optionalSkills);
    }
    // [ADDED] Keep the existing three-skill runtime limit; mandatory workflow skills take precedence.
    selectedIds = [...new Set(selectedIds)].slice(0, MAX_ACTIVE_SKILLS);
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
  const wantsMarketingOffer = isCustomerMode && customerIntents.some((intent) =>
    ["purchase_intent", "comparison"].includes(intent)
  );
  const productOfferCandidates = wantsMarketingOffer
    ? buildProductOfferCandidates(products, currentMessage)
    : [];
  const marketingDirective = isCustomerMode
    ? customerIntents.includes("complaint")
      ? "Tangani keluhan terlebih dahulu. Marketing hanya boleh berupa pemulihan kepercayaan yang faktual dan relevan; jangan melakukan upsell, promosi, atau menawarkan kompensasi tanpa persetujuan."
      : wantsMarketingOffer
        ? "Jawab kebutuhan utama terlebih dahulu. Untuk niat memesan, tawarkan maksimal satu produk serupa atau pelengkap yang benar-benar relevan (misalnya nasi atau minuman) berdasarkan produk, harga, dan stok terverifikasi. Untuk perbandingan, jelaskan perbedaan dan manfaat berdasarkan fakta. Jangan memaksa."
        : customerIntents.includes("objection")
          ? "Pahami alasan keraguan. Skill persuasi hanya digunakan bila dapat membantu; jelaskan nilai atau alternatif faktual tanpa tekanan, diskon otomatis, atau urgensi palsu."
          : "Jangan memaksakan promosi. Jawab maksud utama pelanggan dengan bahasa natural dan gunakan fakta bisnis hanya bila diperlukan."
    : "Pilih informasi atau langkah berikutnya yang paling relevan dengan keadaan pelanggan.";

  const dataRequirements = isCustomerMode ? [...new Set(workflow?.data || [])] : [];
  const businessDataAvailable = Boolean(businessContext && typeof businessContext === "object");
  const strategyInstructions = [
    "CUSTOMER STATE: " + String(customerState || "not_applicable"),
    "CUSTOMER INTENTS: " + (customerIntents.join(", ") || "not_applicable"),
    "REQUIRED BUSINESS DATA: " + (dataRequirements.join(", ") || "none"),
    "BUSINESS DATA STATUS: " + (dataRequirements.length ? (businessDataAvailable ? "context provided; verify each requested field before answering" : "required; retrieve from business database before answering") : "not required"),
    "MARKETING STRATEGY: " + marketingDirective,
    "WORKFLOW RULE: Load and apply only the listed active skills. Do not invent missing database facts. If required data is unavailable, ask one concise clarification or escalate rather than guessing."
  ].join("\n");

  return {
    mode: String(mode || "owner"),
    availableSkills: listAvailableSkills(),
    customerState,
    customerIntents,
    workflow: isCustomerMode ? {
      intents: customerIntents,
      activeSkills: loadedSkills.map((skill) => skill.id),
      dataRequirements,
      marketing: workflow?.marketingRequired ? "required" : workflow?.marketingConditional ? "conditional" : workflow?.marketingOptional ? "optional" : "none"
    } : null,
    dataRequirements,
    requiresBusinessData: dataRequirements.length > 0,
    activeSkillIds: loadedSkills.map((skill) => skill.id),
    loadedSkills,
    productOfferCandidates,
    marketingDirective,
    contextPacket: {
      userGoal: currentMessage.slice(0, 1000),
      recentContext: context.slice(0, 3500),
      mode: String(mode || "owner"),
      customerState,
      customerIntents,
      activeSkills: loadedSkills.map((skill) => skill.id),
      dataRequirements
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
