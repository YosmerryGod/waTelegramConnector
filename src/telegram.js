import "dotenv/config";
import pino from "pino";
import TelegramBot from "node-telegram-bot-api";
import QRCode from "qrcode";
import { downloadMediaMessage } from "@whiskeysockets/baileys";

import {
  registerUser,
  getUser,
  getSession,
  updateSession,
  markSessionDisconnected,
  reserveForwardedMessage,
  saveWhatsAppMessage, // [ADDED] Persist messages for the Mini App.
  // [ADDED] Contacts and call history.
  ValidationError,
  saveContact,
  listContacts,
  deleteContactByPhone,
  recordCall,
  findContactName,
  attachTelegramFile
} from "./database.js";

import {
  connectWhatsApp,
  disconnectWhatsApp,
  getWhatsAppStatus
} from "./whatsapp.js";

// Telegram bot configuration.
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

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
function storeCallEvent({ call, socket, telegramId }) {
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
  const callName = findContactName(telegramId, phoneNumber);

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
export function createWhatsAppCallbacks(telegramId) {
  const id = String(telegramId);

  return {
    onQr: async (qr) => {
      const now = Date.now();
      const lastSent = lastQrSentAt.get(id) || 0;

      if (now - lastSent < QR_COOLDOWN_MS) {
        return;
      }

      lastQrSentAt.set(id, now);

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
        updateSession(
          id,
          status === "replaced" ? "disconnected" : status,
          phoneNumber || null
        );
      } catch (error) {
        console.error("Failed to update session:", error.message);
      }

      const notify = async (text) => {
        try {
          await sendText(id, text);
        } catch (error) {
          console.error("Failed to send status:", error.message);
        }
      };

      // Manual /disconnect or shutdown: no timers, no reconnect notices.
      if (status === "disconnected" && info.intentional) {
        clearDisconnectTimer(id);
        reconnecting.delete(id);
        notifiedDown.delete(id);
        return;
      }

      // Transient drop: reconnect silently, warn only if it lasts.
      if (status === "disconnected") {
        reconnecting.add(id);

        if (!disconnectTimers.has(id)) {
          const timer = setTimeout(async () => {
            disconnectTimers.delete(id);

            if (!reconnecting.has(id)) {
              return;
            }

            notifiedDown.add(id);

            await notify(
              "⚠️ WhatsApp disconnected. Reconnecting automatically."
            );
          }, DISCONNECT_NOTICE_DELAY_MS);

          timer.unref?.();
          disconnectTimers.set(id, timer);
        }

        return;
      }

      // Reconnect attempts are silent.
      if (status === "connecting" && reconnecting.has(id)) {
        return;
      }

      if (status === "connected") {
        const wasNotified = notifiedDown.has(id);
        const wasReconnecting = reconnecting.has(id);
        const wasPairing = pairing.has(id);

        pairing.delete(id);

        clearDisconnectTimer(id);
        reconnecting.delete(id);
        notifiedDown.delete(id);

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
        pairing.add(id);
      }

      if (["qr", "logged_out", "replaced"].includes(status)) {
        clearDisconnectTimer(id);
        reconnecting.delete(id);
        notifiedDown.delete(id);
      }

      const messages = {
        connecting: "⏳ Connecting to WhatsApp...",
        qr: "📷 QR code is ready to scan.",
        logged_out: "🚪 WhatsApp logged out. Use /connect to link again.",
        replaced:
          "⚠️ This WhatsApp session was taken over by another login or another running bot instance. " +
          "Make sure only one instance is running, then use /connect."
      };

      const message = messages[status];

      if (message) {
        await notify(message);
      }
    },

    onMessage: async ({ message, socket }) => {
      try {
        const key = message?.key || {};
        const messageId = key.id;

        if (!messageId) {
          return;
        }

        const content = unwrapMessage(message.message);

        if (!content) {
          return;
        }

        const info = getMediaInfo(content);
        const body = info ? info.caption : getTextBody(content);

        // Skip noise such as protocol events and removed reactions.
        if (body === null) {
          return;
        }

        // Prevent duplicate forwards.
        const reserved = reserveForwardedMessage(messageId, id);

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
          phoneNumber || (isGroup ? null : jidToPhone(remoteJid))
        );
        const name = savedName || message.pushName || who;

        const groupName = isGroup
          ? await getGroupName(socket, id, remoteJid)
          : null;

        // [ADDED] Persist the message for the Mini App. This only writes to
        // our local database; it does not mark the WhatsApp message as read.
        const rawTimestamp = toNumber(message.messageTimestamp);
        const messageTimestamp = rawTimestamp > 0
          ? rawTimestamp * 1000
          : Date.now();

        const messageType = info
          ? info.kind
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
          saveWhatsAppMessage({
            telegramId: id,
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
            messageTimestamp
          });
        } catch (error) {
          console.error(
            "Failed to save WhatsApp message to Mini App database:",
            error.message
          );
        }

        const header = buildHeader({
          isOutgoing,
          isGroup,
          name,
          savedName,
          groupName,
          who,
          time: formatShortTime(message.messageTimestamp)
        });

        // Media: forward the actual file.
        if (info) {
          const sentMedia = await forwardMedia({
            chatId: id,
            socket,
            message,
            info,
            header,
            text: body
          });

          // [ADDED] Let the Mini App show this media.
          try {
            const file = extractTelegramFile(sentMedia);

            if (file) {
              attachTelegramFile({
                telegramId: id,
                whatsappChatId: remoteJid,
                messageId,
                fileId: file.fileId,
                kind: file.kind
              });
            }
          } catch (error) {
            console.error("Failed to store media for Mini App:", error.message);
          }

          return;
        }

        // Text: header and body in one message, long text split cleanly.
        const headerReserve = header.length + 2;
        const chunks = splitEscaped(
          body,
          Math.max(500, MESSAGE_LIMIT - headerReserve)
        ).slice(0, MAX_TEXT_CHUNKS);

        const first = await sendHtml(id, `${header}\n\n${chunks[0]}`);

        await sendFollowUps(id, chunks.slice(1), first.message_id);
      } catch (error) {
        console.error(
          "Failed to forward WhatsApp message:",
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
          storeCallEvent({ call, socket, telegramId: id });
        } catch (error) {
          console.error("Failed to store call history:", error.message);
        }

        const text = await buildCallMessage({
          call,
          socket,
          telegramId: id
        });

        if (!text) {
          return;
        }

        // Baileys can emit the same call event more than once.
        const phase = call.status === "timeout" ? "missed" : "incoming";

        const reserved = reserveForwardedMessage(
          `call:${call.id}:${phase}`,
          id
        );

        if (!reserved) {
          return;
        }

        await sendHtml(id, text);
      } catch (error) {
        console.error(
          "Failed to forward WhatsApp call:",
          error.message
        );
      }
    },

    onLoggedOut: async () => {
      try {
        updateSession(id, "logged_out");
      } catch (error) {
        console.error("Failed to update logout state:", error.message);
      }
    },

    onError: async (error) => {
      console.error(
        `WhatsApp connection error for Telegram user ${id}:`,
        error.message
      );
    }
  };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

// /start — register Telegram user.
bot.onText(/^\/start(?:@\w+)?$/, async (msg) => {
  const telegramId = String(msg.from.id);

  try {
    registerUser(msg.from);

    await sendText(
      telegramId,
      "👋 WhatsApp Bridge\n\n" +
        "Forwards your WhatsApp messages, photos, videos, stickers, " +
        "voice notes, files and call alerts to this chat.\n\n" +
        "/connect — link WhatsApp\n" +
        "/status — connection status\n" +
        "/disconnect — unlink and delete session\n" +
        "/save Name Number — save a phone number\n" +
        "/contacts — list saved contacts\n" +
        "/help — usage notes"
    );
  } catch (error) {
    console.error("Failed to register Telegram user:", error.message);

    await sendText(telegramId, "Registration failed. Please try again.");
  }
});

// /connect — start WhatsApp pairing.
bot.onText(/^\/connect(?:@\w+)?$/, async (msg) => {
  const telegramId = String(msg.from.id);

  if (!isAuthorizedUser(telegramId)) {
    await sendText(telegramId, "Send /start first.");
    return;
  }

  const status = getWhatsAppStatus(telegramId);

  if (status.status === "connected") {
    await sendText(telegramId, "✅ Already connected. See /status.");
    return;
  }

  if (["connecting", "qr"].includes(status.status)) {
    await sendText(telegramId, "⏳ Connection in progress. Wait for the QR.");
    return;
  }

  try {
    await connectWhatsApp(
      telegramId,
      createWhatsAppCallbacks(telegramId)
    );
  } catch (error) {
    console.error("Failed to start WhatsApp connection:", error.message);

    await sendText(
      telegramId,
      "❌ Could not start the connection. Check the server log and try /connect again."
    );
  }
});

// /status — show WhatsApp connection status.
bot.onText(/^\/status(?:@\w+)?$/, async (msg) => {
  const telegramId = String(msg.from.id);

  if (!isAuthorizedUser(telegramId)) {
    await sendText(telegramId, "Send /start first.");
    return;
  }

  const session = getSession(telegramId);
  const runtime = getWhatsAppStatus(telegramId);

  const status =
    runtime.status || session?.connection_status || "disconnected";

  const phone = runtime.phoneNumber || session?.phone_number;

  const lastConnected = session?.last_connected_at
    ? formatTimestamp(Math.floor(session.last_connected_at / 1000))
    : "never";

  await sendText(
    telegramId,
    [
      "📊 WhatsApp status",
      `Status: ${status}`,
      `Number: ${phone ? `+${phone}` : "not available"}`,
      `Last connected: ${lastConnected}`
    ].join("\n")
  );
});

// /disconnect — logout and remove this user's saved credentials.
bot.onText(/^\/disconnect(?:@\w+)?$/, async (msg) => {
  const telegramId = String(msg.from.id);

  if (!isAuthorizedUser(telegramId)) {
    await sendText(telegramId, "Send /start first.");
    return;
  }

  try {
    await disconnectWhatsApp(telegramId, {
      logout: true,
      clearAuth: true
    });

    markSessionDisconnected(telegramId);

    await sendText(
      telegramId,
      "🔌 Disconnected and local session deleted.\nUse /connect to link again."
    );
  } catch (error) {
    console.error("Failed to disconnect WhatsApp:", error.message);

    await sendText(
      telegramId,
      "Could not disconnect. Check the server log."
    );
  }
});

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

// /save <name> <number> — save a phone number to the Mini App contacts.
bot.onText(/^\/save(?:@\w+)?(?:\s+([\s\S]+))?$/, async (msg, match) => {
  const telegramId = String(msg.from.id);

  if (!isAuthorizedUser(telegramId)) {
    await sendText(telegramId, "Send /start first.");
    return;
  }

  const parsed = parseSaveArguments(match[1]);

  if (!parsed) {
    await sendText(
      telegramId,
      "Usage: /save Name Number\n" +
        "Example: /save Budi 081234567890\n\n" +
        "You can also share a contact card with this bot."
    );
    return;
  }

  try {
    const { created, contact } = saveContact(telegramId, parsed);

    await sendText(
      telegramId,
      `${created ? "✅ Contact saved" : "✅ Contact updated"}\n` +
        contactLine(contact)
    );
  } catch (error) {
    await sendText(telegramId, contactErrorText(error));
  }
});

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

// /contacts — list saved contacts.
bot.onText(/^\/contacts(?:@\w+)?$/, async (msg) => {
  const telegramId = String(msg.from.id);

  if (!isAuthorizedUser(telegramId)) {
    await sendText(telegramId, "Send /start first.");
    return;
  }

  try {
    const contacts = listContacts(telegramId);

    if (contacts.length === 0) {
      await sendText(
        telegramId,
        "No saved contacts yet.\nUse /save Name Number to add one."
      );
      return;
    }

    const lines = contacts
      .slice(0, CONTACT_LIST_LIMIT)
      .map((contact, index) => `${index + 1}. ${contactLine(contact)}`);

    if (contacts.length > CONTACT_LIST_LIMIT) {
      lines.push(
        `…and ${contacts.length - CONTACT_LIST_LIMIT} more. ` +
          "Open the Mini App to see all."
      );
    }

    await sendText(
      telegramId,
      `📒 Contacts (${contacts.length})\n\n${lines.join("\n")}`
    );
  } catch (error) {
    console.error("Failed to list contacts:", error.message);

    await sendText(telegramId, "Could not load contacts.");
  }
});

// /delcontact <number> — delete a saved contact by phone number.
bot.onText(/^\/delcontact(?:@\w+)?(?:\s+(\S+))?$/, async (msg, match) => {
  const telegramId = String(msg.from.id);

  if (!isAuthorizedUser(telegramId)) {
    await sendText(telegramId, "Send /start first.");
    return;
  }

  if (!match[1]) {
    await sendText(
      telegramId,
      "Usage: /delcontact Number\nExample: /delcontact 081234567890"
    );
    return;
  }

  try {
    const removed = deleteContactByPhone(telegramId, match[1]);

    await sendText(
      telegramId,
      removed ? "🗑 Contact deleted." : "No contact found with that number."
    );
  } catch (error) {
    console.error("Failed to delete contact:", error.message);

    await sendText(telegramId, "Could not delete the contact.");
  }
});

// /help — usage instructions.
bot.onText(/^\/help(?:@\w+)?$/, async (msg) => {
  await sendText(
    String(msg.from.id),
    "📖 WhatsApp Bridge\n\n" +
      "/start — register\n" +
      "/connect — link WhatsApp via QR\n" +
      "/status — connection status\n" +
      "/disconnect — unlink and delete session\n" +
      "/save Name Number — save a phone number (or share a contact card)\n" +
      "/contacts — list saved contacts\n" +
      "/delcontact Number — delete a saved contact\n\n" +
      "Forwarded: text, emoji, photos, videos, GIFs, stickers, voice notes, " +
      "audio, documents, locations, contacts and polls — incoming and outgoing.\n" +
      "Calls: incoming and missed voice/video call alerts.\n\n" +
      `Files above ${Math.floor(MAX_MEDIA_BYTES / 1024 / 1024)} MB are skipped (Telegram bot limit).\n` +
      "A phone number is shown only when WhatsApp provides it; otherwise the sender ID is shown."
  );
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