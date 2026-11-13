import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// [ADDED] Isolate the test from the production SQLite database.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "wagram-ai-auto-reply-"));
process.env.SQLITE_PATH = path.join(tempDir, "test.sqlite");

const database = await import("../../src/database.js");
const autoReply = await import("../../src/ai/auto-reply.js");
const db = database.default;

try {
  const firstClaim = autoReply.claimAIAutoReplyJob(
    "10001",
    "session-a",
    "628111111111@s.whatsapp.net",
    "incoming-message-1"
  );
  const duplicateClaim = autoReply.claimAIAutoReplyJob(
    "10001",
    "session-a",
    "628111111111@s.whatsapp.net",
    "incoming-message-1"
  );
  const nextMessageClaim = autoReply.claimAIAutoReplyJob(
    "10001",
    "session-a",
    "628111111111@s.whatsapp.net",
    "incoming-message-2"
  );
  const otherSessionClaim = autoReply.claimAIAutoReplyJob(
    "10001",
    "session-b",
    "628111111111@s.whatsapp.net",
    "incoming-message-1"
  );
  const otherOwnerClaim = autoReply.claimAIAutoReplyJob(
    "10002",
    "session-a",
    "628111111111@s.whatsapp.net",
    "incoming-message-1"
  );

  assert.equal(firstClaim, true, "First event must claim the reply job.");
  assert.equal(duplicateClaim, false, "Repeated event must not claim the same job.");
  assert.equal(nextMessageClaim, true, "A different incoming message must get its own job.");
  assert.equal(otherSessionClaim, true, "A different WhatsApp session must be isolated.");
  assert.equal(otherOwnerClaim, true, "A different account owner must be isolated.");

  db.prepare(`
    UPDATE ai_auto_reply_jobs
    SET generated_reply = ?, status = 'processing'
    WHERE telegram_id = ? AND session_id = ? AND chat_id = ? AND incoming_message_id = ?
  `).run(
    "Halo Kak, ada yang bisa dibantu?",
    "10001",
    "session-a",
    "628111111111@s.whatsapp.net",
    "incoming-message-1"
  );

  assert.equal(
    autoReply.isAIAutoReplyMessage(
      "10001",
      "session-a",
      "628111111111@s.whatsapp.net",
      "Halo Kak, ada yang bisa dibantu?"
    ),
    true,
    "Generated AI reply must be recognized and excluded from human training examples."
  );
  assert.equal(
    autoReply.isAIAutoReplyMessage(
      "10002",
      "session-a",
      "628111111111@s.whatsapp.net",
      "Halo Kak, ada yang bisa dibantu?"
    ),
    false,
    "Generated reply detection must not cross account boundaries."
  );

  console.log("PASS: durable auto-reply idempotency and tenant/session isolation.");
} finally {
  database.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
}
