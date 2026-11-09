// src/miniapp-api.js
// [ADDED] REST API for WhatsApp Mini App.
// Mini App read status is local only and never sends WhatsApp read receipts.

import express from "express";
import crypto from "node:crypto";
import { Readable } from "node:stream";
import fs from "node:fs";
import path from "node:path";
import { MEDIA_ROOT } from "./media-storage.js";

import { bot, createWhatsAppCallbacks } from "./telegram.js";
import QRCode from "qrcode";
import { connectWhatsApp, disconnectWhatsApp, getWhatsAppQr, getWhatsAppStatus, getWhatsAppAccountProfile, getWhatsAppProfile, getWhatsAppPhoneNumber } from "./whatsapp.js";

import {
  getUser,
  getMembership,
  getSession,
  setFreePauseDate,
  listChats,
  getChat,
  listMessages,
  markChatReadInMiniApp,
  setChatFavorite,
  setChatArchived,
  // [ADDED] Contacts and call history.
  ValidationError,
  saveContact,
  updateContact,
  deleteContact,
  listContacts,
  listCalls,
  setCallFavorite,
  setCallArchived,
  getMessageMedia,
  // [ADDED] Profile data cleanup.
  cleanupUserData,
  // [ADDED] WhatsApp profile cache and participant ownership checks.
  getWhatsAppProfileCache,
  saveWhatsAppProfileCache,
  getWhatsAppParticipantName,
  hasWhatsAppParticipant,
  createPremiumPaymentOrder, // [ADDED] Server-side Premium payment order allocation.
  getPremiumPaymentOrder, // [ADDED] Read an order owned by the authenticated user.
  markPremiumPaymentReported // [ADDED] Record a user's payment confirmation.
} from "./database.js";

const router = express.Router();

// [ADDED] Public shape of a message: hide Telegram file ids.
function toPublicMessage(message, membership) {
  const {
    telegram_file_id: fileId,
    telegram_file_kind: telegramKind,
    media_storage_path: storagePath,
    body,
    original_body: originalBody,
    ...rest
  } = message;

  const kind = telegramKind || (
    rest.message_type === "image" ? "photo" : rest.message_type
  );
  const hasMedia = Boolean(fileId || storagePath);
  // [ADDED] Location messages contain sensitive coordinates even without a file attachment.
  const isLocation = kind === "location" || rest.message_type === "location";
  const hasProtectedContent = hasMedia || isLocation;
  const isPremium = Boolean(membership?.plan && membership.plan !== "free");
  // [MODIFIED] Free membership locks all media and location messages, including outgoing content.
  const mediaLocked = hasProtectedContent && !isPremium;

  return {
    ...rest,
    body: mediaLocked ? "" : body,
    original_body: mediaLocked ? null : originalBody,
    has_media: hasMedia && !mediaLocked,
    media_locked: mediaLocked,
    media_kind: hasProtectedContent ? kind || "location" : null
  };
}

const MAX_LIMIT = 100;
const MAX_MESSAGES = 200;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

// ---------------------------------------------------------------------------
// Telegram Mini App authentication
// ---------------------------------------------------------------------------

// [ADDED] Verify Telegram Web App initData on the server.
// Do not trust initDataUnsafe.user.id from the frontend.
export function verifyTelegramInitData(initData) {
  if (!TELEGRAM_BOT_TOKEN || typeof initData !== "string" || !initData) {
    return null;
  }

  try {
    const params = new URLSearchParams(initData);
    const receivedHash = params.get("hash");

    if (!receivedHash) {
      return null;
    }

    params.delete("hash");

    // Telegram requires the remaining key/value pairs sorted alphabetically.
    const dataCheckString = [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}=${value}`)
      .join("\n");

    const secretKey = crypto
      .createHmac("sha256", "WebAppData")
      .update(TELEGRAM_BOT_TOKEN)
      .digest();

    const calculatedHash = crypto
      .createHmac("sha256", secretKey)
      .update(dataCheckString)
      .digest();

    const receivedBuffer = Buffer.from(receivedHash, "hex");

    if (
      receivedBuffer.length !== calculatedHash.length ||
      !crypto.timingSafeEqual(receivedBuffer, calculatedHash)
    ) {
      return null;
    }

    // Reject expired authentication data.
    const authDate = Number(params.get("auth_date"));
    const nowSeconds = Math.floor(Date.now() / 1000);
    const maxAgeSeconds = Math.max(
      60,
      Number(process.env.MINIAPP_AUTH_MAX_AGE_SECONDS || 86400)
    );

    if (
      !Number.isFinite(authDate) ||
      authDate <= 0 ||
      authDate > nowSeconds + 60 ||
      nowSeconds - authDate > maxAgeSeconds
    ) {
      return null;
    }

    const userString = params.get("user");

    if (!userString) {
      return null;
    }

    const user = JSON.parse(userString);

    if (!user?.id || !/^\d+$/.test(String(user.id))) {
      return null;
    }

    return {
      id: String(user.id),
      user
    };
  } catch {
    return null;
  }
}

// [ADDED] Require valid Telegram initData and an active registered user.
function requireMiniAppAuth(req, res, next) {
  const initData = req.get("X-Telegram-Init-Data");

  const authenticated = verifyTelegramInitData(initData);

  if (!authenticated) {
    return res.status(401).json({
      ok: false,
      error: "INVALID_TELEGRAM_AUTH",
      message: "Telegram Mini App authentication failed."
    });
  }

  const registeredUser = getUser(authenticated.id);

  if (!registeredUser || registeredUser.is_active !== 1) {
    return res.status(403).json({
      ok: false,
      error: "USER_NOT_REGISTERED",
      message: "Send /start to the Telegram bot first."
    });
  }

  // The user ID always comes from verified Telegram initData.
  req.miniAppUser = authenticated.user;
  req.telegramId = authenticated.id;

  next();
}

// ---------------------------------------------------------------------------
// Input helpers
// ---------------------------------------------------------------------------

function parseLimit(value, fallback, maximum) {
  const parsed = Number.parseInt(value, 10);

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.max(1, Math.min(maximum, parsed));
}

function parseBoolean(value) {
  if (value === true || value === 1 || value === "1" || value === "true") {
    return true;
  }

  if (
    value === false ||
    value === 0 ||
    value === "0" ||
    value === "false"
  ) {
    return false;
  }

  return null;
}

function getChatId(req) {
  const chatId = req.params.chatId;

  if (
    typeof chatId !== "string" ||
    !chatId.trim() ||
    chatId.length > 256
  ) {
    return null;
  }

  return chatId;
}

function sendServerError(res, error, message) {
  console.error(`[Mini App API] ${message}:`, error);

  return res.status(500).json({
    ok: false,
    error: "INTERNAL_SERVER_ERROR",
    message: "An internal server error occurred."
  });
}

// ---------------------------------------------------------------------------
// Health endpoint
// ---------------------------------------------------------------------------

// [ADDED] Health check; intentionally does not expose private user data.
router.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "miniapp-api"
  });
});

// All routes below require authenticated Telegram Mini App data.
router.use(requireMiniAppAuth);

// [ADDED] Create a pending Premium order and return its dynamic QRIS payload.
router.post("/premium/orders", async (req, res) => {
  try {
    const prices = { "3d": 14000, "7d": 44000, "30d": 149000 };
    const period = String(req.body?.period || "");
    const baseAmount = prices[period];

    if (!baseAmount) {
      return res.status(400).json({
        ok: false,
        error: "INVALID_PREMIUM_PLAN",
        message: "Paket Premium tidak valid."
      });
    }

    const order = createPremiumPaymentOrder(req.telegramId, period, baseAmount);
    const basePayload = "00020101021226570011ID.DANA.WWW011893600915003678691602090367869160303UMI51440014ID.CO.QRIS.WWW0215ID10266342920190303UMI5204899953033605405100005802ID5915WaGRAM, Service6011Banjarmasin610570111621960150011ID.DANA.WWW63043E14";

    // [MODIFIED] Keep the registered/original QRIS merchant name unchanged.
    // Personalizing tag 59 with a Telegram username can make the QRIS payload invalid.
    const merchantName = "WaGRAM, Service";
    const merchantField = "59" + String(merchantName.length).padStart(2, "0") + merchantName;

    const amountText = String(order.amount);
    const amountField = "54" + String(amountText.length).padStart(2, "0") + amountText;
    const payloadWithoutCrc = basePayload
      .replace("540510000", amountField)
      .replace("5915WaGRAM, Service", merchantField)
      .slice(0, -8) + "6304";

    let crc = 0xFFFF;
    for (let index = 0; index < payloadWithoutCrc.length; index += 1) {
      crc ^= payloadWithoutCrc.charCodeAt(index) << 8;
      for (let bit = 0; bit < 8; bit += 1) {
        crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) : (crc << 1);
        crc &= 0xFFFF;
      }
    }

    const rawQris = payloadWithoutCrc + crc.toString(16).toUpperCase().padStart(4, "0");
    const qrDataUrl = await QRCode.toDataURL(rawQris, {
      width: 560,
      margin: 2,
      errorCorrectionLevel: "H",
      color: { dark: "#101820", light: "#FFFFFF" }
    });
    res.setHeader("Cache-Control", "no-store");
    return res.status(201).json({
      ok: true,
      order: {
        id: order.id,
        period: order.planPeriod,
        baseAmount: order.baseAmount,
        uniqueCode: order.uniqueCode,
        amount: order.amount,
        expiresAt: order.expiresAt
      },
      rawQris,
      qrDataUrl
    });
  } catch (error) {
    sendServerError(res, error, "Could not create Premium payment order");
  }
});

// [ADDED] User reports that a Premium QRIS payment has been completed.
router.post("/premium/orders/:orderId/paid", async (req, res) => {
  try {
    const orderId = String(req.params.orderId || "");
    if (!/^premium_\d+_[a-z0-9]+$/i.test(orderId)) {
      return res.status(400).json({ ok: false, error: "INVALID_ORDER_ID" });
    }

    const order = getPremiumPaymentOrder(req.telegramId, orderId);
    if (!order) {
      return res.status(404).json({ ok: false, error: "PREMIUM_ORDER_NOT_FOUND" });
    }
    if (order.status !== "pending" || order.expires_at <= Date.now()) {
      return res.status(409).json({
        ok: false,
        error: "PREMIUM_ORDER_EXPIRED",
        message: "Pesanan sudah kedaluwarsa. Silakan buat QRIS baru."
      });
    }
    if (order.payment_reported_at) {
      return res.json({ ok: true, alreadyReported: true });
    }

    if (!markPremiumPaymentReported(req.telegramId, orderId)) {
      return res.status(409).json({
        ok: false,
        error: "PAYMENT_ALREADY_REPORTED",
        message: "Konfirmasi pembayaran sudah dikirim."
      });
    }

    const adminIds = String(process.env.ADMIN_TELEGRAM_IDS || "6838814141")
      .split(",")
      .map((id) => id.trim())
      .filter((id) => /^\d+$/.test(id));
    const username = req.miniAppUser?.username
      ? "@" + req.miniAppUser.username
      : [req.miniAppUser?.first_name, req.miniAppUser?.last_name].filter(Boolean).join(" ") || "Telegram user";
    const message = [
      "💳 <b>Konfirmasi Pembayaran Premium</b>",
      "",
      "<b>Order:</b> <code>" + order.id + "</code>",
      "<b>User:</b> " + username.replace(/[&<>]/g, ""),
      "<b>Telegram ID:</b> <code>" + req.telegramId + "</code>",
      "<b>Paket:</b> " + order.plan_period.toUpperCase(),
      "<b>Nominal:</b> Rp" + Number(order.amount).toLocaleString("id-ID"),
      "",
      "Periksa transaksi masuk di DANA sebelum mengaktifkan Premium."
    ].join("\\n");

    const results = await Promise.allSettled(
      adminIds.map((adminId) => bot.sendMessage(adminId, message, { parse_mode: "HTML" }))
    );
    const delivered = results.some((result) => result.status === "fulfilled");
    if (!delivered) {
      console.error("Premium payment report could not reach any admin.");
      return res.status(502).json({
        ok: false,
        error: "ADMIN_NOTIFICATION_FAILED",
        message: "Konfirmasi tersimpan, tetapi notifikasi admin gagal dikirim."
      });
    }

    res.setHeader("Cache-Control", "no-store");
    return res.json({ ok: true, reported: true });
  } catch (error) {
    sendServerError(res, error, "Could not report Premium payment");
  }
});


// [ADDED] Current role and membership for the authenticated Mini App account.
router.get("/account", (req, res) => {
  try {
    const membership = getMembership(req.telegramId);
    res.setHeader("Cache-Control", "no-store");
    res.json({ ok: true, account: membership });
  } catch (error) {
    sendServerError(res, error, "Could not load account membership");
  }
});

// ---------------------------------------------------------------------------
// [ADDED] WhatsApp pairing state for the Mini App.
// ---------------------------------------------------------------------------

// GET /api/miniapp/connection — current WhatsApp status and live pairing QR.
router.get("/connection", async (req, res) => {
  try {
    const connection = getWhatsAppStatus(req.telegramId);
    const storedSession = getSession(req.telegramId);
    const status = storedSession?.connection_status === "paused" &&
      connection.status === "disconnected"
      ? "paused"
      : connection.status;
    const accountProfile = status === "connected"
      ? await getWhatsAppAccountProfile(req.telegramId)
      : { displayName: null, pictureUrl: null };
    const qr = connection.status === "qr"
      ? getWhatsAppQr(req.telegramId)
      : null;

    res.setHeader("Cache-Control", "no-store");
    res.json({
      ok: true,
      status,
      phoneNumber: connection.phoneNumber || storedSession?.phone_number || null,
      displayName: accountProfile.displayName,
      pictureUrl: accountProfile.pictureUrl,
      qr: qr
        ? await QRCode.toDataURL(qr, {
            width: 320,
            margin: 2,
            errorCorrectionLevel: "M",
            color: { dark: "#101820", light: "#FFFFFF" }
          })
        : null
    });
  } catch (error) {
    sendServerError(res, error, "Could not get WhatsApp connection");
  }
});

// [ADDED] POST /api/miniapp/connection/disconnect — disconnect this user's WhatsApp session.
router.post("/connection/disconnect", async (req, res) => {
  try {
    const result = await disconnectWhatsApp(req.telegramId, { logout: true, clearAuth: true });
    res.setHeader("Cache-Control", "no-store");
    res.json({ ok: true, ...result });
  } catch (error) {
    sendServerError(res, error, "Could not disconnect WhatsApp");
  }
});

// POST /api/miniapp/connection/connect — start pairing for this Telegram user.
router.post("/connection/connect", async (req, res) => {
  try {
    const current = getWhatsAppStatus(req.telegramId);
    const storedSession = getSession(req.telegramId);
    const membership = getMembership(req.telegramId);

    if (current.status !== "connected") {
      // [ADDED] A Free session resumed after the daily pause reuses its saved auth.
      if (membership?.plan === "free") {
        const witaParts = new Intl.DateTimeFormat("en-CA", {
          timeZone: "Asia/Makassar",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          hourCycle: "h23"
        }).formatToParts(new Date());
        const wita = Object.fromEntries(witaParts.map((part) => [part.type, part.value]));
        // [MODIFIED] A Free user who manually resumes after today's pause cutoff
        // is exempt from another automatic pause until the next WITA day.
        if (Number(wita.hour) >= 14) {
          setFreePauseDate(req.telegramId, `${wita.year}-${wita.month}-${wita.day}`);
        }
      }

      await connectWhatsApp(
        req.telegramId,
        createWhatsAppCallbacks(req.telegramId)
      );
    }

    res.status(202).json({
      ok: true,
      ...getWhatsAppStatus(req.telegramId)
    });
  } catch (error) {
    sendServerError(res, error, "Could not start WhatsApp pairing");
  }
});

// ---------------------------------------------------------------------------
// Current user
// ---------------------------------------------------------------------------

router.get("/me", (req, res) => {
  res.json({
    ok: true,
    user: {
      id: req.telegramId,
      firstName: req.miniAppUser.first_name || "",
      lastName: req.miniAppUser.last_name || "",
      username: req.miniAppUser.username || null,
      languageCode: req.miniAppUser.language_code || null
    }
  });
});

// ---------------------------------------------------------------------------
// [ADDED] WhatsApp contact/group profile
// ---------------------------------------------------------------------------

// GET /api/miniapp/profile/:jid — only JIDs already present in this account's chats.
router.get("/profile/:jid", async (req, res) => {
  try {
    const jid = String(req.params.jid || "");

    if (!jid || jid.length > 256 || !/^(?:\d+(?::\d+)?@s\.whatsapp\.net|\d+(?::\d+)?@lid|\d+-\d+@g\.us)$/.test(jid)) {
      return res.status(400).json({ ok: false, error: "INVALID_WHATSAPP_JID" });
    }

    if (!hasWhatsAppParticipant(req.telegramId, jid)) {
      return res.status(404).json({ ok: false, error: "PROFILE_NOT_FOUND" });
    }

    const chat = getChat(req.telegramId, jid);
    // [ADDED] Resolve @lid to its real phone number through Baileys.
    const resolvedPhoneNumber = await getWhatsAppPhoneNumber(
      req.telegramId,
      jid
    ).catch(() => null);
    const profilePhoneNumber = resolvedPhoneNumber || chat?.phone_number || null;
    const cached = getWhatsAppProfileCache(req.telegramId, jid);
    const cacheTtlMs = 30 * 60 * 1000;
    const cacheFresh = cached && Date.now() - cached.fetched_at < cacheTtlMs;

    if (!cacheFresh) {
      try {
        const remote = await getWhatsAppProfile(req.telegramId, jid);
        const saved = saveWhatsAppProfileCache({
          telegramId: req.telegramId,
          whatsappJid: jid,
          displayName: chat?.display_name || getWhatsAppParticipantName(req.telegramId, jid),
          aboutText: remote.aboutText,
          pictureUrl: remote.pictureUrl,
          statusSetAt: remote.statusSetAt
        });

        res.setHeader("Cache-Control", "private, no-store");
        return res.json({
          ok: true,
          profile: {
            jid,
            phoneNumber: profilePhoneNumber,
            displayName: saved.display_name || chat?.display_name || getWhatsAppParticipantName(req.telegramId, jid) || jid,
            about: saved.about_text,
            pictureUrl: saved.picture_url,
            statusSetAt: saved.status_set_at,
            cachedAt: saved.fetched_at,
            stale: false
          }
        });
      } catch (error) {
        if (!cached) {
          const notConnected = error.message === "WHATSAPP_NOT_CONNECTED";
          return res.status(notConnected ? 409 : 502).json({
            ok: false,
            error: notConnected ? "WHATSAPP_NOT_CONNECTED" : "PROFILE_UNAVAILABLE",
            message: notConnected
              ? "Hubungkan WhatsApp untuk mengambil profil."
              : "Profil tidak dapat diambil saat ini."
          });
        }
      }
    }

    const profile = cached || {};
    res.setHeader("Cache-Control", "private, no-store");
    return res.json({
      ok: true,
      profile: {
        jid,
        phoneNumber: chat?.phone_number || null,
        displayName: profile.display_name || chat?.display_name || getWhatsAppParticipantName(req.telegramId, jid) || jid,
        about: profile.about_text || null,
        pictureUrl: profile.picture_url || null,
        statusSetAt: profile.status_set_at || null,
        cachedAt: profile.fetched_at || null,
        stale: !cacheFresh
      }
    });
  } catch (error) {
    sendServerError(res, error, "Could not fetch WhatsApp profile");
  }
});

// ---------------------------------------------------------------------------
// Chat list
// ---------------------------------------------------------------------------

// GET /api/miniapp/chats?limit=50&offset=0&archived=false
router.get("/chats", (req, res) => {
  try {
    const limit = parseLimit(req.query.limit, 50, MAX_LIMIT);
    const offset = Math.max(
      0,
      Number.parseInt(req.query.offset, 10) || 0
    );

    const archived = parseBoolean(req.query.archived);

    const chats = listChats(req.telegramId, {
      limit,
      offset,
      includeArchived: archived === true
    });

    const filteredChats = archived === true
      ? chats.filter((chat) => Boolean(chat.is_archived))
      : archived === false
        ? chats.filter((chat) => !chat.is_archived)
        : chats;

    res.json({
      ok: true,
      chats: filteredChats,
      pagination: {
        limit,
        offset,
        count: filteredChats.length
      }
    });
  } catch (error) {
    sendServerError(res, error, "Could not list chats");
  }
});

// ---------------------------------------------------------------------------
// Individual chat
// ---------------------------------------------------------------------------

// GET /api/miniapp/chats/:chatId
router.get("/chats/:chatId", (req, res) => {
  try {
    const chatId = getChatId(req);

    if (!chatId) {
      return res.status(400).json({
        ok: false,
        error: "INVALID_CHAT_ID"
      });
    }

    const chat = getChat(req.telegramId, chatId);

    if (!chat) {
      return res.status(404).json({
        ok: false,
        error: "CHAT_NOT_FOUND"
      });
    }

    res.json({
      ok: true,
      chat
    });
  } catch (error) {
    sendServerError(res, error, "Could not get chat");
  }
});

// ---------------------------------------------------------------------------
// Chat messages
// ---------------------------------------------------------------------------

// GET /api/miniapp/chats/:chatId/messages?limit=100
router.get("/chats/:chatId/messages", (req, res) => {
  try {
    const chatId = getChatId(req);

    if (!chatId) {
      return res.status(400).json({
        ok: false,
        error: "INVALID_CHAT_ID"
      });
    }

    const chat = getChat(req.telegramId, chatId);

    if (!chat) {
      return res.status(404).json({
        ok: false,
        error: "CHAT_NOT_FOUND"
      });
    }

    // [ADDED] Enforce the group/channel Premium gate on the server.
    const membership = getMembership(req.telegramId);
    const isPremium = Boolean(membership?.plan && membership.plan !== "free");
    const isGroupOrChannel = chat.chat_type === "group"
      || String(chat.whatsapp_chat_id || "").endsWith("@newsletter");

    if (!isPremium && isGroupOrChannel) {
      return res.status(403).json({
        ok: false,
        error: "PREMIUM_REQUIRED",
        message: "Grup dan saluran hanya tersedia untuk pengguna Premium."
      });
    }

    const limit = parseLimit(req.query.limit, 100, MAX_MESSAGES);

    // The database returns newest-first; reverse for chronological display.
    const messages = listMessages(
      req.telegramId,
      chatId,
      limit
    ).reverse().map((message) => toPublicMessage(message, membership));

    res.json({
      ok: true,
      chat,
      messages,
      pagination: {
        limit,
        count: messages.length
      }
    });
  } catch (error) {
    sendServerError(res, error, "Could not list messages");
  }
});

// ---------------------------------------------------------------------------
// Mini App local read status
// ---------------------------------------------------------------------------

// POST /api/miniapp/chats/:chatId/read
// This changes SQLite only. It does not call WhatsApp or Baileys.
router.post("/chats/:chatId/read", (req, res) => {
  try {
    const chatId = getChatId(req);

    if (!chatId) {
      return res.status(400).json({
        ok: false,
        error: "INVALID_CHAT_ID"
      });
    }

    const chat = getChat(req.telegramId, chatId);

    if (!chat) {
      return res.status(404).json({
        ok: false,
        error: "CHAT_NOT_FOUND"
      });
    }

    const updated = markChatReadInMiniApp(
      req.telegramId,
      chatId
    );

    res.json({
      ok: true,
      localOnly: true,
      updated
    });
  } catch (error) {
    sendServerError(res, error, "Could not mark chat read");
  }
});

// ---------------------------------------------------------------------------
// Favorite
// ---------------------------------------------------------------------------

// PUT /api/miniapp/chats/:chatId/favorite
// Body: { "favorite": true }
router.put("/chats/:chatId/favorite", express.json(), (req, res) => {
  try {
    const chatId = getChatId(req);
    const favorite = parseBoolean(req.body?.favorite);

    if (!chatId || favorite === null) {
      return res.status(400).json({
        ok: false,
        error: "INVALID_REQUEST",
        message: "Provide a valid chat ID and boolean favorite value."
      });
    }

    if (!getChat(req.telegramId, chatId)) {
      return res.status(404).json({
        ok: false,
        error: "CHAT_NOT_FOUND"
      });
    }

    setChatFavorite(req.telegramId, chatId, favorite);

    res.json({
      ok: true,
      favorite
    });
  } catch (error) {
    sendServerError(res, error, "Could not update favorite");
  }
});

// ---------------------------------------------------------------------------
// Archive
// ---------------------------------------------------------------------------

// PUT /api/miniapp/chats/:chatId/archive
// Body: { "archived": true }
router.put("/chats/:chatId/archive", express.json(), (req, res) => {
  try {
    const chatId = getChatId(req);
    const archived = parseBoolean(req.body?.archived);

    if (!chatId || archived === null) {
      return res.status(400).json({
        ok: false,
        error: "INVALID_REQUEST",
        message: "Provide a valid chat ID and boolean archived value."
      });
    }

    if (!getChat(req.telegramId, chatId)) {
      return res.status(404).json({
        ok: false,
        error: "CHAT_NOT_FOUND"
      });
    }

    setChatArchived(req.telegramId, chatId, archived);

    res.json({
      ok: true,
      archived
    });
  } catch (error) {
    sendServerError(res, error, "Could not update archive");
  }
});

// ---------------------------------------------------------------------------
// Search chats
// ---------------------------------------------------------------------------

// GET /api/miniapp/search?q=keyword
router.get("/search", (req, res) => {
  try {
    const query = String(req.query.q || "").trim().toLowerCase();

    if (!query) {
      return res.json({
        ok: true,
        chats: [],
        messages: []
      });
    }

    if (query.length > 200) {
      return res.status(400).json({
        ok: false,
        error: "QUERY_TOO_LONG"
      });
    }

    // Search only chats belonging to this authenticated Telegram user.
    const chats = listChats(req.telegramId, {
      limit: MAX_LIMIT,
      offset: 0,
      includeArchived: true
    });

    const matchedChats = chats.filter((chat) => {
      const name = String(
        chat.display_name || chat.name || ""
      ).toLowerCase();
      const phone = String(chat.phone_number || "").toLowerCase();
      const preview = String(
        chat.last_message_preview || ""
      ).toLowerCase();

      return (
        name.includes(query) ||
        phone.includes(query) ||
        preview.includes(query)
      );
    });

    // Search stored messages within the returned chat list.
    const matchedMessages = [];

    for (const chat of chats) {
      const messages = listMessages(
        req.telegramId,
        chat.whatsapp_chat_id,
        MAX_MESSAGES
      );

      for (const message of messages) {
        if (String(message.body || "").toLowerCase().includes(query)) {
          matchedMessages.push({
            ...toPublicMessage(message),
            chat_name: chat.display_name || chat.name
          });

          if (matchedMessages.length >= MAX_MESSAGES) {
            break;
          }
        }
      }

      if (matchedMessages.length >= MAX_MESSAGES) {
        break;
      }
    }

    res.json({
      ok: true,
      chats: matchedChats,
      messages: matchedMessages
    });
  } catch (error) {
    sendServerError(res, error, "Could not search");
  }
});

// ---------------------------------------------------------------------------
// [ADDED] Contacts
// ---------------------------------------------------------------------------

// Validation problems are safe to show to the user; everything else is 500.
function sendContactError(res, error, message) {
  if (error instanceof ValidationError) {
    return res.status(error.code === "DUPLICATE_PHONE" ? 409 : 400).json({
      ok: false,
      error: error.code,
      message: error.message
    });
  }

  return sendServerError(res, error, message);
}

function readContactBody(req) {
  const body = req.body && typeof req.body === "object" ? req.body : {};

  return {
    name: typeof body.name === "string" ? body.name : "",
    phone: typeof body.phone_number === "string"
      ? body.phone_number
      : typeof body.phone === "string" ? body.phone : ""
  };
}

// GET /api/miniapp/contacts
router.get("/contacts", (req, res) => {
  try {
    res.json({
      ok: true,
      contacts: listContacts(req.telegramId)
    });
  } catch (error) {
    sendServerError(res, error, "Could not list contacts");
  }
});

// POST /api/miniapp/contacts
// Body: { "name": "Budi", "phone_number": "081234567890" }
// If the number already exists, its name is updated.
router.post("/contacts", (req, res) => {
  try {
    const { created, contact } = saveContact(
      req.telegramId,
      readContactBody(req)
    );

    res.status(created ? 201 : 200).json({
      ok: true,
      created,
      contact
    });
  } catch (error) {
    sendContactError(res, error, "Could not save contact");
  }
});

// PUT /api/miniapp/contacts/:id
router.put("/contacts/:id", (req, res) => {
  try {
    const contact = updateContact(
      req.telegramId,
      req.params.id,
      readContactBody(req)
    );

    if (!contact) {
      return res.status(404).json({
        ok: false,
        error: "CONTACT_NOT_FOUND"
      });
    }

    res.json({
      ok: true,
      contact
    });
  } catch (error) {
    sendContactError(res, error, "Could not update contact");
  }
});

// DELETE /api/miniapp/contacts/:id
router.delete("/contacts/:id", (req, res) => {
  try {
    if (!deleteContact(req.telegramId, req.params.id)) {
      return res.status(404).json({
        ok: false,
        error: "CONTACT_NOT_FOUND"
      });
    }

    res.json({
      ok: true
    });
  } catch (error) {
    sendServerError(res, error, "Could not delete contact");
  }
});



// [ADDED] Delete selected data belonging only to the authenticated Telegram user.
router.post("/data/cleanup", (req, res) => {
  try {
    const type = String(req.body?.type || "");
    if (!["media", "messages", "calls", "contacts"].includes(type)) {
      return res.status(400).json({ ok: false, error: "INVALID_CLEANUP_TYPE" });
    }

    const deleted = cleanupUserData(req.telegramId, type);
    res.setHeader("Cache-Control", "no-store");
    res.json({ ok: true, type, deleted });
  } catch (error) {
    sendServerError(res, error, "Could not clean up user data");
  }
});

// ---------------------------------------------------------------------------
// [ADDED] Call history
// ---------------------------------------------------------------------------

// GET /api/miniapp/calls?limit=100&offset=0
router.get("/calls", (req, res) => {
  try {
    const limit = parseLimit(req.query.limit, 100, 200);
    const offset = Math.max(
      0,
      Number.parseInt(req.query.offset, 10) || 0
    );

    const calls = listCalls(req.telegramId, { limit, offset, archived: req.query.archived === "true" });

    res.json({
      ok: true,
      calls,
      pagination: {
        limit,
        offset,
        count: calls.length
      }
    });
  } catch (error) {
    sendServerError(res, error, "Could not list calls");
  }
});

// [ADDED] Favorite or archive an individual call record, independent of chats.
router.put("/calls/:id/favorite", (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0 || typeof req.body?.favorite !== "boolean") {
      return res.status(400).json({ ok: false, error: "INVALID_CALL_UPDATE" });
    }
    if (!setCallFavorite(req.telegramId, id, req.body.favorite)) {
      return res.status(404).json({ ok: false, error: "CALL_NOT_FOUND" });
    }
    res.json({ ok: true });
  } catch (error) {
    sendServerError(res, error, "Could not update call favorite");
  }
});

router.put("/calls/:id/archive", (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0 || typeof req.body?.archived !== "boolean") {
      return res.status(400).json({ ok: false, error: "INVALID_CALL_UPDATE" });
    }
    if (!setCallArchived(req.telegramId, id, req.body.archived)) {
      return res.status(404).json({ ok: false, error: "CALL_NOT_FOUND" });
    }
    res.json({ ok: true });
  } catch (error) {
    sendServerError(res, error, "Could not archive call");
  }
});


// ---------------------------------------------------------------------------
// [ADDED] Media (photos, videos, stickers)
// ---------------------------------------------------------------------------

const MEDIA_TYPES = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  mp4: "video/mp4",
  m4v: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  oga: "audio/ogg",
  ogg: "audio/ogg",
  mp3: "audio/mpeg",
  m4a: "audio/mp4"
};

// GET /api/miniapp/messages/:id/media
// Streams the copy of the file that the bot already sent to Telegram.
// The bot token never leaves the server. Telegram only serves files up to
// 20 MB to bots, so bigger videos answer MEDIA_TOO_LARGE.
router.get("/messages/:id/media", async (req, res) => {
  try {
    const rowId = Number.parseInt(req.params.id, 10);
    const media = Number.isInteger(rowId)
      ? getMessageMedia(req.telegramId, rowId)
      : null;

    if (!media?.telegram_file_id && !media?.media_storage_path) {
      return res.status(404).json({
        ok: false,
        error: "MEDIA_NOT_FOUND"
      });
    }

    // [ADDED] Enforce the Free media restriction on the server, not only in the Mini App UI.
    const membership = getMembership(req.telegramId);
    if (membership?.plan === "free") {
      return res.status(403).json({
        ok: false,
        error: "PREMIUM_REQUIRED",
        message: "Upgrade Premium untuk melihat media yang diterima."
      });
    }

    // [ADDED] Serve private VPS files only from the configured media directory.
    if (media.media_storage_path) {
      const mediaRoot = path.resolve(MEDIA_ROOT) + path.sep;
      const storagePath = path.resolve(media.media_storage_path);

      if (!storagePath.startsWith(mediaRoot)) {
        return res.status(404).json({
          ok: false,
          error: "MEDIA_NOT_FOUND"
        });
      }

      let stat;

      try {
        stat = fs.statSync(storagePath);
      } catch {
        return res.status(404).json({
          ok: false,
          error: "MEDIA_NOT_FOUND"
        });
      }

      if (!stat.isFile()) {
        return res.status(404).json({
          ok: false,
          error: "MEDIA_NOT_FOUND"
        });
      }

      const mimetype = String(media.media_mimetype || "application/octet-stream")
        .split(";")[0]
        .trim()
        .toLowerCase();
      const inlineTypes = new Set([
        "image/jpeg", "image/png", "image/webp", "image/gif",
        "video/mp4", "video/quicktime", "video/webm",
        "audio/ogg", "audio/mpeg", "audio/mp4", "application/pdf"
      ]);
      const safeName = path.basename(String(media.media_file_name || "file"))
        .replace(/["\r\n]/g, "_");
      const disposition = inlineTypes.has(mimetype) ||
        mimetype.startsWith("image/") ||
        mimetype.startsWith("video/") ||
        mimetype.startsWith("audio/")
        ? "inline"
        : "attachment";

      res.setHeader("Content-Type", mimetype);
      res.setHeader("Content-Disposition", `${disposition}; filename*=UTF-8''${encodeURIComponent(safeName)}`);
      res.setHeader("Content-Length", stat.size);
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Cache-Control", "private, max-age=86400");

      fs.createReadStream(storagePath)
        .on("error", () => res.destroy())
        .pipe(res);
      return;
    }

    // [ADDED] Compatibility with older rows that still reference Telegram files.
    let file;

    try {
      file = await bot.getFile(media.telegram_file_id);
    } catch (error) {
      const tooLarge = /too big/i.test(String(error?.message));

      return res.status(tooLarge ? 413 : 502).json({
        ok: false,
        error: tooLarge ? "MEDIA_TOO_LARGE" : "MEDIA_UNAVAILABLE"
      });
    }

    const upstream = await fetch(
      `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${file.file_path}`
    );

    if (!upstream.ok || !upstream.body) {
      return res.status(502).json({
        ok: false,
        error: "MEDIA_UNAVAILABLE"
      });
    }

    const extension = String(file.file_path).split(".").pop().toLowerCase();

    // Only known image/video/audio types are served with their real type;
    // anything else is downloaded as opaque bytes (never rendered as HTML).
    res.setHeader(
      "Content-Type",
      MEDIA_TYPES[extension] || "application/octet-stream"
    );
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "private, max-age=86400");

    const length = upstream.headers.get("content-length");

    if (length) {
      res.setHeader("Content-Length", length);
    }

    Readable.fromWeb(upstream.body)
      .on("error", () => res.destroy())
      .pipe(res);
  } catch (error) {
    sendServerError(res, error, "Could not load media");
  }
});

export default router;