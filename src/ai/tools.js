import db, {
  canonicalWhatsAppSessionId,
  getAIBusinessProfile
} from "../database.js";

const TOOL_NAMES = new Set([
  "get_business_profile",
  "list_products",
  "cek_stok"
]);

db.exec(`
  CREATE TABLE IF NOT EXISTS ai_tool_audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    arguments_json TEXT NOT NULL,
    outcome TEXT NOT NULL CHECK (outcome IN ('success', 'rejected', 'error')),
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_ai_tool_audit_owner
    ON ai_tool_audit_log(telegram_id, session_id, created_at DESC);
`);

const auditInsert = db.prepare(`
  INSERT INTO ai_tool_audit_log (
    telegram_id, session_id, tool_name, arguments_json, outcome, created_at
  ) VALUES (?, ?, ?, ?, ?, ?)
`);

export const WAGRAM_TOOL_DECLARATIONS = [
  {
    name: "get_business_profile",
    description: "Membaca profil bisnis milik pemilik yang sedang terautentikasi.",
    parameters: {
      type: "OBJECT",
      properties: {
        sections: {
          type: "ARRAY",
          items: {
            type: "STRING",
            enum: ["identity", "manager", "outlets"]
          }
        }
      },
      required: []
    }
  },
  {
    name: "list_products",
    description: "Membaca daftar produk, harga, dan status ketersediaan bisnis aktif.",
    parameters: {
      type: "OBJECT",
      properties: {},
      required: []
    }
  },
  {
    name: "cek_stok",
    description: "Memeriksa harga dan stok produk pada bisnis aktif berdasarkan nama produk.",
    parameters: {
      type: "OBJECT",
      properties: {
        produk: { type: "STRING", minLength: 1, maxLength: 120 }
      },
      required: ["produk"]
    }
  }
];

function validateContext(context) {
  const telegramId = String(context?.telegramId || "");
  if (!/^\d+$/.test(telegramId)) throw new Error("TOOL_AUTH_REQUIRED");
  const rawSessionId = String(context?.sessionId || telegramId);
  if (!rawSessionId || rawSessionId.length > 160) throw new Error("TOOL_SESSION_INVALID");
  return {
    telegramId,
    sessionId: canonicalWhatsAppSessionId(telegramId, rawSessionId)
  };
}

function validateArguments(name, args) {
  if (!TOOL_NAMES.has(name)) throw new Error("TOOL_NOT_ALLOWED");
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("TOOL_ARGUMENTS_INVALID");
  }

  if (name === "cek_stok") {
    const keys = Object.keys(args);
    if (keys.some((key) => key !== "produk")) throw new Error("TOOL_ARGUMENTS_INVALID");
    const produk = String(args.produk || "").trim();
    if (!produk || produk.length > 120) throw new Error("TOOL_PRODUCT_QUERY_INVALID");
    return { produk };
  }

  if (name === "get_business_profile") {
    const keys = Object.keys(args);
    if (keys.some((key) => key !== "sections")) throw new Error("TOOL_ARGUMENTS_INVALID");
    if (args.sections !== undefined && (
      !Array.isArray(args.sections) ||
      args.sections.length > 3 ||
      args.sections.some((item) => !["identity", "manager", "outlets"].includes(item))
    )) throw new Error("TOOL_SECTIONS_INVALID");
    return { sections: args.sections || ["identity", "manager", "outlets"] };
  }

  if (Object.keys(args).length) throw new Error("TOOL_ARGUMENTS_INVALID");
  return {};
}

function getProducts(settings) {
  return Array.isArray(settings?.products)
    ? settings.products.slice(0, 100).map((product) => ({
        name: String(product?.name || "").trim(),
        description: String(product?.description || "").trim(),
        price: product?.price ?? null,
        stock: product?.stock ?? null,
        available: product?.available ?? product?.isAvailable ?? null
      })).filter((product) => product.name)
    : [];
}

function audit(context, name, args, outcome) {
  auditInsert.run(
    context.telegramId,
    context.sessionId,
    name,
    JSON.stringify(args),
    outcome,
    Date.now()
  );
}

export function executeWagramTool(name, rawArgs = {}, rawContext = {}) {
  const context = validateContext(rawContext);
  let args = {};
  let outcome = "rejected";

  try {
    args = validateArguments(name, rawArgs);
    const profile = getAIBusinessProfile(context.telegramId, context.sessionId);
    const settings = profile?.settings && typeof profile.settings === "object"
      ? profile.settings
      : {};

    let result;
    if (name === "get_business_profile") {
      const sections = {};
      if (args.sections.includes("identity")) {
        sections.identity = {
          name: String(settings.businessName || settings.name || "").trim(),
          description: String(settings.businessDescription || settings.description || "").trim()
        };
      }
      if (args.sections.includes("manager")) {
        const manager = settings.manager || {};
        sections.manager = {
          name: String(manager.name || "").trim(),
          phone: String(manager.phone || "").trim()
        };
      }
      if (args.sections.includes("outlets")) {
        sections.outlets = Array.isArray(settings.outlets)
          ? settings.outlets.slice(0, 30).map((outlet) => ({
              name: String(outlet?.name || "").trim(),
              address: String(outlet?.address || "").trim(),
              phone: String(outlet?.phone || "").trim(),
              openTime: String(outlet?.openTime || outlet?.open_time || "").trim(),
              closeTime: String(outlet?.closeTime || outlet?.close_time || "").trim()
            }))
          : [];
      }
      result = sections;
    } else if (name === "list_products") {
      result = getProducts(settings);
    } else {
      const query = args.produk.toLocaleLowerCase("id-ID");
      const products = getProducts(settings);
      const matches = products.filter((product) =>
        product.name.toLocaleLowerCase("id-ID") === query
      );
      result = {
        query: args.produk,
        found: matches.length > 0,
        products: matches
      };
    }

    outcome = "success";
    audit(context, name, args, outcome);
    return result;
  } catch (error) {
    audit(context, name, args, outcome);
    throw error;
  }
}
