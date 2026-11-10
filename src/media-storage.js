import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

export const MEDIA_ROOT = path.resolve(
  process.env.WHATSAPP_MEDIA_DIR || "./data/media"
);

const MIME_EXTENSIONS = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "video/mp4": ".mp4",
  "video/quicktime": ".mov",
  "video/webm": ".webm",
  "audio/ogg": ".ogg",
  "audio/mpeg": ".mp3",
  "audio/mp4": ".m4a",
  "application/pdf": ".pdf"
};

function safeExtension(mimetype, fileName) {
  const fromName = path.extname(String(fileName || "")).toLowerCase();
  if (/^\.[a-z0-9]{1,10}$/.test(fromName)) return fromName;
  return MIME_EXTENSIONS[String(mimetype || "").toLowerCase()] || ".bin";
}

export async function saveWhatsAppMedia({
  telegramId,
  sessionId = telegramId,
  messageId,
  buffer,
  mimetype,
  fileName
}) {
  const owner = String(telegramId || "");
  if (!/^\d+$/.test(owner)) throw new Error("Invalid media owner.");
  if (!messageId || !Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error("Invalid WhatsApp media payload.");
  }

  const accountId = String(sessionId || owner);
  const sessionDirectory = accountId === owner
    ? owner
    : crypto.createHash("sha256").update(accountId).digest("hex").slice(0, 32);
  const ownerDirectory = path.join(MEDIA_ROOT, owner, sessionDirectory);
  await fs.mkdir(ownerDirectory, { recursive: true, mode: 0o700 });

  const safeId = crypto
    .createHash("sha256")
    .update(String(messageId))
    .digest("hex");
  const destination = path.join(
    ownerDirectory,
    safeId + safeExtension(mimetype, fileName)
  );

  await fs.writeFile(destination, buffer, { mode: 0o600 });
  return destination;
}
