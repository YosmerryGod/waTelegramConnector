import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "wagram-ai-tools-"));
process.env.SQLITE_PATH = path.join(tempDirectory, "tools-test.sqlite");

const databaseUrl = new URL("../../src/database.js", import.meta.url);
const toolsUrl = new URL("../../src/ai/tools.js", import.meta.url);
const database = await import(databaseUrl.href);
const { executeWagramTool } = await import(toolsUrl.href);

const ownerContext = { telegramId: "111111", sessionId: "111111" };
const otherTenantContext = { telegramId: "222222", sessionId: "222222" };

try {
  database.saveAIBusinessProfile(ownerContext.telegramId, ownerContext.sessionId, {
    settings: {
      businessName: "Toko Satu",
      products: [
        { name: "Roti Pisang", price: "15000", stock: "12", available: true }
      ]
    }
  });
  database.saveAIBusinessProfile(otherTenantContext.telegramId, otherTenantContext.sessionId, {
    settings: {
      businessName: "Toko Dua",
      products: [
        { name: "Produk Rahasia", price: "99999", stock: "99", available: true }
      ]
    }
  });

  const profile = executeWagramTool("get_business_profile", {}, ownerContext);
  assert.equal(profile.identity.name, "Toko Satu");

  const products = executeWagramTool("list_products", {}, ownerContext);
  assert.equal(products.length, 1);
  assert.equal(products[0].name, "Roti Pisang");

  const stock = executeWagramTool("cek_stok", { produk: "Roti Pisang" }, ownerContext);
  assert.equal(stock.found, true);
  assert.equal(stock.products[0].stock, "12");

  const isolatedSearch = executeWagramTool("cek_stok", { produk: "Produk Rahasia" }, ownerContext);
  assert.equal(isolatedSearch.found, false);

  assert.throws(
    () => executeWagramTool("cek_stok", { produk: "" }, ownerContext),
    /TOOL_PRODUCT_QUERY_INVALID/
  );
  assert.throws(
    () => executeWagramTool("list_products", { ownerId: "222222" }, ownerContext),
    /TOOL_ARGUMENTS_INVALID/
  );
  assert.throws(
    () => executeWagramTool("list_products", {}, { telegramId: "not-an-id" }),
    /TOOL_AUTH_REQUIRED/
  );

  // [ADDED] Verify special outlet hours can be created, read, updated, and rejected when invalid.
  const outletCreated = executeWagramTool("manage_business_data", {
    resource: "outlets",
    operation: "create",
    data: {
      name: "Outlet Khusus",
      openTime: "08:00",
      closeTime: "21:00",
      timezone: "Asia/Jakarta",
      openDays: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"],
      specialHours: [{ date: "2026-12-25", closed: true }]
    }
  }, ownerContext);
  assert.equal(outletCreated.saved, true);
  let outletProfile = executeWagramTool("get_business_profile", { sections: ["outlets"] }, ownerContext);
  assert.deepEqual(outletProfile.outlets[0].specialHours, [{ date: "2026-12-25", closed: true }]);

  const outletUpdated = executeWagramTool("manage_business_data", {
    resource: "outlets",
    operation: "update",
    identifier: "Outlet Khusus",
    data: {
      specialHours: [{ date: "2026-12-25", openTime: "10:00", closeTime: "14:00" }]
    }
  }, ownerContext);
  assert.equal(outletUpdated.saved, true);
  outletProfile = executeWagramTool("get_business_profile", { sections: ["outlets"] }, ownerContext);
  assert.deepEqual(outletProfile.outlets[0].specialHours, [{ date: "2026-12-25", openTime: "10:00", closeTime: "14:00" }]);

  assert.throws(
    () => executeWagramTool("manage_business_data", {
      resource: "outlets",
      operation: "update",
      identifier: "Outlet Khusus",
      data: { specialHours: [{ date: "2026-12-25", closed: true }, { date: "2026-12-25", closed: true }] }
    }, ownerContext),
    /TOOL_OUTLET_SPECIAL_DATE_INVALID/
  );
  assert.throws(
    () => executeWagramTool("manage_business_data", {
      resource: "outlets",
      operation: "create",
      data: { name: "Outlet Jam Salah", specialHours: [{ date: "2026-12-25", openTime: "25:00", closeTime: "26:00" }] }
    }, ownerContext),
    /TOOL_OUTLET_SPECIAL_HOURS_INVALID/
  );

  const auditCount = database.default.prepare(
    "SELECT COUNT(*) AS count FROM ai_tool_audit_log WHERE telegram_id = ?"
  ).get(ownerContext.telegramId).count;
  assert.ok(auditCount >= 6, "Expected successful and rejected tool calls to be audited.");

  console.log("WAGRAM read-only tools: all tests passed.");
} finally {
  if (database.default.open) database.default.close();
  fs.rmSync(tempDirectory, { recursive: true, force: true });
}
