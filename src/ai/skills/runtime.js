// [ADDED] Hermes-inspired progressive skill runtime for WAGRAM AI.
import fs from "node:fs";
import path from "node:path";
import db from "../../database.js";

const MAX_ACTIVE_SKILLS = 3;
const HISTORY_WINDOW = 6;
const SKILL_REGISTRY = [
  { id: "business-context", name: "Business Context", description: "Fakta profil, outlet, produk, harga, stok, operasional, dan aturan bisnis.", triggers: ["bisnis", "usaha", "outlet", "cabang", "produk", "menu", "harga", "stok", "operasional", "alamat", "jam buka"], priority: 100, file: "business-context.md" },
  { id: "customer-communication", name: "Customer Communication", description: "Kebutuhan pelanggan, percakapan natural, klarifikasi, dan rapport.", triggers: ["pelanggan", "customer", "chat", "balas", "komunikasi", "pesan", "tanya", "jawab", "sapaan"], priority: 80, file: "customer-communication.md" },
  { id: "consumer-psychology", name: "Consumer Psychology", description: "Keputusan pembelian, keberatan, persepsi nilai, dan persuasi etis.", triggers: ["beli", "membeli", "pesan", "memesan", "harga", "mahal", "pilih", "promo", "penawaran", "upsell", "diskon"], priority: 70, file: "consumer-psychology.md" },
  { id: "service-recovery", name: "Service Recovery", description: "Komplain, ulasan negatif, pemulihan layanan, dan kepercayaan.", triggers: ["komplain", "keluhan", "kecewa", "buruk", "refund", "salah", "kering", "terlambat", "rusak", "kecewaan", "ulasan", "review"], priority: 110, file: "service-recovery.md" },
  { id: "human-decision-psychology", name: "Human Decision Psychology", description: "Motivasi, kekhawatiran, hambatan, dan dinamika keputusan manusia.", triggers: ["bingung", "ragu", "takut", "khawatir", "keberatan", "alasan", "keputusan", "pertimbangan"], priority: 60, file: "human-decision-psychology.md" }
];

const SKILL_CONTENT = {
  "business-context": "Gunakan fakta backend tervalidasi sebagai sumber kebenaran harga, stok, pesanan, dan operasional. Jangan mengisi data yang tidak tersedia dengan asumsi.",
  "customer-communication": "Pahami percakapan sebagai satu rangkaian. Jawab kebutuhan utama dan ajukan maksimal satu pertanyaan yang benar-benar diperlukan.",
  "consumer-psychology": "Nilai manfaat dan hambatan pembelian secara kontekstual. Gunakan persuasi jujur; jangan memakai urgensi palsu atau memaksakan upsell.",
  "service-recovery": "Akui pengalaman pelanggan secara proporsional dan tunjukkan perbaikan nyata. Jangan otomatis menjanjikan diskon, hadiah, refund, atau penggantian.",
  "human-decision-psychology": "Perlakukan motif dan kekhawatiran sebagai hipotesis. Pisahkan fakta dari interpretasi dan jangan memanipulasi kerentanan."
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
    .replace(/[^\\p{L}\\p{N}\\s]/gu, " ")
    .replace(/\\s+/g, " ").trim();
}

function tokenize(value) {
  return normalizeText(value).split(" ").filter(Boolean);
}

function matchesTrigger(tokens, normalizedText, trigger) {
  const normalizedTrigger = normalizeText(trigger);
  if (!normalizedTrigger) return false;
  if (normalizedTrigger.includes(" ")) return normalizedText.includes(normalizedTrigger);
  if (tokens.has(normalizedTrigger)) return true;
  // [ADDED] Indonesian affixes commonly change surface forms without changing intent.
  if (normalizedTrigger.length >= 5) {
    for (const token of tokens) {
      if (token.length >= 5 && (token.startsWith(normalizedTrigger) || normalizedTrigger.startsWith(token))) return true;
    }
  }
  return false;
}

export function listAvailableSkills() {
  return SKILL_REGISTRY.map(({ id, name, description, triggers }) => ({ id, name, description, triggers: [...triggers] }));
}

export function routeAndLoadSkills({ message = "", history = [], mode = "owner" } = {}) {
  const historyText = Array.isArray(history)
    ? history.slice(-HISTORY_WINDOW).map((item) => item?.content || item?.text || item?.body || "").join(" ")
    : "";
  const currentMessage = String(message || "");
  const context = [currentMessage, historyText].filter(Boolean).join(" ").slice(0, 8000);
  const normalizedContext = normalizeText(context);
  const tokens = new Set(tokenize(context));
  const ranked = SKILL_REGISTRY.map((skill) => {
    const matched = skill.triggers.filter((trigger) => matchesTrigger(tokens, normalizedContext, trigger));
    return { skill, matched, score: matched.length * skill.priority };
  }).filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || b.skill.priority - a.skill.priority)
    .slice(0, MAX_ACTIVE_SKILLS);

  const selected = ranked.length
    ? ranked
    : [{ skill: SKILL_REGISTRY.find((item) => item.id === "customer-communication"), matched: [], score: 0 }];
  const loadedSkills = selected.map(({ skill, matched }) => {
    let instructions;
    try {
      const skillPath = path.resolve(process.cwd(), "src/ai/skills/catalog", skill.file);
      instructions = fs.readFileSync(skillPath, "utf8").trim().slice(0, 5000);
      if (!instructions) throw new Error("SKILL_FILE_EMPTY");
    } catch (error) {
      console.warn("[WAGRAM AI] Skill file unavailable:", skill.id, error.message);
      instructions = SKILL_CONTENT[skill.id];
    }
    return { id: skill.id, name: skill.name, matchedTriggers: matched, instructions };
  });

  return {
    mode: String(mode || "owner"),
    availableSkills: listAvailableSkills(),
    activeSkillIds: loadedSkills.map((skill) => skill.id),
    loadedSkills,
    contextPacket: {
      userGoal: currentMessage.slice(0, 1000),
      recentContext: context.slice(0, 3500),
      mode: String(mode || "owner"),
      activeSkills: loadedSkills.map((skill) => skill.id)
    },
    instructions: loadedSkills.map((skill) => "SKILL: " + skill.name + "\\n" + skill.instructions).join("\\n\\n")
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
