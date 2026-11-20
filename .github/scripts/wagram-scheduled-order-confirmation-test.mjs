import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// [ADDED] Keep the confirmation test isolated from the configured business database.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "wagram-order-confirmation-"));
process.env.SQLITE_PATH = path.join(tempDir, "test.sqlite");

const database = await import("../../src/database.js");
const { validateScheduledOrderConfirmation } = await import("../../src/ai/customer-service.js");

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
