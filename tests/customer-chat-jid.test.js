import test from "node:test";
import assert from "node:assert/strict";

import { normalizeCustomerChatJid } from "../src/ai/customer-service.js";

test("normalizes a private phone-number JID from Baileys", () => {
  assert.equal(
    normalizeCustomerChatJid("628123456789:14@s.whatsapp.net"),
    "628123456789@s.whatsapp.net"
  );
});

test("normalizes a private LID JID from Baileys", () => {
  assert.equal(
    normalizeCustomerChatJid("123456789012:3@lid"),
    "123456789012@lid"
  );
});

test("accepts Baileys hosted private-user JID namespaces", () => {
  assert.equal(
    normalizeCustomerChatJid("123456789@hosted"),
    "123456789@hosted"
  );
  assert.equal(
    normalizeCustomerChatJid("123456789@hosted.lid"),
    "123456789@hosted.lid"
  );
});

test("rejects group, broadcast, malformed, and invalid phone JIDs", () => {
  assert.equal(normalizeCustomerChatJid("120363000000000000@g.us"), null);
  assert.equal(normalizeCustomerChatJid("status@broadcast"), null);
  assert.equal(normalizeCustomerChatJid("123456789@newsletter"), null);
  assert.equal(normalizeCustomerChatJid("123@ s.whatsapp.net"), null);
  assert.equal(normalizeCustomerChatJid("1234567@s.whatsapp.net"), null);
  assert.equal(normalizeCustomerChatJid(""), null);
});
