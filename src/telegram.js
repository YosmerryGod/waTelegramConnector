import "dotenv/config";
import pino from "pino";
import TelegramBot from "node-telegram-bot-api";
import QRCode from "qrcode";
import { downloadMediaMessage, proto } from "baileys";
import { publishToMiniApp } from "./realtime.js";

import {
  registerUser,
  getUser,
  getMembership,
  setMembership,
  getAppSetting, // [ADDED] Read persisted Free pause mode.
  setAppSetting, // [ADDED] Update persisted Free pause mode.
  listMembershipUsers,
  MEMBERSHIP_PLANS,
  getSession,
  getAllSessions, // [ADDED] Find every active WhatsApp session for the admin pause command.
  setFreePauseDate, // [ADDED] Prevent the daily scheduler from pausing the same user twice.
  updateSession,
  updateWhatsAppAccountSession, // [ADDED] Persist independent WhatsApp account status.
  linkWhatsAppSessionByPhone, // [ADDED] Restore prior data identity when the same WhatsApp number is paired again.
  markSessionDisconnected,
  reserveForwardedMessage,
  saveWhatsAppMessage, // [ADDED] Persist messages for the Mini App.
  updateWhatsAppMessage, // [ADDED] Apply WhatsApp message edits to the existing row.
  markWhatsAppMessageDeleted, // [ADDED] Persist WhatsApp message revoke events.
  attachLocalMedia, // [ADDED] Link private VPS media files to saved messages.
  // [ADDED] Contacts and call history.
  ValidationError,
  saveContact,
  listContacts,
  deleteContactByPhone,
  recordCall,
  findContactName,
  attachTelegramFile,
  getPremiumPaymentOrderById, // [ADDED] Load a payment order for admin review.
  reviewPremiumPaymentOrder // [ADDED] Apply an admin approval or rejection.
} from "./database.js";

import { saveWhatsAppMedia } from "./media-storage.js";

// [ADDED] Store customer/admin reply examples for the enabled AI assistant.
import { recordAICustomerServiceMessage } from "./ai/customer-service.js";

// [ADDED] Run one-time AI auto replies for eligible incoming private messages.
import { handleIncomingAIAutoReply, handleIncomingAIPaymentProof, handleIncomingManagerReply, isAIAutoReplyMessage } from "./ai/auto-reply.js";

import {
  connectWhatsApp,
  disconnectWhatsApp,
  getWhatsAppStatus
} from "./whatsapp.js";

// Telegram bot configuration.
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

// [ADDED] Public Telegram Mini App URL.
const MINI_APP_URL = process.env.MINI_APP_URL || "https://chat.doodweb.tech";

const MESSAGE_LIMIT = Math.min(
  4000,
  Math.max(1000, Number(process.env.TELEGRAM_MESSAGE_LIMIT || 4000))
);

// Telegram caption limit is 1024 characters.
const CAPTION_LIMIT = 1024;

// Telegram Bot API upload limit is 50 MB; keep a safety margin.
const MAX_MEDIA_BYTES =
  Math.max(1, Number(process.env.MAX_MEDIA_MB || 45)) * 1024 * 1024;

const MAX_TEXT_CHUNKS = 5;
const GROUP_NAME_TTL_MS = 10 * 60 * 1000;

if (!BOT_TOKEN) {
  throw new Error("TELEGRAM_BOT_TOKEN is required in .env");
}

// Start Telegram bot using long polling.
export const bot = new TelegramBot(BOT_TOKEN, {
  polling: true
});

// Silent logger for media downloads.
const mediaLogger = pino({ level: "silent" });

// Track QR messages to avoid flooding a chat.
const lastQrSentAt = new Map();
const QR_COOLDOWN_MS = 3000;

// [ADDED] Quiet reconnect handling: short drops reconnect silently and
// only a drop longer than this delay is reported to the user.
const DISCONNECT_NOTICE_DELAY_MS = Math.max(
  0,
  Number(process.env.DISCONNECT_NOTICE_DELAY_MS || 45000)
);

const disconnectTimers = new Map();
const reconnecting = new Set();
const notifiedDown = new Set();
const pairing = new Set();

function clearDisconnectTimer(id) {
  const timer = disconnectTimers.get(id);

  if (timer) {
    clearTimeout(timer);
    disconnectTimers.delete(id);
  }
}

// Cache group subjects to avoid repeated WhatsApp lookups.
const groupNameCache = new Map();

// ---------------------------------------------------------------------------
// Telegram helpers
// ---------------------------------------------------------------------------

// [ADDED] Open the WAGRAM Mini App from Telegram messages.
function openMiniAppOptions() {
  return {
    reply_markup: {
      inline_keyboard: [[
        { text: "Open WAGRAM", web_app: { url: MINI_APP_URL } }
      ]]
    }
  };
}


// Escape text for Telegram HTML parse mode.
function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Split plain text into HTML-escaped chunks that fit a length limit.
function splitEscaped(text, max) {
  const chunks = [];
  let current = "";
  let currentLength = 0;

  for (const char of String(text ?? "")) {
    const escaped = esc(char);

    if (currentLength + escaped.length > max) {
      chunks.push(current);
      current = "";
      currentLength = 0;
    }

    current += escaped;
    currentLength += escaped.length;
  }

  if (current || chunks.length === 0) {
    chunks.push(current);
  }

  return chunks;
}

// Safely send a plain text message.
async function sendText(chatId, text, options = {}) {
  return bot.sendMessage(
    chatId,
    String(text).slice(0, MESSAGE_LIMIT),
    {
      disable_web_page_preview: true,
      ...options
    }
  );
}

// Send an HTML message.
async function sendHtml(chatId, html, options = {}) {
  return bot.sendMessage(chatId, html, {
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...options
  });
}

// Send remaining text chunks as follow-up messages.
async function sendFollowUps(chatId, chunks, replyTo) {
  for (const chunk of chunks.slice(0, MAX_TEXT_CHUNKS)) {
    if (!chunk) {
      continue;
    }

    await sendHtml(chatId, chunk, {
      reply_to_message_id: replyTo,
      allow_sending_without_reply: true
    });
  }
}

// Ensure only the registered Telegram account controls its session.
function isAuthorizedUser(telegramId) {
  const user = getUser(telegramId);
  return Boolean(user && user.is_active === 1);
}

// ---------------------------------------------------------------------------
// Identity helpers
// ---------------------------------------------------------------------------

// Convert a WhatsApp PN JID to a phone number (device suffix allowed).
function jidToPhone(jid) {
  if (typeof jid !== "string") {
    return null;
  }

  const match = jid.match(/^(\d+)(?::\d+)?@s\.whatsapp\.net$/);

  return match ? match[1] : null;
}

// Find a phone number from available WhatsApp message fields.
function resolvePhoneNumber(message) {
  const key = message?.key || {};

  const candidates = [
    key.remoteJidAlt,
    key.participantAlt,
    key.remoteJidPn,
    key.participantPn,
    message?.remoteJidAlt,
    message?.participantAlt,
    message?.remoteJidPn,
    message?.participantPn
  ];

  for (const candidate of candidates) {
    const phone = jidToPhone(candidate);

    if (phone) {
      return phone;
    }
  }

  // Fall back to the primary JID only if it is a PN JID.
  const primaryJid = key.participant || key.remoteJid;
  return jidToPhone(primaryJid);
}

// Format an identifier without pretending an LID is a phone number.
function formatSenderIdentifier(jid, phoneNumber) {
  if (phoneNumber) {
    return `+${phoneNumber}`;
  }

  if (typeof jid !== "string" || !jid) {
    return "unknown";
  }

  if (jid.endsWith("@lid")) {
    return `ID ${jid.replace(/(?::\d+)?@lid$/, "")}`;
  }

  if (jid.endsWith("@s.whatsapp.net")) {
    return `+${jid.replace(/(?::\d+)?@s\.whatsapp\.net$/, "")}`;
  }

  return jid;
}

// Resolve a group subject with a small cache.
async function getGroupName(socket, telegramId, groupJid) {
  const cacheKey = `${telegramId}:${groupJid}`;
  const cached = groupNameCache.get(cacheKey);

  if (cached && Date.now() - cached.at < GROUP_NAME_TTL_MS) {
    return cached.name;
  }

  let name = "Group";

  try {
    const metadata = await socket?.groupMetadata?.(groupJid);

    if (metadata?.subject) {
      name = metadata.subject;
    }
  } catch {
    // Keep the generic fallback name.
  }

  groupNameCache.set(cacheKey, { name, at: Date.now() });

  return name;
}

// ---------------------------------------------------------------------------
// Time formatting
// ---------------------------------------------------------------------------

// Convert a WhatsApp timestamp (number or Long) to a Date.
function toDate(timestamp) {
  if (timestamp === undefined || timestamp === null) {
    return null;
  }

  const numeric =
    typeof timestamp?.toNumber === "function"
      ? timestamp.toNumber()
      : Number(timestamp);

  if (!Number.isFinite(numeric)) {
    return null;
  }

  const date = new Date(numeric * 1000);

  return Number.isNaN(date.getTime()) ? null : date;
}

// Full date and time, used by /status.
function formatTimestamp(timestamp) {
  const date = toDate(timestamp);

  if (!date) {
    return "unknown";
  }

  return date.toLocaleString("en-GB", {
    timeZone: "Asia/Jakarta",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
}

// Compact time for message headers: "22:43" today, "20 Oct, 22:43" otherwise.
function formatShortTime(timestamp) {
  const date = toDate(timestamp) || new Date();

  const options = { timeZone: "Asia/Jakarta" };

  const day = date.toLocaleDateString("en-GB", options);
  const today = new Date().toLocaleDateString("en-GB", options);

  const time = date.toLocaleTimeString("en-GB", {
    ...options,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });

  if (day === today) {
    return time;
  }

  const shortDate = date.toLocaleDateString("en-GB", {
    ...options,
    day: "numeric",
    month: "short"
  });

  return `${shortDate}, ${time}`;
}

// ---------------------------------------------------------------------------
// WhatsApp message parsing
// ---------------------------------------------------------------------------

// Unwrap common WhatsApp message wrappers.
function unwrapMessage(message) {
  let content = message;

  for (let i = 0; i < 6 && content; i++) {
    const inner =
      content.ephemeralMessage?.message ||
      content.viewOnceMessage?.message ||
      content.viewOnceMessageV2?.message ||
      content.viewOnceMessageV2Extension?.message ||
      content.documentWithCaptionMessage?.message ||
      content.editedMessage?.message;

    if (!inner) {
      break;
    }

    content = inner;
  }

  return content || null;
}

// [MODIFIED] Detect View Once from message wrappers, media flags, or Baileys key metadata.
function getViewOnceInfo(message, isViewOnce = false) {
  let content = message;
  let detectedViewOnce = Boolean(isViewOnce);
  let mediaContent = null;

  // [ADDED] Baileys can expose View Once as a flag on the media payload itself,
  // without wrapping it in viewOnceMessageV2 or setting key.isViewOnce.
  for (let i = 0; i < 8 && content; i++) {
    const image = content.imageMessage;
    const video = content.videoMessage || content.ptvMessage;
    const audio = content.audioMessage;
    const document = content.documentMessage;
    const sticker = content.stickerMessage;

    if (image || video || audio || document || sticker) {
      mediaContent = content;
      if (
        image?.viewOnce === true ||
        video?.viewOnce === true ||
        audio?.viewOnce === true ||
        document?.viewOnce === true ||
        sticker?.viewOnce === true
      ) {
        detectedViewOnce = true;
      }
      break;
    }

    const viewOnce =
      content.viewOnceMessage?.message ||
      content.viewOnceMessageV2?.message ||
      content.viewOnceMessageV2Extension?.message;

    if (viewOnce) {
      content = viewOnce;
      detectedViewOnce = true;
      continue;
    }

    const nested =
      content.ephemeralMessage?.message ||
      content.documentWithCaptionMessage?.message ||
      content.editedMessage?.message;

    if (!nested) break;
    content = nested;
  }

  if (!detectedViewOnce) return null;

  const media = mediaContent?.imageMessage
    ? "foto"
    : mediaContent?.videoMessage || mediaContent?.ptvMessage
      ? "video"
      : mediaContent?.audioMessage
        ? "audio"
        : mediaContent?.documentMessage
          ? "dokumen"
          : mediaContent?.stickerMessage
            ? "stiker"
            : "media";

  return { media };
}

// Convert a Long/number/string size to a number.
function toNumber(value) {
  if (value === undefined || value === null) {
    return 0;
  }

  if (typeof value?.toNumber === "function") {
    return value.toNumber();
  }

  const numeric = Number(value);

  return Number.isFinite(numeric) ? numeric : 0;
}

// Detect a downloadable media message.
function getMediaInfo(content) {
  if (content.imageMessage) {
    const m = content.imageMessage;

    return {
      kind: "image",
      caption: m.caption || "",
      size: toNumber(m.fileLength),
      mimetype: m.mimetype || "image/jpeg",
      fileName: "photo.jpg"
    };
  }

  if (content.videoMessage || content.ptvMessage) {
    const m = content.videoMessage || content.ptvMessage;

    return {
      kind: "video",
      caption: m.caption || "",
      size: toNumber(m.fileLength),
      mimetype: m.mimetype || "video/mp4",
      fileName: "video.mp4",
      gif: Boolean(m.gifPlayback)
    };
  }

  if (content.audioMessage) {
    const m = content.audioMessage;

    return {
      kind: "audio",
      caption: "",
      size: toNumber(m.fileLength),
      mimetype: m.mimetype || "audio/ogg",
      fileName: m.ptt ? "voice.ogg" : "audio.m4a",
      ptt: Boolean(m.ptt)
    };
  }

  if (content.stickerMessage) {
    const m = content.stickerMessage;

    return {
      kind: "sticker",
      caption: "",
      size: toNumber(m.fileLength),
      mimetype: m.mimetype || "image/webp",
      fileName: "sticker.webp"
    };
  }

  if (content.documentMessage) {
    const m = content.documentMessage;

    return {
      kind: "document",
      caption: m.caption || "",
      size: toNumber(m.fileLength),
      mimetype: m.mimetype || "application/octet-stream",
      fileName: m.fileName || "file"
    };
  }

  return null;
}

// [ADDED] Check that a media payload contains a usable decryption key.
function hasMediaKey(content) {
  const media =
    content?.imageMessage ||
    content?.videoMessage ||
    content?.ptvMessage ||
    content?.audioMessage ||
    content?.stickerMessage ||
    content?.documentMessage;
  const mediaKey = media?.mediaKey;

  if (Buffer.isBuffer(mediaKey) || mediaKey instanceof Uint8Array) {
    return mediaKey.length > 0;
  }

  return typeof mediaKey === "string" && mediaKey.trim().length > 0;
}

// [ADDED] Format a WhatsApp call-log message.
const CALL_OUTCOMES = [
  "Connected",
  "Missed",
  "Failed",
  "Rejected",
  "Answered on another device",
  "Ongoing",
  "Silenced (Do Not Disturb)",
  "Silenced (unknown caller)"
];

function formatCallLog(log) {
  const kind = log.isVideo ? "video" : "voice";

  let outcome = log.callOutcome;

  if (typeof outcome === "number") {
    outcome = CALL_OUTCOMES[outcome];
  } else if (typeof outcome === "string") {
    outcome = outcome
      .toLowerCase()
      .replace(/_/g, " ")
      .replace(/^./, (c) => c.toUpperCase());
  } else {
    outcome = null;
  }

  const seconds = toNumber(log.durationSecs);

  const duration =
    seconds > 0
      ? `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`
      : null;

  const parts = [outcome, duration].filter(Boolean);

  return `📞 ${kind[0].toUpperCase()}${kind.slice(1)} call` +
    (parts.length ? ` — ${parts.join(" · ")}` : "");
}

// Extract plain text or a short description for non-media messages.
// Returns null when the message should be skipped.
function getTextBody(content) {
  if (content.conversation) {
    return content.conversation;
  }

  if (content.extendedTextMessage?.text) {
    return content.extendedTextMessage.text;
  }

  if (content.buttonsResponseMessage?.selectedDisplayText) {
    return content.buttonsResponseMessage.selectedDisplayText;
  }

  if (content.listResponseMessage?.title) {
    return content.listResponseMessage.title;
  }

  if (content.templateButtonReplyMessage?.selectedDisplayText) {
    return content.templateButtonReplyMessage.selectedDisplayText;
  }

  if (content.locationMessage || content.liveLocationMessage) {
    const location =
      content.locationMessage || content.liveLocationMessage;

    const lat = location.degreesLatitude;
    const lng = location.degreesLongitude;
    const label = content.liveLocationMessage
      ? "📍 Live location"
      : "📍 Location";

    return lat !== undefined && lng !== undefined
      ? `${label}\nhttps://maps.google.com/?q=${lat},${lng}`
      : label;
  }

  if (content.contactMessage) {
    return `👤 Contact: ${content.contactMessage.displayName || "unknown"}`;
  }

  if (content.contactsArrayMessage) {
    const names = (content.contactsArrayMessage.contacts || [])
      .map((contact) => contact.displayName)
      .filter(Boolean)
      .join(", ");

    return `👤 Contacts: ${names || "multiple"}`;
  }

  if (content.pollCreationMessage || content.pollCreationMessageV2) {
    const poll =
      content.pollCreationMessage || content.pollCreationMessageV2;

    return `📊 Poll: ${poll.name || ""}`.trim();
  }

  // [ADDED] Call log (outgoing calls made from the phone show up here).
  const callLog = content.callLogMesssage || content.callLogMessage;

  if (callLog) {
    return formatCallLog(callLog);
  }

  if (content.reactionMessage) {
    const emoji = content.reactionMessage.text;

    // An empty reaction means the reaction was removed.
    return emoji ? `Reacted ${emoji}` : null;
  }

  // Protocol, key-distribution, and poll-vote events are noise.
  if (
    content.protocolMessage ||
    content.senderKeyDistributionMessage ||
    content.pollUpdateMessage
  ) {
    return null;
  }

  return "Unsupported message type";
}

// ---------------------------------------------------------------------------
// Message header
// ---------------------------------------------------------------------------

function buildHeader({
  isOutgoing,
  isGroup,
  name,
  savedName,
  groupName,
  who,
  time
}) {
  const whoHtml = `<code>${esc(who)}</code>`;

  if (isGroup) {
    return isOutgoing
      ? `📤 <b>${esc(groupName)}</b> · ${esc(time)}`
      : `👥 <b>${esc(groupName)}</b>\n` +
          `${esc(name)} · ${whoHtml} · ${esc(time)}`;
  }

  return isOutgoing
    ? `📤 To ${savedName ? `<b>${esc(savedName)}</b> · ` : ""}${whoHtml} · ${esc(time)}`
    : `📩 <b>${esc(name)}</b>\n${whoHtml} · ${esc(time)}`;
}

// ---------------------------------------------------------------------------
// Call notifications
// ---------------------------------------------------------------------------

// [ADDED] Convert a Baileys call date (Date or unix seconds) to unix seconds.
function callTimestamp(call) {
  if (call?.date instanceof Date && !Number.isNaN(call.date.getTime())) {
    return Math.floor(call.date.getTime() / 1000);
  }

  const numeric = Number(call?.date);

  return Number.isFinite(numeric) && numeric > 0 ? numeric : undefined;
}

// [ADDED] Build the Telegram message for a WhatsApp call event.
// Returns null for statuses that should not notify (accept, terminate, ...).
// [ADDED] Work out who is on the other end of a call event.
// Shared by the Telegram notification and the call history.
function resolveCallParties(call, socket) {
  // A call event whose caller is our own account is outgoing.
  const baseUser = (jid) =>
    typeof jid === "string" ? jid.split("@")[0].split(":")[0] : null;

  const callerUser = baseUser(call?.from);

  const isOutgoing = Boolean(
    callerUser &&
      [baseUser(socket?.user?.id), baseUser(socket?.user?.lid)].includes(
        callerUser
      )
  );

  // Outgoing: show the person being called (chatId), not our own number.
  const peerJid = isOutgoing
    ? call.chatId || call.from
    : call.from || call.chatId;

  const phoneNumber = isOutgoing
    ? jidToPhone(peerJid)
    : jidToPhone(call.callerPn) ||
      jidToPhone(call.from) ||
      jidToPhone(call.chatId);

  return { isOutgoing, peerJid, phoneNumber };
}

// [ADDED] Save a call event to the Mini App call history.
// Baileys sends several events per call (offer, accept, timeout, ...);
// the database keeps one row per call and only moves it out of "ringing" once.
function storeCallEvent({ call, socket, telegramId, sessionId = telegramId }) {
  const { isOutgoing, peerJid, phoneNumber } = resolveCallParties(
    call,
    socket
  );

  let status;

  switch (call.status) {
    case "offer":
    case "ringing":
      status = "ringing";
      break;

    case "accept":
      status = "answered";
      break;

    case "reject":
      status = "rejected";
      break;

    case "timeout":
      status = isOutgoing ? "no_answer" : "missed";
      break;

    default:
      // "terminate" and unknown events do not change the outcome.
      return;
  }

  const seconds = callTimestamp(call);

  recordCall({
    telegramId,
    sessionId,
    callId: call.id,
    direction: isOutgoing ? "outgoing" : "incoming",
    status,
    isVideo: Boolean(call.isVideo),
    isGroup: Boolean(call.groupJid || call.isGroup),
    peerJid,
    phoneNumber,
    timestampMs: seconds ? seconds * 1000 : Date.now()
  });
}

async function buildCallMessage({ call, socket, telegramId }) {
  const status = call?.status;

  // "offer"/"ringing" = incoming call, "timeout" = nobody answered (missed).
  const isIncomingEvent = status === "offer" || status === "ringing";

  if (!isIncomingEvent && status !== "timeout") {
    return null;
  }

  const { isOutgoing, peerJid, phoneNumber } = resolveCallParties(
    call,
    socket
  );

  const isIncoming = isIncomingEvent;

  const who = formatSenderIdentifier(peerJid, phoneNumber);
  const time = formatShortTime(callTimestamp(call));
  const kind = call.isVideo ? "video" : "voice";

  const groupJid = call.groupJid || (call.isGroup ? call.chatId : null);

  const groupName = groupJid
    ? await getGroupName(socket, telegramId, groupJid)
    : null;

  const title = isOutgoing
    ? `📤 <b>Outgoing ${kind} call</b>`
    : isIncoming
      ? `📞 <b>Incoming ${kind} call</b>`
      : `📵 <b>Missed ${kind} call</b>`;

  const lines = [title];

  if (groupName) {
    lines.push(`👥 ${esc(groupName)}`);
  }

  // [ADDED] Show the saved contact name for calls too.
  const callName = findContactName(telegramId, phoneNumber, sessionId);

  lines.push(
    `${callName ? `<b>${esc(callName)}</b> · ` : ""}` +
      `<code>${esc(who)}</code> · ${esc(time)}`
  );

  if (isIncoming && call.offline) {
    lines.push("<i>Received while offline</i>");
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Media forwarding
// ---------------------------------------------------------------------------

// Send media to Telegram, falling back to a document when the type is rejected.
async function sendMediaToTelegram(chatId, info, buffer, extra) {
  const fileOptions = {
    filename: info.fileName,
    contentType: info.mimetype
  };

  const sendAsDocument = () =>
    bot.sendDocument(chatId, buffer, extra, fileOptions);

  try {
    switch (info.kind) {
      case "image":
        return await bot.sendPhoto(chatId, buffer, extra, fileOptions);

      case "video":
        return info.gif
          ? await bot.sendAnimation(chatId, buffer, extra, fileOptions)
          : await bot.sendVideo(chatId, buffer, extra, fileOptions);

      case "audio":
        return info.ptt
          ? await bot.sendVoice(chatId, buffer, extra, fileOptions)
          : await bot.sendAudio(chatId, buffer, extra, fileOptions);

      case "sticker":
        return await bot.sendSticker(chatId, buffer, extra, fileOptions);

      default:
        return await sendAsDocument();
    }
  } catch (error) {
    if (info.kind === "document") {
      throw error;
    }

    console.warn(
      `Telegram rejected ${info.kind} (${error.message}); sending as document.`
    );

    return sendAsDocument();
  }
}

// [ADDED] Pick the file_id out of the message Telegram returned after upload.
function extractTelegramFile(sent) {
  if (!sent) {
    return null;
  }

  if (Array.isArray(sent.photo) && sent.photo.length > 0) {
    // Last entry is the largest size.
    return { fileId: sent.photo[sent.photo.length - 1].file_id, kind: "photo" };
  }

  // Check animation before document: GIFs carry both.
  const candidates = [
    ["animation", sent.animation],
    ["video", sent.video],
    ["sticker", sent.sticker],
    ["voice", sent.voice],
    ["audio", sent.audio],
    ["document", sent.document]
  ];

  for (const [kind, file] of candidates) {
    if (file?.file_id) {
      return { fileId: file.file_id, kind };
    }
  }

  return null;
}

// Download WhatsApp media and forward it to Telegram.
// Returns the Telegram message that carries the media (or undefined).
async function forwardMedia({ chatId, socket, message, info, header, text }) {
  const escapedChunks = splitEscaped(text, MESSAGE_LIMIT - 200);
  const escapedText = escapedChunks.join("");

  // [ADDED] Skip media that cannot be decrypted instead of invoking Baileys.
  const content = unwrapMessage(message?.message || {});
  if (!hasMediaKey(content)) {
    console.warn("WhatsApp media skipped: missing mediaKey before Telegram forwarding.");
    await sendHtml(
      chatId,
      `${header}\\n\\n⚠️ Media cannot be downloaded because its decryption key is unavailable.` +
        (escapedText ? `\\n\\n${escapedText}` : "")
    );
    return;
  }

  // Skip oversized files before downloading them.
  if (info.size && info.size > MAX_MEDIA_BYTES) {
    const sizeMb = (info.size / 1024 / 1024).toFixed(1);

    await sendHtml(
      chatId,
      `${header}\n\n⚠️ ${esc(info.fileName)} (${sizeMb} MB) is too large to forward.` +
        (escapedText ? `\n\n${escapedText}` : "")
    );

    return;
  }

  let buffer;

  try {
    buffer = await downloadMediaMessage(
      message,
      "buffer",
      {},
      {
        logger: mediaLogger,
        reuploadRequest: socket.updateMediaMessage
      }
    );
  } catch (error) {
    console.error("Failed to download WhatsApp media:", error.message);

    await sendHtml(
      chatId,
      `${header}\n\n⚠️ Media could not be downloaded.` +
        (escapedText ? `\n\n${escapedText}` : "")
    );

    return;
  }

  if (!buffer || buffer.length === 0 || buffer.length > MAX_MEDIA_BYTES) {
    await sendHtml(
      chatId,
      `${header}\n\n⚠️ Media is empty or too large to forward.`
    );

    return;
  }

  // Stickers and video notes do not support captions: send the header first.
  if (info.kind === "sticker") {
    const headerMessage = await sendHtml(chatId, header);

    return sendMediaToTelegram(chatId, info, buffer, {
      reply_to_message_id: headerMessage.message_id,
      allow_sending_without_reply: true
    });
  }

  const captionWithText = escapedText
    ? `${header}\n\n${escapedText}`
    : header;

  const fitsInCaption = captionWithText.length <= CAPTION_LIMIT;

  const sent = await sendMediaToTelegram(chatId, info, buffer, {
    caption: fitsInCaption ? captionWithText : header,
    parse_mode: "HTML"
  });

  // Long captions are sent as a follow-up reply.
  if (!fitsInCaption && escapedText) {
    await sendFollowUps(chatId, escapedChunks, sent?.message_id);
  }

  return sent;
}

// ---------------------------------------------------------------------------
// WhatsApp -> Telegram callbacks
// ---------------------------------------------------------------------------

// Create callbacks for one Telegram user's WhatsApp connection.
// [MODIFIED] Startup restoration can update Mini App status without Telegram spam.
export function createWhatsAppCallbacks(telegramId, options = {}) {
  const id = String(telegramId);
  const sessionId = String(options.sessionId || id);
  const stateKey = sessionId;
  const isAdditionalSession = sessionId !== id;
  const silentStartup = options.silentStartup === true;
  // [ADDED] Mini App pairing keeps QR delivery inside the Mini App, never Telegram chat.
  const notifyQrToTelegram = options.notifyQrToTelegram === true ||
    (options.notifyQrToTelegram !== false && !isAdditionalSession);

  return {
    onQr: async (qr) => {
      // [ADDED] Do not send QR photos to Telegram for additional Mini App sessions.
      if (!notifyQrToTelegram) return;

      const now = Date.now();
      const lastSent = lastQrSentAt.get(sessionId) || 0;

      if (now - lastSent < QR_COOLDOWN_MS) {
        return;
      }

      lastQrSentAt.set(sessionId, now);

      try {
        const imageBuffer = await QRCode.toBuffer(qr, {
          type: "png",
          width: 400,
          margin: 2,
          errorCorrectionLevel: "M"
        });

        await bot.sendPhoto(
          id,
          imageBuffer,
          {
            caption:
              "🔗 Link WhatsApp\n\n" +
              "WhatsApp → Settings → Linked devices → Link a device, then scan this QR.\n\n" +
              "The QR expires quickly. Use /connect to get a new one."
          },
          { filename: "qr.png", contentType: "image/png" }
        );
      } catch (error) {
        console.error("Failed to send WhatsApp QR:", error.message);

        await sendText(id, "Could not send the QR. Try /connect again.");
      }
    },

    onStatus: async (status, phoneNumber, info = {}) => {
      try {
        // "replaced" is stored as disconnected in the database.
        if (isAdditionalSession) {
          updateWhatsAppAccountSession(
            id,
            sessionId,
            status === "replaced" ? "disconnected" : status,
            phoneNumber || null
          );
        } else {
          updateSession(
            id,
            status === "replaced" ? "disconnected" : status,
            phoneNumber || null
          );
        }

        // [ADDED] Recover the previous data identity for the same verified WhatsApp number.
        if (status === "connected" && phoneNumber) {
          const relink = linkWhatsAppSessionByPhone(id, sessionId, phoneNumber);
          if (relink) {
            console.info("[WAGRAM Session Recovery] Re-linked same WhatsApp number to previous data:", JSON.stringify(relink));
          }
        }

        // [ADDED] Broadcast connection state after persisting it.
        publishToMiniApp(id, {
          type: "connection.status",
          data: {
            sessionId,
            status: status === "replaced" ? "disconnected" : status,
            phoneNumber: phoneNumber || null
          }
        });
      } catch (error) {
        console.error("Failed to update session:", error.message);
      }

      const notify = async (text, options = {}) => {
        try {
          await sendText(id, text, options);
        } catch (error) {
          console.error("Failed to send status:", error.message);
        }
      };

      // [ADDED] Restored sessions stay silent on server startup; Mini App status is still broadcast above.
      if (silentStartup && ["connecting", "connected"].includes(status)) {
        return;
      }

      // Manual /disconnect or shutdown: no timers, no reconnect notices.
      if (status === "disconnected" && info.intentional) {
        clearDisconnectTimer(stateKey);
        reconnecting.delete(stateKey);
        notifiedDown.delete(stateKey);
        return;
      }

      // Transient drop: reconnect silently, warn only if it lasts.
      if (status === "disconnected") {
        reconnecting.add(stateKey);

        if (!disconnectTimers.has(stateKey)) {
          const timer = setTimeout(async () => {
            disconnectTimers.delete(stateKey);

            if (!reconnecting.has(stateKey)) {
              return;
            }

            notifiedDown.add(stateKey);

            await notify(
              "⚠️ <b>WhatsApp Connection Lost</b>\n\nWAGRAM is trying to reconnect automatically. Open WAGRAM to check your connection.",
              { ...openMiniAppOptions(), parse_mode: "HTML" }
            );
          }, DISCONNECT_NOTICE_DELAY_MS);

          timer.unref?.();
          disconnectTimers.set(stateKey, timer);
        }

        return;
      }

      // Reconnect attempts are silent.
      if (status === "connecting" && reconnecting.has(stateKey)) {
        return;
      }

      if (status === "connected") {
        const wasNotified = notifiedDown.has(stateKey);
        const wasReconnecting = reconnecting.has(stateKey);
        const wasPairing = pairing.has(stateKey);

        pairing.delete(stateKey);

        clearDisconnectTimer(stateKey);
        reconnecting.delete(stateKey);
        notifiedDown.delete(stateKey);

        if (wasNotified) {
          await notify(
            `✅ WhatsApp reconnected${
              phoneNumber ? ` (+${phoneNumber})` : ""
            }`
          );
        } else if (!wasReconnecting || wasPairing) {
          await notify(
            `✅ WhatsApp connected${
              phoneNumber ? ` (+${phoneNumber})` : ""
            }`
          );
        }

        return;
      }

      // qr, logged_out, replaced: always reset reconnect state.
      if (status === "qr") {
        pairing.add(stateKey);
      }

      if (["qr", "logged_out", "replaced"].includes(status)) {
        clearDisconnectTimer(stateKey);
        reconnecting.delete(stateKey);
        notifiedDown.delete(stateKey);
      }

      const messages = {
        connecting: "⏳ Connecting to WhatsApp...",
        qr: "📷 QR code is ready to scan.",
        logged_out:
          "🚪 <b>WhatsApp Logged Out</b>\n\nYour WhatsApp account has been unlinked from WAGRAM. Open WAGRAM to reconnect your account.",
        replaced:
          "⚠️ <b>WhatsApp Session Replaced</b>\n\nThis WhatsApp session was taken over by another linked device or bot instance. Open WAGRAM to reconnect.",
      };

      const message = messages[status];

      // [ADDED] Additional sessions are paired from the Mini App; keep pairing progress out of Telegram.
      if (isAdditionalSession && ["connecting", "qr"].includes(status)) {
        return;
      }

      if (message) {
        await notify(
          message,
          ["logged_out", "replaced"].includes(status)
            ? { ...openMiniAppOptions(), parse_mode: "HTML" }
            : {}
        );
      }
    },

    onMessage: async ({ message, socket }) => {
      try {
        const key = message?.key || {};
        const messageId = key.id;

        if (!messageId) {
          return;
        }

        // [ADDED] Detect View Once before unwrapMessage removes its wrapper.
        // [MODIFIED] A key-only View Once event is still a valid notification.
        const viewOnceInfo = getViewOnceInfo(message.message || {}, key.isViewOnce === true);
        const content = unwrapMessage(message.message || {}) || {};

        if (!viewOnceInfo && !message.message) {
          return;
        }

        if (!viewOnceInfo && !content) {
          return;
        }

        // [ADDED] Encrypted edit envelopes are transport metadata, not user messages.
        // The Baileys edit-decryption patch emits the actual update separately.
        if (content.secretEncryptedMessage) {
          return;
        }

        // [MODIFIED] Never attempt to download View Once media into WAGRAM.
        const info = viewOnceInfo ? null : getMediaInfo(content);
        // [ADDED] Assign a non-null placeholder immediately so View Once messages
        // are not discarded by the normal unsupported-message/noise filter.
        let body = viewOnceInfo
          ? "View Once media"
          : info
            ? info.caption
            : getTextBody(content);

        // Skip noise such as protocol events and removed reactions.
        if (!viewOnceInfo && body === null) {
          return;
        }

        // Prevent duplicate forwards.
        const reserved = reserveForwardedMessage(messageId, id, sessionId);

        if (!reserved) {
          return;
        }

        const remoteJid = key.remoteJid || "";
        const participant = key.participant || "";
        const isGroup = remoteJid.endsWith("@g.us");
        const isOutgoing = Boolean(key.fromMe);

        const phoneNumber = resolvePhoneNumber(message);
        const senderJid = isGroup ? participant : remoteJid;
        const who = formatSenderIdentifier(senderJid, phoneNumber);

        // [ADDED] A name saved in Contacts wins over the WhatsApp push name.
        const savedName = findContactName(
          id,
          phoneNumber || (isGroup ? null : jidToPhone(remoteJid)),
          sessionId
        );
        const name = savedName || message.pushName || who;

        // [ADDED] Give users a clear WhatsApp handoff notice for unsupported content.
        if (viewOnceInfo) {
          const senderLabel = isOutgoing ? "Anda" : name;
          body = `${senderLabel} telah mengirim ${viewOnceInfo.media} sekali lihat. Lihat langsung di WhatsApp.`;
        } else if (body === "Unsupported message type") {
          const senderLabel = isOutgoing ? "Anda" : name;
          body = `${senderLabel} mengirim jenis pesan yang belum didukung WAGRAM. Lihat langsung di WhatsApp.`;
        }

        const groupName = isGroup
          ? await getGroupName(socket, id, remoteJid)
          : null;

        // [ADDED] Persist the message for the Mini App. This only writes to
        // our local database; it does not mark the WhatsApp message as read.
        const rawTimestamp = toNumber(message.messageTimestamp);
        const messageTimestamp = rawTimestamp > 0
          ? rawTimestamp * 1000
          : Date.now();

        const messageType = viewOnceInfo
          ? "view_once"
          : info
            ? (info.gif ? "animation" : info.kind)
            : (
              content.locationMessage || content.liveLocationMessage
                ? "location"
                : content.contactMessage || content.contactsArrayMessage
                  ? "contact"
                  : content.reactionMessage
                    ? "reaction"
                    : content.conversation || content.extendedTextMessage
                      ? "text"
                      : "other"
            );

        try {
          const saved = saveWhatsAppMessage({
            telegramId: id,
            sessionId,
            whatsappChatId: remoteJid,
            messageId,
            chatType: isGroup ? "group" : "private",
            chatName: isGroup
              ? groupName
              : (isOutgoing ? who : (message.pushName || who)),
            phoneNumber,
            senderJid,
            senderName: isOutgoing ? "You" : (message.pushName || who),
            direction: isOutgoing ? "outgoing" : "incoming",
            messageType,
            body: body || null,
            mediaMimetype: info?.mimetype || null,
            mediaFileName: info?.fileName || null,
            messageTimestamp,
            // [MODIFIED] Never persist the raw View Once envelope or its media key.
            // Keep only the message metadata and a non-sensitive placeholder for AI context.
            messageContent: message.message && !viewOnceInfo
              ? proto.Message.encode(message.message).finish().toString("base64")
              : null
          });

          // [ADDED] Route a manager's quoted WhatsApp reply to the original customer.
          // A recognized manager reply must not trigger the normal customer auto-reply.
          const managerReplyResult = saved && !isOutgoing && !isGroup && messageType === "text"
            ? await handleIncomingManagerReply({
                telegramId: id,
                sessionId,
                chatId: remoteJid,
                message,
                socket
              }).catch((error) => {
                console.error("[WAGRAM AI Manager Escalation] Reply routing failed:", error.message);
                return { handled: false };
              })
            : null;

          // [ADDED] Incremental AI learning is tenant- and WhatsApp-session-scoped.
          // [MODIFIED] Never learn the AI's own generated replies as human admin examples.
          if (saved && !isAIAutoReplyMessage(id, sessionId, remoteJid, body)) {
            recordAICustomerServiceMessage(id, sessionId, remoteJid);
          }

          // [ADDED] Automatically answer one incoming private text message once.
          // The worker has a durable SQLite idempotency key and ignores groups,
          // outgoing messages, media, and messages superseded by a newer message.
          if (
            saved &&
            !managerReplyResult?.handled &&
            !isOutgoing &&
            !isGroup &&
            ["text", "view_once"].includes(messageType) &&
            String(body || "").trim()
          ) {
            void handleIncomingAIAutoReply({
              telegramId: id,
              sessionId,
              chatId: remoteJid,
              messageId,
              socket,
              quotedMessage: message
            }).catch((error) => {
              console.error("[WAGRAM AI Auto Reply] Worker crashed:", error.message);
            });
          }

          // [ADDED] Notify Mini App only after the SQLite transaction commits.
          if (saved) {
            publishToMiniApp(id, {
              type: "message.created",
              data: {
                sessionId,
                chatId: remoteJid,
                messageId,
                direction: isOutgoing ? "outgoing" : "incoming",
                messageType,
                body: body || null,
                senderName: isOutgoing ? "You" : (message.pushName || who),
                phoneNumber,
                messageTimestamp
              }
            });
          }

          // [ADDED] Download WhatsApp media once and keep it privately on this VPS.
          if (saved && info) {
            try {
              // [ADDED] Keep the message metadata but skip download when the media key is absent.
              if (!hasMediaKey(content)) {
                console.warn(
                  `WhatsApp media skipped for Mini App: missing mediaKey (type=${info.kind}, messageId=${messageId}).`
                );
              } else if (info.size && info.size > MAX_MEDIA_BYTES) {
                console.warn(
                  `WhatsApp media skipped for Mini App: ${info.fileName} exceeds ${MAX_MEDIA_BYTES} bytes.`
                );
              } else {
                const buffer = await downloadMediaMessage(
                  message,
                  "buffer",
                  {},
                  {
                    logger: mediaLogger,
                    reuploadRequest: socket.updateMediaMessage
                  }
                );

                if (
                  Buffer.isBuffer(buffer) &&
                  buffer.length > 0 &&
                  buffer.length <= MAX_MEDIA_BYTES
                ) {
                  // [MODIFIED] Media storage is independent from AI image understanding.
                  // A local storage failure must not prevent the AI from analyzing the downloaded image.
                  try {
                    const storagePath = await saveWhatsAppMedia({
                      telegramId: id,
                      sessionId,
                      messageId,
                      buffer,
                      mimetype: info.mimetype,
                      fileName: info.fileName
                    });

                    const attached = attachLocalMedia({
                      telegramId: id,
                      sessionId,
                      whatsappChatId: remoteJid,
                      messageId,
                      storagePath,
                      mimetype: info.mimetype,
                      fileName: info.fileName
                    });

                    if (attached) {
                      publishToMiniApp(id, {
                        type: "media.ready",
                        data: { sessionId, chatId: remoteJid, messageId }
                      });
                    }
                  } catch (storageError) {
                    console.error("Failed to store WhatsApp media for Mini App:", storageError.message);
                  }

                  // [MODIFIED] Analyze every downloaded incoming private image independently of Mini App storage.
                  if (!isOutgoing && !isGroup && info.kind === "image") {
                    void handleIncomingAIPaymentProof({
                      telegramId: id,
                      sessionId,
                      chatId: remoteJid,
                      messageId,
                      phoneNumber,
                      customerName: name,
                      imageBuffer: buffer,
                      mimetype: info.mimetype || "image/jpeg",
                      socket,
                      quotedMessage: message,
                    }).catch((paymentError) => {
                      console.error("[WAGRAM AI Image] Worker crashed:", paymentError.message);
                    });
                  }
                }
              }
            } catch (mediaError) {
              console.error(
                "Failed to store WhatsApp media for Mini App:",
                mediaError.message
              );
            }
          }
        } catch (error) {
          console.error(
            "Failed to save WhatsApp message to Mini App database:",
            error.message
          );
        }

        // [MODIFIED] WhatsApp messages are stored and synced to the Mini App only.
        // No WhatsApp message content is sent to Telegram.

      } catch (error) {
        console.error(
          "Failed to forward WhatsApp message:",
          error.message
        );
      }
    },

    // [ADDED] Apply an edited WhatsApp message to its original Mini App row.
    onMessageEdited: async ({ key, editedMessage }) => {
      try {
        const remoteJid = String(key?.remoteJid || "");
        const messageId = String(key?.id || "");
        const content = unwrapMessage(editedMessage);

        if (!remoteJid || !messageId || !content) {
          return;
        }

        const mediaInfo = getMediaInfo(content);
        const body = mediaInfo ? mediaInfo.caption : getTextBody(content);

        if (body === null || body === "Unsupported message type") {
          return;
        }

        const changed = updateWhatsAppMessage(id, remoteJid, messageId, body, sessionId);

        if (changed) {
          publishToMiniApp(id, {
            type: "message.edited",
            data: { sessionId, chatId: remoteJid, messageId }
          });
        }
      } catch (error) {
        console.error("Failed to apply WhatsApp message edit:", error.message);
      }
    },

    // [ADDED] Persist revoke status and refresh the Mini App without a Telegram notification.
    onMessageDeleted: async ({ key }) => {
      try {
        const remoteJid = String(key?.remoteJid || "");
        const messageId = String(key?.id || "");

        if (!remoteJid || !messageId) {
          return;
        }

        const changed = markWhatsAppMessageDeleted(id, remoteJid, messageId, sessionId);

        if (changed) {
          publishToMiniApp(id, {
            type: "message.deleted",
            data: { sessionId, chatId: remoteJid, messageId }
          });
        }
      } catch (error) {
        console.error(
          "Failed to mark WhatsApp message as deleted:",
          error.message
        );
      }
    },

    // [ADDED] Forward WhatsApp call events to Telegram.
    onCall: async ({ call, socket }) => {
      try {
        if (!call?.id) {
          return;
        }

        // [ADDED] Keep a history of the call for the Mini App.
        try {
          storeCallEvent({ call, socket, telegramId: id, sessionId });

          // [ADDED] Refresh call history after the database write.
          publishToMiniApp(id, {
            type: "calls.updated",
            data: { sessionId, callId: call.id }
          });
        } catch (error) {
          console.error("Failed to store call history:", error.message);
        }

        // [MODIFIED] Call events are stored for the Mini App only.
        // No WhatsApp call notification is sent to Telegram.

      } catch (error) {
        console.error(
          "Failed to forward WhatsApp call:",
          error.message
        );
      }
    },

    onLoggedOut: async () => {
      try {
        if (isAdditionalSession) {
          updateWhatsAppAccountSession(id, sessionId, "logged_out");
        } else {
          updateSession(id, "logged_out");
        }
      } catch (error) {
        console.error("Failed to update logout state:", error.message);
      }
    },

    onError: async (error) => {
      console.error(
        "WhatsApp connection error:",
        error.message
      );
    }
  };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

// /start — register Telegram user and open WAGRAM.
bot.onText(/^\/start(?:@\w+)?$/, async (msg) => {
  const telegramId = String(msg.from.id);

  try {
    registerUser(msg.from);
    await sendText(
      telegramId,
      "👋 Welcome to WAGRAM\n\n" +
        "Your WhatsApp, connected to Telegram.\n\n" +
        "Manage your WhatsApp connection, conversations, calls, and contacts in one place.\n\n" +
        "Tap below to open your WAGRAM dashboard.",
      openMiniAppOptions()
    );
  } catch (error) {
    console.error("Failed to register Telegram user:", error.message);
    await sendText(telegramId, "Registration failed. Please try again.");
  }
});

// [REMOVED] Legacy Telegram command disabled; use the WAGRAM Mini App.


// [ADDED] Admin access is restricted to configured Telegram IDs.
const ADMIN_TELEGRAM_IDS = new Set(
  String(process.env.ADMIN_TELEGRAM_IDS || "6838814141")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => /^\d+$/.test(id))
);

function isAdmin(telegramId) {
  return ADMIN_TELEGRAM_IDS.has(String(telegramId));
}

function formatMembership(membership) {
  if (!membership) return "Account tidak ditemukan.";
  const expiry = membership.plan_expires_at
    ? new Date(membership.plan_expires_at).toLocaleString("id-ID", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "Asia/Jakarta"
      }) + " WIB"
    : "Tidak ada batas waktu";
  return [
    `Role: ${membership.role}`,
    `Plan: ${membership.plan_label} (${membership.plan})`,
    `Batas akun WhatsApp: ${membership.sessions_limit}`,
    `Berlaku sampai: ${expiry}`
  ].join("\n");
}

// [ADDED] /me — show the caller's role and active plan.
bot.onText(/^\/me(?:@\w+)?$/, async (msg) => {
  const telegramId = String(msg.from.id);
  const user = getUser(telegramId);
  if (!user) {
    await sendText(telegramId, "Kirim /start terlebih dahulu.");
    return;
  }
  await sendText(telegramId, "👤 <b>WAGRAM Account</b>\n\n" +
    formatMembership(getMembership(telegramId)), { parse_mode: "HTML" });
});

// [ADDED] /set <plan> [telegram_id] — admin-only manual membership assignment.
bot.onText(/^\/set(?:@\w+)?(?:\s+(\S+))?(?:\s+(\d+))?$/, async (msg, match) => {
  const callerId = String(msg.from.id);
  if (!isAdmin(callerId)) {
    await sendText(callerId, "⛔ Command ini khusus admin.");
    return;
  }

  const plan = String(match?.[1] || "").toLowerCase();
  const targetId = String(match?.[2] || callerId);

  // [ADDED] /set onboarding — open the onboarding preview for the admin account.
  if (plan === "onboarding") {
    const previewUrl = new URL(MINI_APP_URL);
    previewUrl.searchParams.set("previewOnboarding", "1");
    await sendText(
      callerId,
      "👋 <b>WAGRAM Onboarding Preview</b>\n\nTekan tombol di bawah untuk melihat kembali halaman Welcome dan pengenalan fitur. Status onboarding akun tidak direset.",
      {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [[
            { text: "Preview Onboarding", web_app: { url: previewUrl.toString() } }
          ]]
        }
      }
    );
    return;
  }

  // [MODIFIED] time-pause now simulates 08:00 WITA and immediately pauses all connected Free sessions.
  if (plan === "time-pause" || plan === "time-normal") {
    const pauseEnabled = plan === "time-pause";
    setAppSetting("free_daily_pause_enabled", pauseEnabled ? "1" : "0");

    if (pauseEnabled) {
      const witaParts = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Makassar",
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
      }).formatToParts(new Date());
      const witaValues = Object.fromEntries(witaParts.map((part) => [part.type, part.value]));
      const witaDate = `${witaValues.year}-${witaValues.month}-${witaValues.day}`;
      let pausedCount = 0;
      let failedCount = 0;

      for (const session of getAllSessions()) {
        if (session.connection_status !== "connected") continue;
        const membership = getMembership(session.telegram_id);
        if (!membership || membership.plan !== "free") continue;

        try {
          await disconnectWhatsApp(session.telegram_id);
          updateSession(session.telegram_id, "paused");
          setFreePauseDate(session.telegram_id, witaDate);
          publishToMiniApp(session.telegram_id, {
            type: "connection.status",
            data: { status: "paused", phoneNumber: session.phone_number || null }
          });
          pausedCount += 1;
        } catch (error) {
          failedCount += 1;
          logger.error({ err: error, telegramId: session.telegram_id }, "Manual Free pause failed.");
        }
      }

      await sendText(
        callerId,
        `⏸️ <b>Time Pause aktif</b>\n\nSimulasi pukul <b>08.00 WITA</b> berhasil dijalankan.\n\nAkun Free dipause: <b>${pausedCount}</b>\nGagal dipause: <b>${failedCount}</b>\n\nSemua sesi Free yang aktif diputus sekarang. Pesan baru tidak akan diteruskan ke Telegram. Akun Premium tidak terpengaruh.\n\nGunakan /set time-normal untuk menonaktifkan jadwal pause otomatis.`,
        { parse_mode: "HTML" }
      );
    } else {
      await sendText(
        callerId,
        "▶️ <b>Time Normal aktif</b>\n\nJadwal pause otomatis dinonaktifkan. Koneksi yang sudah ter-pause tidak otomatis tersambung kembali; user perlu menekan Connect di WAGRAM.",
        { parse_mode: "HTML" }
      );
    }
    return;
  }

  if (!Object.prototype.hasOwnProperty.call(MEMBERSHIP_PLANS, plan)) {
    await sendText(callerId,
      "Format: /set <code> [telegram_id]\n\n" +
      "onboarding — preview halaman awal WAGRAM (admin)\n" +
      "free — Free\n" +
      "premium-a — 3 hari (Rp14.000)\n" +
      "premium-b — 7 hari (Rp44.000)\n" +
      "premium-c — 30 hari (Rp149.000)");
    return;
  }

  const membership = setMembership(targetId, plan);
  if (!membership) {
    await sendText(callerId, `User ${targetId} belum terdaftar. Minta user mengirim /start dulu.`);
    return;
  }

  // [ADDED] Push membership changes to an open Mini App so Premium locks update immediately.
  publishToMiniApp(targetId, {
    type: "membership.updated",
    data: {
      plan: membership.plan,
      role: membership.role,
      plan_expires_at: membership.plan_expires_at
    }
  });

  await sendText(callerId,
    `✅ Membership diperbarui untuk ${targetId}\n\n${formatMembership(membership)}`);
  if (targetId !== callerId) {
    try {
      await sendText(targetId,
        `🎉 Plan WAGRAM kamu diperbarui menjadi ${membership.plan_label}.\n\n${formatMembership(membership)}`);
    } catch (error) {
      console.warn("Could not notify membership target:", error.message);
    }
  }
});

// [ADDED] /users — admin-only user and membership overview.
bot.onText(/^\/users(?:@\w+)?$/, async (msg) => {
  const callerId = String(msg.from.id);
  if (!isAdmin(callerId)) {
    await sendText(callerId, "⛔ Command ini khusus admin.");
    return;
  }
  const users = listMembershipUsers();
  const lines = users.slice(0, 40).map((user) =>
    `• ${user.first_name || user.username || user.telegram_id} — ${user.membership?.plan || "free"} — ${user.telegram_id}`
  );
  await sendText(callerId,
    `👥 <b>WAGRAM Users</b> (${users.length})\n\n${lines.join("\n") || "Belum ada user."}`,
    { parse_mode: "HTML" });
});

// [ADDED] /user <telegram_id> — admin-only membership lookup.
bot.onText(/^\/user(?:@\w+)?\s+(\d+)$/, async (msg, match) => {
  const callerId = String(msg.from.id);
  if (!isAdmin(callerId)) {
    await sendText(callerId, "⛔ Command ini khusus admin.");
    return;
  }
  const targetId = match[1];
  const user = getUser(targetId);
  if (!user) {
    await sendText(callerId, `User ${targetId} belum terdaftar.`);
    return;
  }
  await sendText(callerId,
    `👤 <b>User ${targetId}</b>\n\n${formatMembership(getMembership(targetId))}`,
    { parse_mode: "HTML" });
});

// /status — show the live WhatsApp connection status.
bot.onText(/^\/status(?:@\w+)?$/, async (msg) => {
  const telegramId = String(msg.from.id);
  if (!isAuthorizedUser(telegramId)) {
    await sendText(telegramId, "Send /start first.");
    return;
  }
  const session = getSession(telegramId);
  const runtime = getWhatsAppStatus(telegramId);
  const status = runtime.status || session?.connection_status || "disconnected";
  const phone = runtime.phoneNumber || session?.phone_number;
  const lastConnected = session?.last_connected_at
    ? formatTimestamp(Math.floor(session.last_connected_at / 1000))
    : "never";
  const connected = status === "connected";
  const statusLabel = connected ? "🟢 CONNECTED" :
    status === "logged_out" ? "🔴 LOGGED OUT" :
    status === "replaced" ? "🟠 SESSION REPLACED" :
    status === "connecting" || status === "qr" ? "🟡 CONNECTING" :
    "🔴 DISCONNECTED";
  const message = [
    "<b>WAGRAM Status</b>",
    "",
    statusLabel,
    connected
      ? "Your WhatsApp connection is active."
      : status === "connecting" || status === "qr"
        ? "WAGRAM is preparing your WhatsApp connection."
        : "Your WhatsApp is not connected. Open WAGRAM to reconnect.",
    "",
    "<b>WhatsApp:</b> " + (phone ? "+" + esc(phone) : "Not available"),
    "<b>Last connected:</b> " + esc(lastConnected)
  ].join("\n");
  await sendHtml(telegramId, message, connected ? {} : openMiniAppOptions());
});

// [REMOVED] Legacy Telegram command disabled; use the WAGRAM Mini App.


// ---------------------------------------------------------------------------
// [ADDED] Contacts
// ---------------------------------------------------------------------------

const CONTACT_LIST_LIMIT = 40;

// Parse "/save <name> <number>" where the number is the first or last word.
function parseSaveArguments(text) {
  const tokens = String(text || "").trim().split(/\s+/).filter(Boolean);

  if (tokens.length < 2) {
    return null;
  }

  const looksLikePhone = (token) => /^\+?[\d().-]{6,}$/.test(token);

  if (looksLikePhone(tokens[tokens.length - 1])) {
    const phone = tokens.pop();

    return { name: tokens.join(" "), phone };
  }

  if (looksLikePhone(tokens[0])) {
    const phone = tokens.shift();

    return { name: tokens.join(" "), phone };
  }

  return null;
}

function contactErrorText(error) {
  if (error instanceof ValidationError) {
    switch (error.code) {
      case "INVALID_NAME":
        return "Please include a name, e.g. /save Budi 081234567890";

      case "INVALID_PHONE":
        return (
          "That phone number doesn't look valid.\n" +
          "Example: /save Budi 081234567890 or /save Budi +6281234567890"
        );

      case "CONTACT_LIMIT":
        return "You reached the contact limit. Delete some contacts first.";

      default:
        return error.message;
    }
  }

  console.error("Contact command failed:", error.message);

  return "Could not save the contact. Please try again.";
}

function contactLine(contact) {
  return `${contact.name} — +${contact.phone_number}`;
}

// [REMOVED] Legacy Telegram command disabled; use the WAGRAM Mini App.


// Sharing a Telegram contact card with the bot also saves it.
bot.on("contact", async (msg) => {
  if (msg.chat?.type !== "private" || !msg.from || !msg.contact) {
    return;
  }

  const telegramId = String(msg.from.id);
  const shared = msg.contact;

  if (!isAuthorizedUser(telegramId)) {
    await sendText(telegramId, "Send /start first.");
    return;
  }

  const name =
    [shared.first_name, shared.last_name].filter(Boolean).join(" ") ||
    String(shared.phone_number || "");

  try {
    const { created, contact } = saveContact(telegramId, {
      name,
      phone: shared.phone_number
    });

    await sendText(
      telegramId,
      `${created ? "✅ Contact saved" : "✅ Contact updated"}\n` +
        contactLine(contact)
    );
  } catch (error) {
    await sendText(telegramId, contactErrorText(error));
  }
});

// [REMOVED] Legacy Telegram command disabled; use the WAGRAM Mini App.


// [REMOVED] Legacy Telegram command disabled; use the WAGRAM Mini App.


// /help — concise WAGRAM usage guide.
bot.onText(/^\/help(?:@\w+)?$/, async (msg) => {
  await sendText(
    String(msg.from.id),
    "📖 WAGRAM Help\n\n" +
      "Your WhatsApp, connected to Telegram.\n\n" +
      "<b>Available Commands</b>\n" +
      "/start — start WAGRAM and open your dashboard\n" +
      "/status — check your WhatsApp connection\n" +
      "/me — show your role and membership\n" +
      "/help — show this guide\n\n" +
      "<b>What you can do</b>\n" +
      "• Manage your WhatsApp connection\n" +
      "• View conversations and contacts\n" +
      "• Access calls and media\n" +
      "• Manage WhatsApp from Telegram",
    { parse_mode: "HTML", ...openMiniAppOptions() }
  );
});

// [ADDED] Keep Telegram's command menu focused on the three primary commands.
bot.setMyCommands([
  { command: "start", description: "Start WAGRAM and open the dashboard" },
  { command: "status", description: "Check WhatsApp connection status" },
  { command: "me", description: "Show your role and membership" },
  { command: "set", description: "Admin: change a user's membership" },
  { command: "users", description: "Admin: list registered users" },
  { command: "help", description: "Show WAGRAM help" }
]).catch((error) => {
  console.error("Failed to register Telegram commands:", error.message);
});

// [ADDED] Admin-only inline actions for Premium payment verification.
bot.on("callback_query", async (query) => {
  const callerId = String(query.from?.id || "");
  const data = String(query.data || "");
  const match = data.match(/^premium:(approve|reject):(premium_\d+_[a-z0-9]+)$/i);

  if (!match) return;

  if (!isAdmin(callerId)) {
    await bot.answerCallbackQuery(query.id, {
      text: "Aksi ini khusus admin.",
      show_alert: true
    });
    return;
  }

  const decision = match[1] === "approve" ? "approved" : "rejected";
  const orderId = match[2];
  const order = getPremiumPaymentOrderById(orderId);

  if (!order || order.status !== "pending" || !order.payment_reported_at) {
    await bot.answerCallbackQuery(query.id, {
      text: "Order sudah diproses atau tidak ditemukan.",
      show_alert: true
    });
    return;
  }

  const reviewedOrder = reviewPremiumPaymentOrder(orderId, decision);
  if (!reviewedOrder) {
    await bot.answerCallbackQuery(query.id, {
      text: "Order sudah diproses oleh admin lain.",
      show_alert: true
    });
    return;
  }

  if (decision === "approved") {
    const planByPeriod = {
      "3d": "premium-a",
      "7d": "premium-b",
      "30d": "premium-c"
    };
    const plan = planByPeriod[reviewedOrder.plan_period];
    const membership = setMembership(reviewedOrder.telegram_id, plan);

    if (membership) {
      publishToMiniApp(reviewedOrder.telegram_id, {
        type: "membership.updated",
        data: {
          plan: membership.plan,
          role: membership.role,
          plan_expires_at: membership.plan_expires_at
        }
      });
      try {
        await sendText(
          reviewedOrder.telegram_id,
          "🎉 <b>Pembayaran Premium berhasil diverifikasi!</b>\n\n" +
            "Paket: <b>" + esc(membership.plan_label) + "</b>\n" +
            "Order: <code>" + esc(orderId) + "</code>\n\n" +
            "Premium kamu sekarang sudah aktif. Selamat menikmati WAGRAM!",
          { parse_mode: "HTML", disable_web_page_preview: true }
        );
      } catch (error) {
        console.warn("Could not notify Premium customer:", error.message);
      }
    }
  } else {
    try {
      await sendText(
        reviewedOrder.telegram_id,
        "❌ <b>Pembayaran Premium belum dapat disetujui.</b>\n\n" +
          "Order: <code>" + esc(orderId) + "</code>\n" +
          "Silakan hubungi admin WAGRAM jika merasa terjadi kesalahan.",
        { parse_mode: "HTML", disable_web_page_preview: true }
      );
    } catch (error) {
      console.warn("Could not notify rejected Premium customer:", error.message);
    }
  }

  const resultText = decision === "approved"
    ? "Pembayaran disetujui. Premium user telah diaktifkan."
    : "Pembayaran ditolak.";
  await bot.answerCallbackQuery(query.id, { text: resultText });

  if (query.message) {
    const originalCaption = String(query.message.caption || "");
    const statusLine = decision === "approved"
      ? "\n\n✅ <b>DISETUJUI</b> oleh admin"
      : "\n\n❌ <b>DITOLAK</b> oleh admin";
    await bot.editMessageCaption(originalCaption + statusLine, {
      chat_id: query.message.chat.id,
      message_id: query.message.message_id,
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: [] }
    }).catch(async () => {
      await bot.editMessageReplyMarkup(
        { inline_keyboard: [] },
        { chat_id: query.message.chat.id, message_id: query.message.message_id }
      ).catch(() => {});
    });
  }
});

// Handle unexpected polling errors.
bot.on("polling_error", (error) => {
  console.error("Telegram polling error:", error.message);
});

// Handle Telegram API errors.
bot.on("error", (error) => {
  console.error("Telegram bot error:", error.message);
});

console.log("Telegram bot module initialized.");