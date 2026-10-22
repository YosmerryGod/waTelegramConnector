// src/miniapp-api.js
// [ADDED] REST API for WhatsApp Mini App.
// Mini App read status is local only and never sends WhatsApp read receipts.

import express from "express";
import crypto from "node:crypto";

import {
  getUser,
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
  listCalls
} from "./database.js";

const router = express.Router();

const MAX_LIMIT = 100;
const MAX_MESSAGES = 200;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

// ---------------------------------------------------------------------------
// Telegram Mini App authentication
// ---------------------------------------------------------------------------

// [ADDED] Verify Telegram Web App initData on the server.
// Do not trust initDataUnsafe.user.id from the frontend.
function verifyTelegramInitData(initData) {
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

    const limit = parseLimit(req.query.limit, 100, MAX_MESSAGES);

    // The database returns newest-first; reverse for chronological display.
    const messages = listMessages(
      req.telegramId,
      chatId,
      limit
    ).reverse();

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
      const name = String(chat.name || "").toLowerCase();
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
            ...message,
            chat_name: chat.name
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

    const calls = listCalls(req.telegramId, { limit, offset });

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

export default router;