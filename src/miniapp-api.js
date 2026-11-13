// src/miniapp-api.js
// [ADDED] REST API for WhatsApp Mini App.
// Mini App read status is local only and never sends WhatsApp read receipts.

import express from "express";
import crypto from "node:crypto";
import { Readable } from "node:stream";
import fs from "node:fs";
import path from "node:path";
import { MEDIA_ROOT } from "./media-storage.js";

// [ADDED] Premium 30-day AI Customer Service endpoints.
import {
  getAICustomerServiceStatus,
  setAICustomerServiceEnabled,
  learnAICustomerServiceHistory,
  createAICustomerServiceSuggestion,
  createAIBusinessReply, // [MODIFIED] WAGRAM AI Business chat powered by OpenRouter.
  createAIBusinessTrainingQuestion, // [MODIFIED] OpenRouter-generated simulated customer for owner training.
  checkOpenRouterHealth
} from "./ai/customer-service.js";

import { bot, createWhatsAppCallbacks } from "./telegram.js";
import QRCode from "qrcode";
import { connectWhatsApp, disconnectWhatsApp, getWhatsAppQr, getWhatsAppStatus, getWhatsAppAccountProfile, getWhatsAppProfile, getWhatsAppPhoneNumber } from "./whatsapp.js";

import {
  getUser,
  getMembership,
  getSession,
  getWhatsAppAccounts,
  getWhatsAppAccount,
  createWhatsAppAccount,
  updateWhatsAppAccountSession,
  deleteWhatsAppAccount,
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
  markPremiumPaymentReported, // [ADDED] Record a user's payment confirmation.
  getAIBusinessProfile,
  saveAIBusinessProfile,
  addAIBusinessExample
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
  const requestedSessionId = String(
    req.query.sessionId || req.body?.sessionId ||
    req.get("X-WAGRAM-Session-ID") || authenticated.id
  );
  if (!getWhatsAppAccount(authenticated.id, requestedSessionId)) {
    return res.status(404).json({ ok: false, error: "WHATSAPP_SESSION_NOT_FOUND" });
  }
  req.miniAppUser = authenticated.user;
  req.telegramId = authenticated.id;
  req.sessionId = requestedSessionId;
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

// [ADDED] Temporary QRIS image downloads requested through Telegram's native Mini App API.
const premiumQrDownloads = new Map();

router.get("/premium/qr-download/:token.png", (req, res) => {
  const token = String(req.params.token || "");
  const entry = premiumQrDownloads.get(token);
  if (!entry || entry.expiresAt <= Date.now()) {
    premiumQrDownloads.delete(token);
    return res.status(404).send("QRIS download expired.");
  }
  res.setHeader("Content-Type", "image/png");
  res.setHeader("Content-Disposition", 'attachment; filename="WAGRAM-Premium-QRIS.png"');
  res.setHeader("Access-Control-Allow-Origin", "https://web.telegram.org");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Length", entry.buffer.length);
  return res.end(entry.buffer);
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
    const amountText = String(order.amount);
    const amountField = "54" + String(amountText.length).padStart(2, "0") + amountText;
    const payloadWithoutCrc = basePayload.replace("540510000", amountField).slice(0, -8) + "6304";

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

// [ADDED] Store a generated QRIS PNG briefly for Telegram's native download API.
router.post("/premium/orders/:orderId/qr-download", (req, res) => {
  try {
    const orderId = String(req.params.orderId || "");
    if (!/^premium_\d+_[a-z0-9]+$/i.test(orderId)) {
      return res.status(400).json({ ok: false, error: "INVALID_ORDER_ID" });
    }
    const order = getPremiumPaymentOrder(req.telegramId, orderId);
    if (!order || order.status !== "pending" || order.expires_at <= Date.now()) {
      return res.status(404).json({ ok: false, error: "PREMIUM_ORDER_NOT_AVAILABLE" });
    }
    const imageData = String(req.body?.imageData || "");
    const match = imageData.match(/^data:image\/png;base64,([A-Za-z0-9+/=]+)$/);
    if (!match || match[1].length > 1500000) {
      return res.status(400).json({ ok: false, error: "INVALID_QR_IMAGE" });
    }
    const buffer = Buffer.from(match[1], "base64");
    if (!buffer.length || buffer.length > 1024 * 1024) {
      return res.status(400).json({ ok: false, error: "QR_IMAGE_TOO_LARGE" });
    }
    const token = crypto.randomBytes(24).toString("hex");
    premiumQrDownloads.set(token, { buffer, expiresAt: Date.now() + 5 * 60 * 1000 });
    return res.json({
      ok: true,
      downloadUrl: "/api/miniapp/premium/qr-download/" + token + ".png"
    });
  } catch (error) {
    return sendServerError(res, error, "Could not prepare Premium QRIS download");
  }
});
// [ADDED] User reports that a Premium QRIS payment has been completed.
router.post(
  "/premium/orders/:orderId/paid",
  express.raw({ type: ["image/jpeg"], limit: "8mb" }), // [ADDED] Receive compact binary image payload.
  async (req, res) => {
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

    // [MODIFIED] Validate raw JPEG bytes; avoids Base64 request expansion.
    const proofBuffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!proofBuffer.length) {
      return res.status(400).json({
        ok: false,
        error: "PAYMENT_PROOF_REQUIRED",
        message: "Pilih bukti pembayaran JPG, PNG, atau WEBP maksimal 5 MB."
      });
    }
    const isJpeg = proofBuffer.length >= 3 &&
      proofBuffer[0] === 0xff && proofBuffer[1] === 0xd8 && proofBuffer[2] === 0xff;
    if (!isJpeg || proofBuffer.length > 5 * 1024 * 1024) {
      return res.status(400).json({
        ok: false,
        error: "INVALID_PAYMENT_PROOF",
        message: "Ukuran bukti pembayaran maksimal 5 MB."
      });
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
    const planLabels = { "3d": "Premium 3 Hari", "7d": "Premium 7 Hari", "30d": "Premium 30 Hari" };
    const safeUsername = username.replace(/[&<>]/g, "");
    const message = [
      "💎 <b>WAGRAM PREMIUM — PEMBAYARAN</b>",
      "",
      "📦 <b>Detail Pesanan</b>",
      "Paket: <b>" + planLabels[order.plan_period] + "</b>",
      "Total: <b>Rp" + Number(order.amount).toLocaleString("id-ID") + "</b>",
      "Order ID: <code>" + order.id + "</code>",
      "",
      "👤 <b>Informasi Pengguna</b>",
      "Username: " + safeUsername,
      "Telegram ID: <code>" + req.telegramId + "</code>",
      "",
      "⚠️ Verifikasi dana masuk di DANA sebelum menyetujui pembayaran."
    ].join("\n");

    const proofExtension = "jpg"; // [MODIFIED] Client sends compressed JPEG binary data.
    const results = await Promise.allSettled(
      adminIds.map((adminId) => bot.sendPhoto(
        adminId,
        proofBuffer,
        {
          caption: message,
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [[
              { text: "✅ Setujui", callback_data: "premium:approve:" + order.id },
              { text: "❌ Tolak", callback_data: "premium:reject:" + order.id }
            ]]
          }
        },
        { filename: "bukti-pembayaran-premium." + proofExtension, contentType: "image/jpeg" } // [MODIFIED]
      ))
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

// [ADDED] List and manage WhatsApp accounts with server-enforced tier limits.
router.get("/sessions", (req, res) => {
  try {
    const membership = getMembership(req.telegramId);
    // [MODIFIED] Remove abandoned secondary sessions that never completed pairing.
    // These records have no phone number and no live QR/connection, so they must not consume a Premium slot.
    const sessions = getWhatsAppAccounts(req.telegramId).map((session) => {
      const live = getWhatsAppStatus(session.session_id);
      return {
        ...session,
        status: live.status === "disconnected" && session.connection_status === "paused"
          ? "paused"
          : live.status,
        phone_number: live.phoneNumber || session.phone_number || null
      };
    }).filter((session) => {
      const abandoned = !session.is_primary &&
        !session.phone_number &&
        session.status === "disconnected";
      if (abandoned) deleteWhatsAppAccount(req.telegramId, session.session_id);
      return !abandoned;
    });

    res.setHeader("Cache-Control", "no-store");
    res.json({
      ok: true,
      sessions,
      limit: membership?.sessions_limit || 1,
      count: sessions.length,
      plan: membership?.plan || "free"
    });
  } catch (error) {
    sendServerError(res, error, "Could not list WhatsApp sessions");
  }
});

router.post("/sessions", express.json(), (req, res) => {
  try {
    const label = typeof req.body?.label === "string" ? req.body.label.trim() : null;
    const session = createWhatsAppAccount(req.telegramId, label);
    res.status(201).json({ ok: true, session });
  } catch (error) {
    if (error.message === "SESSION_LIMIT_REACHED") {
      const membership = getMembership(req.telegramId);
      return res.status(403).json({
        ok: false,
        error: "SESSION_LIMIT_REACHED",
        limit: membership?.sessions_limit || 1,
        plan: membership?.plan || "free"
      });
    }
    sendServerError(res, error, "Could not create WhatsApp session");
  }
});

router.get("/sessions/:sessionId/connection", async (req, res) => {
  try {
    const session = getWhatsAppAccount(req.telegramId, req.params.sessionId);
    if (!session) return res.status(404).json({ ok: false, error: "SESSION_NOT_FOUND" });

    const connection = getWhatsAppStatus(session.session_id);
    const status = connection.status === "disconnected" && session.connection_status === "paused"
      ? "paused"
      : connection.status;
    const profile = status === "connected"
      ? await getWhatsAppAccountProfile(session.session_id)
      : { displayName: null, pictureUrl: null };
    const qr = connection.status === "qr" ? getWhatsAppQr(session.session_id) : null;

    res.setHeader("Cache-Control", "no-store");
    res.json({
      ok: true,
      sessionId: session.session_id,
      status,
      phoneNumber: connection.phoneNumber || session.phone_number || null,
      displayName: profile.displayName,
      pictureUrl: profile.pictureUrl,
      qr: qr ? await QRCode.toDataURL(qr, {
        width: 480,
        margin: 2,
        // [MODIFIED] High error correction improves QR readability with the centered WAGRAM logo.
        errorCorrectionLevel: "H",
        color: { dark: "#101820", light: "#FFFFFF" }
      }) : null
    });
  } catch (error) {
    sendServerError(res, error, "Could not get WhatsApp session connection");
  }
});

router.post("/sessions/:sessionId/connect", async (req, res) => {
  try {
    const session = getWhatsAppAccount(req.telegramId, req.params.sessionId);
    if (!session) return res.status(404).json({ ok: false, error: "SESSION_NOT_FOUND" });

    // [ADDED] Re-check the current tier at connect time, including after plan expiry.
    const membership = getMembership(req.telegramId);
    const ownedSessions = getWhatsAppAccounts(req.telegramId);
    const sessionIndex = ownedSessions.findIndex((item) => item.session_id === session.session_id);
    if (!membership || sessionIndex < 0 || sessionIndex >= membership.sessions_limit) {
      return res.status(403).json({
        ok: false,
        error: "SESSION_LIMIT_REACHED",
        limit: membership?.sessions_limit || 1,
        plan: membership?.plan || "free"
      });
    }

    await connectWhatsApp(
      req.telegramId,
      createWhatsAppCallbacks(req.telegramId, { sessionId: session.session_id }),
      { sessionId: session.session_id }
    );

    const live = getWhatsAppStatus(session.session_id);
    res.status(202).json({ ok: true, sessionId: session.session_id, ...live });
  } catch (error) {
    sendServerError(res, error, "Could not start WhatsApp session pairing");
  }
});

router.post("/sessions/:sessionId/disconnect", async (req, res) => {
  try {
    const session = getWhatsAppAccount(req.telegramId, req.params.sessionId);
    if (!session) return res.status(404).json({ ok: false, error: "SESSION_NOT_FOUND" });

    await disconnectWhatsApp(req.telegramId, {
      sessionId: session.session_id,
      logout: true,
      clearAuth: true
    });
    updateWhatsAppAccountSession(req.telegramId, session.session_id, "disconnected");
    res.setHeader("Cache-Control", "no-store");
    res.json({ ok: true, status: "disconnected", sessionId: session.session_id });
  } catch (error) {
    sendServerError(res, error, "Could not disconnect WhatsApp session");
  }
});

router.delete("/sessions/:sessionId", async (req, res) => {
  try {
    const session = getWhatsAppAccount(req.telegramId, req.params.sessionId);
    if (!session) return res.status(404).json({ ok: false, error: "SESSION_NOT_FOUND" });
    if (session.is_primary) {
      return res.status(400).json({ ok: false, error: "PRIMARY_SESSION_CANNOT_BE_DELETED" });
    }

    await disconnectWhatsApp(req.telegramId, {
      sessionId: session.session_id,
      logout: true,
      clearAuth: true
    });
    deleteWhatsAppAccount(req.telegramId, session.session_id);
    res.json({ ok: true, deleted: true });
  } catch (error) {
    sendServerError(res, error, "Could not delete WhatsApp session");
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

    if (!hasWhatsAppParticipant(req.telegramId, jid, req.sessionId)) {
      return res.status(404).json({ ok: false, error: "PROFILE_NOT_FOUND" });
    }

    const chat = getChat(req.telegramId, jid, req.sessionId);
    // [ADDED] Resolve @lid to its real phone number through Baileys.
    const resolvedPhoneNumber = await getWhatsAppPhoneNumber(
      req.sessionId,
      jid
    ).catch(() => null);
    const profilePhoneNumber = resolvedPhoneNumber || chat?.phone_number || null;
    const cached = getWhatsAppProfileCache(req.telegramId, jid, req.sessionId);
    const cacheTtlMs = 30 * 60 * 1000;
    const cacheFresh = cached && Date.now() - cached.fetched_at < cacheTtlMs;

    if (!cacheFresh) {
      try {
        const remote = await getWhatsAppProfile(req.sessionId, jid);
        const saved = saveWhatsAppProfileCache({
          telegramId: req.telegramId,
          sessionId: req.sessionId,
          whatsappJid: jid,
          displayName: chat?.display_name || getWhatsAppParticipantName(req.telegramId, jid, req.sessionId),
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
            displayName: saved.display_name || chat?.display_name || getWhatsAppParticipantName(req.telegramId, jid, req.sessionId) || jid,
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
        displayName: profile.display_name || chat?.display_name || getWhatsAppParticipantName(req.telegramId, jid, req.sessionId) || jid,
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
      includeArchived: archived === true,
      sessionId: req.sessionId
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

    const chat = getChat(req.telegramId, chatId, req.sessionId);

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

    const chat = getChat(req.telegramId, chatId, req.sessionId);

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
      limit,
      req.sessionId
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

    const chat = getChat(req.telegramId, chatId, req.sessionId);

    if (!chat) {
      return res.status(404).json({
        ok: false,
        error: "CHAT_NOT_FOUND"
      });
    }

    const updated = markChatReadInMiniApp(
      req.telegramId,
      chatId,
      req.sessionId
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

    if (!getChat(req.telegramId, chatId, req.sessionId)) {
      return res.status(404).json({
        ok: false,
        error: "CHAT_NOT_FOUND"
      });
    }

    setChatFavorite(req.telegramId, chatId, favorite, req.sessionId);

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

    if (!getChat(req.telegramId, chatId, req.sessionId)) {
      return res.status(404).json({
        ok: false,
        error: "CHAT_NOT_FOUND"
      });
    }

    setChatArchived(req.telegramId, chatId, archived, req.sessionId);

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
      includeArchived: true,
      sessionId: req.sessionId
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
        MAX_MESSAGES,
        req.sessionId
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
      contacts: listContacts(req.telegramId, 1000, req.sessionId)
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
      readContactBody(req),
      req.sessionId
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
      readContactBody(req),
      req.sessionId
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
    if (!deleteContact(req.telegramId, req.params.id, req.sessionId)) {
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

    const deleted = cleanupUserData(req.telegramId, type, req.sessionId);
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

    const calls = listCalls(req.telegramId, { limit, offset, archived: req.query.archived === "true", sessionId: req.sessionId });

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
    if (!setCallFavorite(req.telegramId, id, req.body.favorite, req.sessionId)) {
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
    if (!setCallArchived(req.telegramId, id, req.body.archived, req.sessionId)) {
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
      ? getMessageMedia(req.telegramId, rowId, req.sessionId)
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


/* [ADDED] AI Customer Service: available only to Premium 30-day users.
   All actions are scoped to the authenticated Telegram owner and selected WhatsApp session. */
router.get("/ai/status", (req, res) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    return res.json({
      ok: true,
      ai: getAICustomerServiceStatus(req.telegramId, req.sessionId)
    });
  } catch (error) {
    return sendServerError(res, error, "Could not read AI Customer Service status");
  }
});

router.post("/ai/enable", (req, res) => {
  try {
    const ai = setAICustomerServiceEnabled(req.telegramId, req.sessionId, true);
    // Historical learning runs in the background so activation stays responsive.
    void learnAICustomerServiceHistory(req.telegramId, req.sessionId).catch((error) => {
      console.error("[AI Customer Service] Initial learning failed:", error.message);
    });
    res.setHeader("Cache-Control", "no-store");
    return res.status(202).json({ ok: true, ai, learningStarted: true });
  } catch (error) {
    const status = error.status || (error.message === "AI_CUSTOMER_SERVICE_REQUIRES_PREMIUM_30D" ? 403 : 500);
    return res.status(status).json({
      ok: false,
      error: error.message || "AI_CUSTOMER_SERVICE_ERROR",
      message: status === 403
        ? "AI Customer Service hanya tersedia untuk Premium 30 hari."
        : "AI Customer Service tidak dapat diaktifkan."
    });
  }
});

router.post("/ai/disable", (req, res) => {
  try {
    const ai = setAICustomerServiceEnabled(req.telegramId, req.sessionId, false);
    res.setHeader("Cache-Control", "no-store");
    return res.json({ ok: true, ai });
  } catch (error) {
    return sendServerError(res, error, "Could not disable AI Customer Service");
  }
});

router.post("/ai/learn", async (req, res) => {
  try {
    const result = await learnAICustomerServiceHistory(req.telegramId, req.sessionId);
    res.setHeader("Cache-Control", "no-store");
    return res.json({ ok: true, ...result, ai: getAICustomerServiceStatus(req.telegramId, req.sessionId) });
  } catch (error) {
    const status = error.status || 500;
    return res.status(status).json({
      ok: false,
      error: error.message || "AI_LEARNING_FAILED",
      message: status === 403
        ? "Fitur ini membutuhkan Premium 30 hari."
        : status === 409
          ? "Aktifkan AI Customer Service terlebih dahulu."
          : "AI belum berhasil mempelajari riwayat chat."
    });
  }
});

router.get("/ai/health", async (_req, res) => {
  try {
    return res.json({ ok: true, openrouter: await checkOpenRouterHealth() });
  } catch (error) {
    return res.status(503).json({
      ok: false,
      error: "OPENROUTER_UNAVAILABLE",
      message: "Layanan OpenRouter belum tersedia."
    });
  }
});

router.post("/ai/suggest/:chatId", async (req, res) => {
  try {
    const chatId = String(req.params.chatId || "");
    if (!chatId || chatId.length > 256) {
      return res.status(400).json({ ok: false, error: "INVALID_CHAT_ID" });
    }
    const chat = getChat(req.telegramId, chatId, req.sessionId);
    if (!chat || chat.chat_type !== "private") {
      return res.status(404).json({ ok: false, error: "PRIVATE_CHAT_NOT_FOUND" });
    }
    const suggestion = await createAICustomerServiceSuggestion(
      req.telegramId,
      req.sessionId,
      chatId
    );
    res.setHeader("Cache-Control", "no-store");
    return res.json({ ok: true, suggestion });
  } catch (error) {
    const status = error.status || 500;
    return res.status(status).json({
      ok: false,
      error: error.message || "AI_SUGGESTION_FAILED",
      message: status === 403
        ? "Fitur ini membutuhkan Premium 30 hari."
        : status === 409
          ? "AI harus aktif dan pesan terakhir harus berasal dari pelanggan."
          : "Draft balasan belum dapat dibuat."
    });
  }
});



/* [ADDED] Read persistent WAGRAM AI settings scoped to the authenticated owner and WhatsApp session. */
router.get("/ai-business/settings", (req, res) => {
  try {
    const membership = getMembership(req.telegramId);
    if (membership?.plan !== "premium-c") {
      return res.status(403).json({ ok: false, error: "AI_BUSINESS_REQUIRES_PREMIUM_C" });
    }
    const profile = getAIBusinessProfile(req.telegramId, req.sessionId);
    res.setHeader("Cache-Control", "no-store");
    return res.json({ ok: true, profile });
  } catch (error) {
    return sendServerError(res, error, "Could not load WAGRAM AI settings");
  }
});

/* [ADDED] Save WAGRAM AI settings on the server; browser-provided owner/session IDs are never trusted. */
router.put("/ai-business/settings", (req, res) => {
  try {
    const membership = getMembership(req.telegramId);
    if (membership?.plan !== "premium-c") {
      return res.status(403).json({ ok: false, error: "AI_BUSINESS_REQUIRES_PREMIUM_C" });
    }
    const settings = req.body?.settings;
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
      return res.status(400).json({ ok: false, error: "INVALID_AI_BUSINESS_SETTINGS" });
    }
    const qrisImage = String(settings.payment?.qrisImage || "");
    const qrisImageMatch = qrisImage.match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/);
    if (qrisImage && (!qrisImageMatch || qrisImageMatch[2].length > 1400000)) {
      return res.status(400).json({ ok: false, error: "INVALID_QRIS_IMAGE", message: "Gambar QRIS harus JPG, PNG, atau WEBP maksimal 1 MB." });
    }
    const serialized = JSON.stringify(settings);
    if (serialized.length > 1500000) {
      return res.status(413).json({ ok: false, error: "AI_BUSINESS_SETTINGS_TOO_LARGE" });
    }
    const profile = saveAIBusinessProfile(req.telegramId, req.sessionId, {
      settings,
      promptTemplate: req.body?.promptTemplate,
      intentConfig: req.body?.intentConfig,
      fallbackConfig: req.body?.fallbackConfig || {
        notAvailable: String(req.body?.fallbackMessage || "").slice(0, 500)
      }
    });
    res.setHeader("Cache-Control", "no-store");
    return res.json({ ok: true, profile });
  } catch (error) {
    return sendServerError(res, error, "Could not save WAGRAM AI settings");
  }
});

/* [ADDED] Save owner-corrected answers as scoped few-shot examples for WAGRAM AI. */
router.post("/ai-business/examples", (req, res) => {
  try {
    const membership = getMembership(req.telegramId);
    if (membership?.plan !== "premium-c") {
      return res.status(403).json({ ok: false, error: "AI_BUSINESS_REQUIRES_PREMIUM_C" });
    }
    const question = String(req.body?.question || "").trim();
    const idealAnswer = String(req.body?.idealAnswer || "").trim();
    const intent = String(req.body?.intent || "").trim();
    if (!question || question.length > 4000 || !idealAnswer || idealAnswer.length > 2000) {
      return res.status(400).json({ ok: false, error: "INVALID_AI_BUSINESS_EXAMPLE" });
    }
    const id = addAIBusinessExample(req.telegramId, req.sessionId, {
      question,
      data: req.body?.data && typeof req.body.data === "object" ? req.body.data : {},
      idealAnswer,
      intent
    });
    return res.status(201).json({ ok: true, id });
  } catch (error) {
    return sendServerError(res, error, "Could not save WAGRAM AI learning example");
  }
});

/* [ADDED] Generate the next simulated customer message and save the owner's previous training answer. */
router.post("/ai-business/training-question", async (req, res) => {
  try {
    const membership = getMembership(req.telegramId);
    if (membership?.plan !== "premium-c") {
      return res.status(403).json({ ok: false, error: "AI_BUSINESS_REQUIRES_PREMIUM_C" });
    }
    const previousQuestion = String(req.body?.previousQuestion || "").trim();
    const ownerAnswer = String(req.body?.ownerAnswer || "").trim();
    if (previousQuestion.length > 4000 || ownerAnswer.length > 2000 || Boolean(previousQuestion) !== Boolean(ownerAnswer)) {
      return res.status(400).json({ ok: false, error: "INVALID_AI_BUSINESS_TRAINING_TURN" });
    }
    const result = await createAIBusinessTrainingQuestion(
      req.telegramId,
      req.sessionId,
      previousQuestion,
      ownerAnswer
    );
    res.setHeader("Cache-Control", "no-store");
    return res.json({ ok: true, ...result });
  } catch (error) {
    const status = error.status || 500;
    console.error("[WAGRAM AI Training] Request failed:", error.message);
    return res.status(status).json({ ok: false, error: error.message || "AI_BUSINESS_TRAINING_FAILED" });
  }
});

/* [ADDED] WAGRAM AI Business chat. Premium expiry is enforced server-side by getMembership(). */
router.post("/ai-business/chat", async (req, res) => {
  try {
    const message = String(req.body?.message || "").trim();
    if (!message || message.length > 4000) {
      return res.status(400).json({
        ok: false,
        error: "INVALID_AI_BUSINESS_MESSAGE",
        message: "Pesan wajib diisi dan maksimal 4.000 karakter."
      });
    }

    const membership = getMembership(req.telegramId);
    if (membership?.plan !== "premium-c") {
      return res.status(403).json({
        ok: false,
        error: "AI_BUSINESS_REQUIRES_PREMIUM_C",
        message: "WAGRAM AI Business hanya tersedia untuk Premium 30 hari."
      });
    }

    const result = await createAIBusinessReply(
      req.telegramId,
      req.sessionId,
      message,
      req.body?.history || []
    );
    res.setHeader("Cache-Control", "no-store");
    return res.json({ ok: true, ...result });
  } catch (error) {
    const status = error.status || 500;
    console.error("[WAGRAM AI Business] Request failed:", error.message);
    return res.status(status).json({
      ok: false,
      error: error.message || "AI_BUSINESS_FAILED",
      message: status === 403
        ? "WAGRAM AI Business membutuhkan Premium 30 hari yang masih aktif."
        : "WAGRAM AI belum dapat menjawab. Periksa konfigurasi OPENROUTER_API_KEY di VPS."
    });
  }
});

export default router;