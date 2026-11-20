import db, {
  canonicalWhatsAppSessionId,
  getAIBusinessProfile,
  saveAIBusinessProfile
} from "../database.js";

const TOOL_NAMES = new Set([
  "get_business_profile",
  "list_products",
  "cek_stok",
  "manage_business_data"
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
  },
  {
    name: "manage_business_data",
    description: "Mengelola data bisnis milik pemilik yang terautentikasi. Gunakan hanya setelah memahami maksud dan mengumpulkan semua informasi wajib dari percakapan. Mendukung produk, outlet, profil manager, dan aturan bisnis. Untuk penghapusan wajib minta persetujuan eksplisit terlebih dahulu dan kirim confirmed=true hanya setelah persetujuan diberikan. Untuk stok yang belum diketahui gunakan null, bukan nol.",
    parameters: {
      type: "OBJECT",
      properties: {
        resource: { type: "STRING", enum: ["products", "outlets", "manager", "aiRules"] },
        operation: { type: "STRING", enum: ["create", "update", "delete", "replace"] },
        identifier: { type: "STRING", maxLength: 120 },
        data: {
          type: "OBJECT",
          properties: {
            name: { type: "STRING", maxLength: 120 },
            description: { type: "STRING", maxLength: 500 },
            price: { type: "NUMBER", minimum: 0 },
            stock: { type: "NUMBER", minimum: 0 },
            address: { type: "STRING", maxLength: 500 },
            phone: { type: "STRING", maxLength: 40 },
            openTime: { type: "STRING", maxLength: 20 },
            closeTime: { type: "STRING", maxLength: 20 },
            timezone: { type: "STRING", maxLength: 80 },
            openDays: { type: "ARRAY", items: { type: "STRING", enum: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] } },
            specialHours: { type: "ARRAY", maxItems: 60, items: { type: "OBJECT", properties: {
              date: { type: "STRING", minLength: 10, maxLength: 10 },
              closed: { type: "BOOLEAN" },
              openTime: { type: "STRING", maxLength: 5 },
              closeTime: { type: "STRING", maxLength: 5 }
            }, required: ["date"] } },
            fullName: { type: "STRING", maxLength: 120 },
            aiRules: { type: "STRING", maxLength: 3000 }
          }
        },
        confirmed: { type: "BOOLEAN" }
      },
      required: ["resource", "operation"]
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

  if (name === "manage_business_data") {
    const allowedKeys = new Set(["resource", "operation", "identifier", "data", "confirmed"]);
    if (Object.keys(args).some((key) => !allowedKeys.has(key))) throw new Error("TOOL_ARGUMENTS_INVALID");
    const resource = String(args.resource || "");
    const operation = String(args.operation || "");
    if (!["products", "outlets", "manager", "aiRules"].includes(resource)) throw new Error("TOOL_RESOURCE_INVALID");
    if (!["create", "update", "delete", "replace"].includes(operation)) throw new Error("TOOL_OPERATION_INVALID");
    if (args.identifier !== undefined && (typeof args.identifier !== "string" || args.identifier.length > 120)) throw new Error("TOOL_IDENTIFIER_INVALID");
    if (args.confirmed !== undefined && typeof args.confirmed !== "boolean") throw new Error("TOOL_CONFIRMATION_INVALID");
    if (args.data !== undefined && (!args.data || typeof args.data !== "object" || Array.isArray(args.data))) throw new Error("TOOL_DATA_INVALID");
    const data = args.data || {};
    const allowedData = new Set(["name", "description", "price", "stock", "address", "phone", "openTime", "closeTime", "timezone", "openDays", "specialHours", "fullName", "aiRules"]); // [MODIFIED]
    if (Object.keys(data).some((key) => !allowedData.has(key))) throw new Error("TOOL_DATA_FIELD_INVALID");
    // [ADDED] Validate date-specific outlet hours for both create and update operations.
    if (resource === "outlets" && data.specialHours !== undefined) {
      if (!Array.isArray(data.specialHours) || data.specialHours.length > 60) throw new Error("TOOL_OUTLET_SPECIAL_HOURS_INVALID");
      const seenDates = new Set();
      for (const entry of data.specialHours) {
        const dateValue = String(entry?.date || "");
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dateValue) ||
          !Number.isFinite(Date.parse(dateValue + "T00:00:00.000Z")) ||
          new Date(dateValue + "T00:00:00.000Z").toISOString().slice(0, 10) !== dateValue ||
          seenDates.has(dateValue)) {
          throw new Error("TOOL_OUTLET_SPECIAL_DATE_INVALID");
        }
        seenDates.add(dateValue);
        if (entry.closed !== true) {
          for (const value of [entry.openTime, entry.closeTime]) {
            if (!/^\d{2}:\d{2}$/.test(String(value || ""))) throw new Error("TOOL_OUTLET_SPECIAL_HOURS_INVALID");
            const [hour, minute] = String(value).split(":").map(Number);
            if (hour > 23 || minute > 59) throw new Error("TOOL_OUTLET_SPECIAL_HOURS_INVALID");
          }
          if (entry.openTime === entry.closeTime) throw new Error("TOOL_OUTLET_SPECIAL_HOURS_INVALID");
        }
      }
    }
    return { resource, operation, identifier: String(args.identifier || "").trim(), data, confirmed: args.confirmed === true };
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
    outcome = "error";
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
              closeTime: String(outlet?.closeTime || outlet?.close_time || "").trim(),
              timezone: String(outlet?.timezone || outlet?.timeZone || "Asia/Jakarta").trim(),
              openDays: Array.isArray(outlet?.openDays) ? outlet.openDays : ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"],
              specialHours: Array.isArray(outlet?.specialHours) ? outlet.specialHours : []
            }))
          : [];
      }
      result = sections;
    } else if (name === "list_products") {
      result = getProducts(settings);
    } else if (name === "cek_stok") {
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
    } else if (name === "manage_business_data") {
      const { resource, operation, identifier, data, confirmed } = args;
      if (operation === "delete" && !confirmed) throw new Error("TOOL_DELETION_REQUIRES_CONFIRMATION");
      const nextSettings = { ...settings };
      const matchByName = (items, key) => items.findIndex((item) =>
        String(item?.[key] || "").trim().toLocaleLowerCase("id-ID") === identifier.toLocaleLowerCase("id-ID")
      );

      if (resource === "products" || resource === "outlets") {
        const field = resource;
        const items = Array.isArray(settings[field]) ? settings[field].slice(0, 100) : [];
        const index = identifier ? matchByName(items, "name") : -1;
        if (operation === "create") {
          const name = String(data.name || "").trim();
          if (!name || name.length > 120) throw new Error("TOOL_ITEM_NAME_REQUIRED");
          if (items.length >= 100) throw new Error("TOOL_ITEM_LIMIT_REACHED");
          if (items.some((item) => String(item?.name || "").trim().toLocaleLowerCase("id-ID") === name.toLocaleLowerCase("id-ID"))) {
            throw new Error("TOOL_ITEM_ALREADY_EXISTS");
          }
          if (resource === "products") {
            if (!Number.isSafeInteger(data.price) || data.price < 0) throw new Error("TOOL_PRODUCT_PRICE_REQUIRED");
            if (data.stock !== undefined && data.stock !== null && (!Number.isSafeInteger(data.stock) || data.stock < 0)) throw new Error("TOOL_PRODUCT_STOCK_INVALID");
            items.push({ name, description: String(data.description || "").slice(0, 500), price: data.price, stock: data.stock ?? null });
          } else {
            items.push({
              name,
              address: String(data.address || "").slice(0, 500),
              phone: String(data.phone || "").slice(0, 40),
              openTime: String(data.openTime || "").slice(0, 20),
              closeTime: String(data.closeTime || "").slice(0, 20),
              timezone: String(data.timezone || "Asia/Jakarta").slice(0, 80),
              openDays: Array.isArray(data.openDays) ? data.openDays : ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"],
              specialHours: Array.isArray(data.specialHours) ? data.specialHours : []
            });
          }
          result = { saved: true, operation, resource, item: items[items.length - 1] };
        } else {
          if (index < 0) throw new Error("TOOL_ITEM_NOT_FOUND");
          if (operation === "delete") {
            const [removed] = items.splice(index, 1);
            result = { saved: true, operation, resource, item: removed };
          } else if (operation === "update") {
            const current = items[index];
            const updated = { ...current };
            for (const [key, value] of Object.entries(data)) {
              if (resource === "products" && ["name", "description", "price", "stock"].includes(key)) updated[key] = value;
              if (resource === "outlets" && ["name", "address", "phone", "openTime", "closeTime", "timezone", "openDays", "specialHours"].includes(key)) updated[key] = value;
            }
            if (resource === "products") {
              if (updated.name === undefined || !String(updated.name).trim()) throw new Error("TOOL_PRODUCT_NAME_INVALID");
              if (updated.price !== undefined && (!Number.isSafeInteger(updated.price) || updated.price < 0)) throw new Error("TOOL_PRODUCT_PRICE_INVALID");
              if (updated.stock !== undefined && updated.stock !== null && (!Number.isSafeInteger(updated.stock) || updated.stock < 0)) throw new Error("TOOL_PRODUCT_STOCK_INVALID");
            }
            items[index] = updated;
            result = { saved: true, operation, resource, item: updated };
          } else {
            throw new Error("TOOL_OPERATION_NOT_SUPPORTED");
          }
        }
        nextSettings[field] = items;
      } else if (resource === "manager") {
        if (operation === "delete") {
          if (!confirmed) throw new Error("TOOL_DELETION_REQUIRES_CONFIRMATION");
          nextSettings.manager = {};
          result = { saved: true, operation, resource };
        } else if (operation === "create" || operation === "update" || operation === "replace") {
          const current = settings.manager && typeof settings.manager === "object" ? settings.manager : {};
          const updated = { ...current };
          if (data.name !== undefined) updated.name = String(data.name).trim().slice(0, 120);
          if (data.fullName !== undefined) updated.fullName = String(data.fullName).trim().slice(0, 120);
          if (data.phone !== undefined) updated.phone = String(data.phone).trim().slice(0, 40);
          if (!Object.keys(updated).length) throw new Error("TOOL_MANAGER_DATA_REQUIRED");
          nextSettings.manager = updated;
          result = { saved: true, operation, resource, item: updated };
        } else throw new Error("TOOL_OPERATION_NOT_SUPPORTED");
      } else if (resource === "aiRules") {
        if (!["update", "replace"].includes(operation)) throw new Error("TOOL_OPERATION_NOT_SUPPORTED");
        const rules = String(data.aiRules ?? "").trim();
        if (rules.length > 3000) throw new Error("TOOL_AI_RULES_TOO_LONG");
        nextSettings.aiRules = rules;
        result = { saved: true, operation, resource, item: { aiRules: rules } };
      }

      saveAIBusinessProfile(context.telegramId, context.sessionId, { settings: nextSettings });
    }

    outcome = "success";
    audit(context, name, args, outcome);
    return result;
  } catch (error) {
    audit(context, name, args, outcome);
    throw error;
  }
}
