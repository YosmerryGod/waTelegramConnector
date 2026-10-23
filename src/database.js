import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const databasePath = path.resolve(
  process.env.SQLITE_PATH || "./data/bridge.db"
);

fs.mkdirSync(path.dirname(databasePath), { recursive: true });

const db = new Database(databasePath);

db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");
db.pragma("foreign_keys = ON");
db.pragma("busy_timeout = 5000");

db.exec(`
  CREATE TABLE IF NOT EXISTS telegram_users (
    telegram_id TEXT PRIMARY KEY,
    username TEXT,
    first_name TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS whatsapp_sessions (
    telegram_id TEXT PRIMARY KEY,
    phone_number TEXT,
    connection_status TEXT NOT NULL DEFAULT 'disconnected',
    last_connected_at INTEGER,
    last_disconnected_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (telegram_id)
      REFERENCES telegram_users(telegram_id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS forwarded_messages (
    message_id TEXT NOT NULL,
    telegram_id TEXT NOT NULL,
    forwarded_at INTEGER NOT NULL,
    PRIMARY KEY (message_id, telegram_id),
    FOREIGN KEY (telegram_id)
      REFERENCES telegram_users(telegram_id) ON DELETE CASCADE
  );

  -- [ADDED] Daftar chat WhatsApp untuk Mini App.
  CREATE TABLE IF NOT EXISTS chats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id TEXT NOT NULL,
    whatsapp_chat_id TEXT NOT NULL,
    chat_type TEXT NOT NULL CHECK (chat_type IN ('private', 'group')),
    name TEXT,
    phone_number TEXT,
    is_favorite INTEGER NOT NULL DEFAULT 0,
    is_archived INTEGER NOT NULL DEFAULT 0,
    last_message_at INTEGER,
    last_message_preview TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (telegram_id, whatsapp_chat_id),
    FOREIGN KEY (telegram_id)
      REFERENCES telegram_users(telegram_id) ON DELETE CASCADE
  );

  -- [ADDED] Riwayat pesan WhatsApp.
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id TEXT NOT NULL,
    whatsapp_chat_id TEXT NOT NULL,
    whatsapp_message_id TEXT NOT NULL,
    sender_jid TEXT,
    sender_name TEXT,
    direction TEXT NOT NULL CHECK (direction IN ('incoming', 'outgoing')),
    message_type TEXT NOT NULL DEFAULT 'text',
    body TEXT,
    media_mimetype TEXT,
    media_file_name TEXT,
    message_timestamp INTEGER NOT NULL,
    miniapp_read_at INTEGER,
    created_at INTEGER NOT NULL,
    UNIQUE (telegram_id, whatsapp_chat_id, whatsapp_message_id),
    FOREIGN KEY (telegram_id, whatsapp_chat_id)
      REFERENCES chats(telegram_id, whatsapp_chat_id) ON DELETE CASCADE,
    FOREIGN KEY (telegram_id)
      REFERENCES telegram_users(telegram_id) ON DELETE CASCADE
  );

  -- [ADDED] Preferensi tiap chat.
  CREATE TABLE IF NOT EXISTS chat_preferences (
    telegram_id TEXT NOT NULL,
    whatsapp_chat_id TEXT NOT NULL,
    is_muted INTEGER NOT NULL DEFAULT 0,
    custom_name TEXT,
    last_read_message_id TEXT,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (telegram_id, whatsapp_chat_id),
    FOREIGN KEY (telegram_id, whatsapp_chat_id)
      REFERENCES chats(telegram_id, whatsapp_chat_id) ON DELETE CASCADE
  );

  -- [ADDED] Buku kontak pribadi (nama + nomor HP) per pengguna Telegram.
  CREATE TABLE IF NOT EXISTS contacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id TEXT NOT NULL,
    name TEXT NOT NULL,
    phone_number TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (telegram_id, phone_number),
    FOREIGN KEY (telegram_id)
      REFERENCES telegram_users(telegram_id) ON DELETE CASCADE
  );

  -- [ADDED] Riwayat panggilan WhatsApp (satu baris per panggilan).
  CREATE TABLE IF NOT EXISTS calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id TEXT NOT NULL,
    call_id TEXT NOT NULL,
    direction TEXT NOT NULL CHECK (direction IN ('incoming', 'outgoing')),
    status TEXT NOT NULL DEFAULT 'ringing'
      CHECK (status IN ('ringing', 'answered', 'missed', 'rejected', 'no_answer')),
    is_video INTEGER NOT NULL DEFAULT 0,
    is_group INTEGER NOT NULL DEFAULT 0,
    peer_jid TEXT,
    phone_number TEXT,
    call_timestamp INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (telegram_id, call_id),
    FOREIGN KEY (telegram_id)
      REFERENCES telegram_users(telegram_id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_contacts_owner_name
    ON contacts(telegram_id, name COLLATE NOCASE);

  CREATE INDEX IF NOT EXISTS idx_calls_owner_time
    ON calls(telegram_id, call_timestamp DESC);

  CREATE INDEX IF NOT EXISTS idx_forwarded_messages_time
    ON forwarded_messages(forwarded_at);

  CREATE INDEX IF NOT EXISTS idx_whatsapp_sessions_status
    ON whatsapp_sessions(connection_status);

  CREATE INDEX IF NOT EXISTS idx_chats_owner_last_message
    ON chats(telegram_id, last_message_at DESC);

  CREATE INDEX IF NOT EXISTS idx_messages_chat_timestamp
    ON messages(telegram_id, whatsapp_chat_id, message_timestamp DESC);

  CREATE INDEX IF NOT EXISTS idx_messages_owner_unread
    ON messages(telegram_id, miniapp_read_at, message_timestamp DESC);
`);

// [ADDED] Media columns for the Mini App. This must run before any
// statement is prepared, because "SELECT m.*" is expanded at prepare time.
const messageColumns = db
  .prepare("PRAGMA table_info(messages)")
  .all()
  .map((column) => column.name);

if (!messageColumns.includes("telegram_file_id")) {
  db.exec("ALTER TABLE messages ADD COLUMN telegram_file_id TEXT");
}

if (!messageColumns.includes("telegram_file_kind")) {
  db.exec("ALTER TABLE messages ADD COLUMN telegram_file_kind TEXT");
}

const statements = {
  upsertUser: db.prepare(`
    INSERT INTO telegram_users (
      telegram_id, username, first_name, created_at, updated_at, is_active
    )
    VALUES (
      @telegram_id, @username, @first_name, @now, @now, 1
    )
    ON CONFLICT(telegram_id) DO UPDATE SET
      username = excluded.username,
      first_name = excluded.first_name,
      updated_at = excluded.updated_at,
      is_active = 1
  `),

  getUser: db.prepare(`
    SELECT * FROM telegram_users WHERE telegram_id = ?
  `),

  getAllActiveUsers: db.prepare(`
    SELECT * FROM telegram_users
    WHERE is_active = 1
    ORDER BY created_at ASC
  `),

  setUserActive: db.prepare(`
    UPDATE telegram_users
    SET is_active = ?, updated_at = ?
    WHERE telegram_id = ?
  `),

  ensureSession: db.prepare(`
    INSERT INTO whatsapp_sessions (
      telegram_id, connection_status, created_at, updated_at
    )
    VALUES (?, 'disconnected', ?, ?)
    ON CONFLICT(telegram_id) DO NOTHING
  `),

  getSession: db.prepare(`
    SELECT * FROM whatsapp_sessions WHERE telegram_id = ?
  `),

  getAllSessions: db.prepare(`
    SELECT s.*, u.is_active
    FROM whatsapp_sessions s
    INNER JOIN telegram_users u ON u.telegram_id = s.telegram_id
    WHERE u.is_active = 1
    ORDER BY s.created_at ASC
  `),

  updateSession: db.prepare(`
    UPDATE whatsapp_sessions
    SET connection_status = @status,
        phone_number = COALESCE(@phone_number, phone_number),
        last_connected_at = CASE
          WHEN @status = 'connected' THEN @now
          ELSE last_connected_at
        END,
        last_disconnected_at = CASE
          WHEN @status = 'disconnected' THEN @now
          ELSE last_disconnected_at
        END,
        updated_at = @now
    WHERE telegram_id = @telegram_id
  `),

  disconnectSession: db.prepare(`
    UPDATE whatsapp_sessions
    SET connection_status = 'disconnected',
        last_disconnected_at = @now,
        updated_at = @now
    WHERE telegram_id = @telegram_id
  `),

  deleteSession: db.prepare(`
    DELETE FROM whatsapp_sessions WHERE telegram_id = ?
  `),

  insertForwardedMessage: db.prepare(`
    INSERT OR IGNORE INTO forwarded_messages (
      message_id, telegram_id, forwarded_at
    )
    VALUES (?, ?, ?)
  `),

  cleanupForwardedMessages: db.prepare(`
    DELETE FROM forwarded_messages WHERE forwarded_at < ?
  `),

  // [ADDED] Simpan atau perbarui informasi chat.
  upsertChat: db.prepare(`
    INSERT INTO chats (
      telegram_id,
      whatsapp_chat_id,
      chat_type,
      name,
      phone_number,
      last_message_at,
      last_message_preview,
      created_at,
      updated_at
    )
    VALUES (
      @telegram_id,
      @whatsapp_chat_id,
      @chat_type,
      @name,
      @phone_number,
      @last_message_at,
      @last_message_preview,
      @now,
      @now
    )
    ON CONFLICT(telegram_id, whatsapp_chat_id) DO UPDATE SET
      chat_type = excluded.chat_type,
      name = COALESCE(excluded.name, chats.name),
      phone_number = COALESCE(excluded.phone_number, chats.phone_number),
      last_message_at = CASE
        WHEN chats.last_message_at IS NULL
          OR excluded.last_message_at >= chats.last_message_at
        THEN excluded.last_message_at
        ELSE chats.last_message_at
      END,
      last_message_preview = CASE
        WHEN chats.last_message_at IS NULL
          OR excluded.last_message_at >= chats.last_message_at
        THEN excluded.last_message_preview
        ELSE chats.last_message_preview
      END,
      updated_at = excluded.updated_at
  `),

  // [ADDED] Simpan pesan tanpa menduplikasi ID yang sama.
  insertMessage: db.prepare(`
    INSERT OR IGNORE INTO messages (
      telegram_id,
      whatsapp_chat_id,
      whatsapp_message_id,
      sender_jid,
      sender_name,
      direction,
      message_type,
      body,
      media_mimetype,
      media_file_name,
      message_timestamp,
      created_at
    )
    VALUES (
      @telegram_id,
      @whatsapp_chat_id,
      @whatsapp_message_id,
      @sender_jid,
      @sender_name,
      @direction,
      @message_type,
      @body,
      @media_mimetype,
      @media_file_name,
      @message_timestamp,
      @now
    )
  `),

  updateChatPreview: db.prepare(`
    UPDATE chats
    SET last_message_at = @message_timestamp,
        last_message_preview = @preview,
        updated_at = @now
    WHERE telegram_id = @telegram_id
      AND whatsapp_chat_id = @whatsapp_chat_id
      AND (
        last_message_at IS NULL
        OR last_message_at <= @message_timestamp
      )
  `),

  listChats: db.prepare(`
    SELECT
      c.*,
      COALESCE(
        cp.custom_name,
        ct.name,
        c.name,
        c.phone_number,
        c.whatsapp_chat_id
      ) AS display_name,
      ct.name AS contact_name,
      COALESCE(cp.is_muted, 0) AS is_muted,
      (
        SELECT COUNT(*)
        FROM messages m
        WHERE m.telegram_id = c.telegram_id
          AND m.whatsapp_chat_id = c.whatsapp_chat_id
          AND m.direction = 'incoming'
          AND m.miniapp_read_at IS NULL
      ) AS unread_count
    FROM chats c
    LEFT JOIN chat_preferences cp
      ON cp.telegram_id = c.telegram_id
      AND cp.whatsapp_chat_id = c.whatsapp_chat_id
    LEFT JOIN contacts ct
      ON ct.telegram_id = c.telegram_id
      AND c.chat_type = 'private'
      AND ct.phone_number = COALESCE(
        c.phone_number,
        CASE WHEN c.whatsapp_chat_id LIKE '%@s.whatsapp.net'
          THEN substr(c.whatsapp_chat_id, 1, instr(c.whatsapp_chat_id, '@') - 1)
        END
      )
    WHERE c.telegram_id = @telegram_id
      AND (@include_archived = 1 OR c.is_archived = 0)
    ORDER BY c.is_favorite DESC, c.last_message_at DESC, c.id DESC
    LIMIT @limit OFFSET @offset
  `),

  getChat: db.prepare(`
    SELECT
      c.*,
      COALESCE(
        cp.custom_name,
        ct.name,
        c.name,
        c.phone_number,
        c.whatsapp_chat_id
      ) AS display_name,
      ct.name AS contact_name,
      COALESCE(cp.is_muted, 0) AS is_muted
    FROM chats c
    LEFT JOIN chat_preferences cp
      ON cp.telegram_id = c.telegram_id
      AND cp.whatsapp_chat_id = c.whatsapp_chat_id
    LEFT JOIN contacts ct
      ON ct.telegram_id = c.telegram_id
      AND c.chat_type = 'private'
      AND ct.phone_number = COALESCE(
        c.phone_number,
        CASE WHEN c.whatsapp_chat_id LIKE '%@s.whatsapp.net'
          THEN substr(c.whatsapp_chat_id, 1, instr(c.whatsapp_chat_id, '@') - 1)
        END
      )
    WHERE c.telegram_id = ?
      AND c.whatsapp_chat_id = ?
  `),

  listMessages: db.prepare(`
    SELECT m.*, ct.name AS contact_name
    FROM messages m
    LEFT JOIN contacts ct
      ON ct.telegram_id = m.telegram_id
      AND ct.phone_number = CASE
        WHEN m.sender_jid LIKE '%@s.whatsapp.net'
          THEN substr(m.sender_jid, 1, instr(m.sender_jid, '@') - 1)
      END
    WHERE m.telegram_id = ?
      AND m.whatsapp_chat_id = ?
    ORDER BY m.message_timestamp DESC, m.id DESC
    LIMIT ?
  `),

  // [ADDED] Status baca lokal Mini App, bukan tanda baca WhatsApp.
  markChatRead: db.prepare(`
    UPDATE messages
    SET miniapp_read_at = ?
    WHERE telegram_id = ?
      AND whatsapp_chat_id = ?
      AND direction = 'incoming'
      AND miniapp_read_at IS NULL
  `),

  setChatFavorite: db.prepare(`
    UPDATE chats
    SET is_favorite = ?, updated_at = ?
    WHERE telegram_id = ? AND whatsapp_chat_id = ?
  `),

  setChatArchived: db.prepare(`
    UPDATE chats
    SET is_archived = ?, updated_at = ?
    WHERE telegram_id = ? AND whatsapp_chat_id = ?
  `),

  upsertChatPreference: db.prepare(`
    INSERT INTO chat_preferences (
      telegram_id,
      whatsapp_chat_id,
      is_muted,
      custom_name,
      last_read_message_id,
      updated_at
    )
    VALUES (
      @telegram_id,
      @whatsapp_chat_id,
      COALESCE(@is_muted, 0),
      @custom_name,
      @last_read_message_id,
      @updated_at
    )
    ON CONFLICT(telegram_id, whatsapp_chat_id) DO UPDATE SET
      is_muted = COALESCE(@is_muted, chat_preferences.is_muted),
      custom_name = COALESCE(@custom_name, chat_preferences.custom_name),
      last_read_message_id = COALESCE(
        @last_read_message_id,
        chat_preferences.last_read_message_id
      ),
      updated_at = excluded.updated_at
  `)
};

// ---------------------------------------------------------------------------
// Existing user and session functions
// ---------------------------------------------------------------------------

export function registerUser(user) {
  const now = Date.now();
  const telegramId = String(user.id);

  db.transaction(() => {
    statements.upsertUser.run({
      telegram_id: telegramId,
      username: user.username || null,
      first_name: user.first_name || null,
      now
    });

    statements.ensureSession.run(telegramId, now, now);
  })();

  return statements.getUser.get(telegramId);
}

export function getUser(telegramId) {
  return statements.getUser.get(String(telegramId)) || null;
}

export function getAllActiveUsers() {
  return statements.getAllActiveUsers.all();
}

export function setUserActive(telegramId, isActive) {
  return statements.setUserActive.run(
    isActive ? 1 : 0,
    Date.now(),
    String(telegramId)
  ).changes > 0;
}

export function getSession(telegramId) {
  return statements.getSession.get(String(telegramId)) || null;
}

export function getAllSessions() {
  return statements.getAllSessions.all();
}

export function updateSession(telegramId, status, phoneNumber = null) {
  const allowedStatuses = new Set([
    "disconnected",
    "connecting",
    "connected",
    "qr",
    "logged_out"
  ]);

  if (!allowedStatuses.has(status)) {
    throw new Error(`Invalid WhatsApp connection status: ${status}`);
  }

  const now = Date.now();

  statements.ensureSession.run(String(telegramId), now, now);

  statements.updateSession.run({
    telegram_id: String(telegramId),
    status,
    phone_number: phoneNumber,
    now
  });

  return getSession(telegramId);
}

export function markSessionDisconnected(telegramId) {
  const now = Date.now();

  statements.ensureSession.run(String(telegramId), now, now);

  statements.disconnectSession.run({
    telegram_id: String(telegramId),
    now
  });

  return getSession(telegramId);
}

export function deleteSession(telegramId) {
  return statements.deleteSession.run(String(telegramId)).changes > 0;
}

export function reserveForwardedMessage(messageId, telegramId) {
  return statements.insertForwardedMessage.run(
    String(messageId),
    String(telegramId),
    Date.now()
  ).changes > 0;
}

export function cleanupForwardedMessages(
  maxAgeMs = 7 * 24 * 60 * 60 * 1000
) {
  return statements.cleanupForwardedMessages.run(
    Date.now() - maxAgeMs
  ).changes;
}

// ---------------------------------------------------------------------------
// [ADDED] Mini App message and chat functions
// ---------------------------------------------------------------------------

// Simpan pesan WhatsApp beserta metadata chat.
export function saveWhatsAppMessage(input) {
  const telegramId = String(input.telegramId ?? "");
  const whatsappChatId = String(input.whatsappChatId ?? "");
  const messageId = String(input.messageId ?? "");

  if (!/^\d+$/.test(telegramId)) {
    throw new Error("Invalid Telegram user ID.");
  }

  if (!whatsappChatId || !messageId) {
    throw new Error("WhatsApp chat ID and message ID are required.");
  }

  if (!["private", "group"].includes(input.chatType)) {
    throw new Error("Invalid chat type.");
  }

  if (!["incoming", "outgoing"].includes(input.direction)) {
    throw new Error("Invalid message direction.");
  }

  const now = Date.now();
  const timestamp = Number(input.messageTimestamp) || now;
  const body = input.body == null ? null : String(input.body);

  const preview = (body || `[${input.messageType || "message"}]`)
    .replace(/\s+/g, " ")
    .slice(0, 240);

  return db.transaction(() => {
    statements.upsertChat.run({
      telegram_id: telegramId,
      whatsapp_chat_id: whatsappChatId,
      chat_type: input.chatType,
      name: input.chatName || null,
      phone_number: input.phoneNumber || null,
      last_message_at: timestamp,
      last_message_preview: preview,
      now
    });

    const result = statements.insertMessage.run({
      telegram_id: telegramId,
      whatsapp_chat_id: whatsappChatId,
      whatsapp_message_id: messageId,
      sender_jid: input.senderJid || null,
      sender_name: input.senderName || null,
      direction: input.direction,
      message_type: input.messageType || "text",
      body,
      media_mimetype: input.mediaMimetype || null,
      media_file_name: input.mediaFileName || null,
      message_timestamp: timestamp,
      now
    });

    if (result.changes > 0) {
      statements.updateChatPreview.run({
        telegram_id: telegramId,
        whatsapp_chat_id: whatsappChatId,
        message_timestamp: timestamp,
        preview,
        now
      });
    }

    return result.changes > 0;
  })();
}

// Ambil daftar chat milik satu pengguna Telegram.
export function listChats(telegramId, options = {}) {
  const limit = Math.min(100, Math.max(1, Number(options.limit) || 50));
  const offset = Math.max(0, Number(options.offset) || 0);

  return statements.listChats.all({
    telegram_id: String(telegramId),
    include_archived: options.includeArchived ? 1 : 0,
    limit,
    offset
  });
}

// Ambil satu chat milik pengguna yang ditentukan.
export function getChat(telegramId, whatsappChatId) {
  return statements.getChat.get(
    String(telegramId),
    String(whatsappChatId)
  ) || null;
}

// Ambil pesan dari satu chat, dimulai dari yang terbaru.
export function listMessages(telegramId, whatsappChatId, limit = 100) {
  if (!getChat(telegramId, whatsappChatId)) {
    return [];
  }

  const safeLimit = Math.min(200, Math.max(1, Number(limit) || 100));

  return statements.listMessages.all(
    String(telegramId),
    String(whatsappChatId),
    safeLimit
  );
}

// Tandai pesan dibaca di Mini App saja.
export function markChatReadInMiniApp(telegramId, whatsappChatId) {
  if (!getChat(telegramId, whatsappChatId)) {
    return 0;
  }

  return statements.markChatRead.run(
    Date.now(),
    String(telegramId),
    String(whatsappChatId)
  ).changes;
}

// Tandai atau lepaskan favorit chat.
export function setChatFavorite(telegramId, whatsappChatId, isFavorite) {
  return statements.setChatFavorite.run(
    isFavorite ? 1 : 0,
    Date.now(),
    String(telegramId),
    String(whatsappChatId)
  ).changes > 0;
}

// Arsipkan atau keluarkan chat dari arsip.
export function setChatArchived(telegramId, whatsappChatId, isArchived) {
  return statements.setChatArchived.run(
    isArchived ? 1 : 0,
    Date.now(),
    String(telegramId),
    String(whatsappChatId)
  ).changes > 0;
}

// Perbarui preferensi chat. Nilai null tidak mengubah nilai sebelumnya.
export function updateChatPreferences(
  telegramId,
  whatsappChatId,
  preferences = {}
) {
  if (!getChat(telegramId, whatsappChatId)) {
    return false;
  }

  statements.upsertChatPreference.run({
    telegram_id: String(telegramId),
    whatsapp_chat_id: String(whatsappChatId),
    is_muted: preferences.isMuted == null
      ? null
      : (preferences.isMuted ? 1 : 0),
    custom_name: preferences.customName == null
      ? null
      : String(preferences.customName).slice(0, 120),
    last_read_message_id: preferences.lastReadMessageId == null
      ? null
      : String(preferences.lastReadMessageId),
    updated_at: Date.now()
  });

  return true;
}

// ---------------------------------------------------------------------------
// [ADDED] Contacts and call history
// ---------------------------------------------------------------------------

const DEFAULT_COUNTRY_CODE =
  String(process.env.DEFAULT_COUNTRY_CODE || "62").replace(/\D/g, "") || "62";

const MAX_CONTACTS_PER_USER = 2000;

// Error yang aman ditampilkan ke pengguna (input tidak valid, duplikat, dll).
export class ValidationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ValidationError";
    this.code = code;
  }
}

// Ubah nomor ke format internasional tanpa "+": 0812... -> 62812...
// Mengembalikan null jika nomor tidak valid (8-15 digit).
export function normalizePhoneNumber(input) {
  const raw = String(input ?? "").trim();
  let digits = raw.replace(/\D/g, "");

  if (!digits) {
    return null;
  }

  if (!raw.startsWith("+")) {
    if (digits.startsWith("00")) {
      digits = digits.slice(2);
    } else if (digits.startsWith("0")) {
      digits = DEFAULT_COUNTRY_CODE + digits.slice(1);
    }
  }

  return /^[1-9]\d{7,14}$/.test(digits) ? digits : null;
}

function normalizeContactName(input) {
  const name = String(input ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);

  return name || null;
}

function validateContactInput({ name, phone }) {
  const cleanName = normalizeContactName(name);
  const cleanPhone = normalizePhoneNumber(phone);

  if (!cleanName) {
    throw new ValidationError("INVALID_NAME", "Contact name is required.");
  }

  if (!cleanPhone) {
    throw new ValidationError("INVALID_PHONE", "Phone number is not valid.");
  }

  return { cleanName, cleanPhone };
}

const contactStatements = {
  getById: db.prepare(`
    SELECT * FROM contacts WHERE telegram_id = ? AND id = ?
  `),

  getByPhone: db.prepare(`
    SELECT * FROM contacts WHERE telegram_id = ? AND phone_number = ?
  `),

  count: db.prepare(`
    SELECT COUNT(*) AS total FROM contacts WHERE telegram_id = ?
  `),

  insert: db.prepare(`
    INSERT INTO contacts (
      telegram_id, name, phone_number, created_at, updated_at
    )
    VALUES (@telegram_id, @name, @phone_number, @now, @now)
  `),

  update: db.prepare(`
    UPDATE contacts
    SET name = @name,
        phone_number = @phone_number,
        updated_at = @now
    WHERE telegram_id = @telegram_id AND id = @id
  `),

  remove: db.prepare(`
    DELETE FROM contacts WHERE telegram_id = ? AND id = ?
  `),

  removeByPhone: db.prepare(`
    DELETE FROM contacts WHERE telegram_id = ? AND phone_number = ?
  `),

  list: db.prepare(`
    SELECT * FROM contacts
    WHERE telegram_id = ?
    ORDER BY name COLLATE NOCASE ASC, id ASC
    LIMIT ?
  `)
};

const callStatements = {
  // Satu baris per panggilan. Status hanya berubah dari 'ringing'
  // ke status akhir, sehingga event ganda dari Baileys tidak menimpa hasil.
  upsert: db.prepare(`
    INSERT INTO calls (
      telegram_id, call_id, direction, status, is_video, is_group,
      peer_jid, phone_number, call_timestamp, created_at, updated_at
    )
    VALUES (
      @telegram_id, @call_id, @direction, @status, @is_video, @is_group,
      @peer_jid, @phone_number, @call_timestamp, @now, @now
    )
    ON CONFLICT(telegram_id, call_id) DO UPDATE SET
      status = CASE
        WHEN calls.status = 'ringing' THEN excluded.status
        ELSE calls.status
      END,
      phone_number = COALESCE(calls.phone_number, excluded.phone_number),
      peer_jid = COALESCE(calls.peer_jid, excluded.peer_jid),
      updated_at = excluded.updated_at
  `),

  list: db.prepare(`
    SELECT
      c.*,
      ct.id AS contact_id,
      ct.name AS contact_name,
      COALESCE(
        ct.name,
        CASE WHEN c.phone_number IS NOT NULL
          THEN '+' || c.phone_number
        END,
        'Nomor tidak diketahui'
      ) AS display_name,
      CASE WHEN ct.id IS NULL THEN 0 ELSE 1 END AS is_saved
    FROM calls c
    LEFT JOIN contacts ct
      ON ct.telegram_id = c.telegram_id
      AND ct.phone_number = c.phone_number
    WHERE c.telegram_id = @telegram_id
    ORDER BY c.call_timestamp DESC, c.id DESC
    LIMIT @limit OFFSET @offset
  `)
};

// Simpan kontak baru. Jika nomor sudah ada, nama diperbarui.
export function saveContact(telegramId, { name, phone }) {
  const id = String(telegramId);
  const { cleanName, cleanPhone } = validateContactInput({ name, phone });

  return db.transaction(() => {
    const existing = contactStatements.getByPhone.get(id, cleanPhone);
    const now = Date.now();

    if (existing) {
      contactStatements.update.run({
        telegram_id: id,
        id: existing.id,
        name: cleanName,
        phone_number: cleanPhone,
        now
      });
    } else {
      if (contactStatements.count.get(id).total >= MAX_CONTACTS_PER_USER) {
        throw new ValidationError(
          "CONTACT_LIMIT",
          "Contact limit reached."
        );
      }

      contactStatements.insert.run({
        telegram_id: id,
        name: cleanName,
        phone_number: cleanPhone,
        now
      });
    }

    return {
      created: !existing,
      contact: contactStatements.getByPhone.get(id, cleanPhone)
    };
  })();
}

// Ubah nama/nomor kontak. Mengembalikan null jika kontak tidak ditemukan.
export function updateContact(telegramId, contactId, { name, phone }) {
  const id = String(telegramId);
  const rowId = Number.parseInt(contactId, 10);
  const { cleanName, cleanPhone } = validateContactInput({ name, phone });

  if (!Number.isInteger(rowId) || !contactStatements.getById.get(id, rowId)) {
    return null;
  }

  const duplicate = contactStatements.getByPhone.get(id, cleanPhone);

  if (duplicate && duplicate.id !== rowId) {
    throw new ValidationError(
      "DUPLICATE_PHONE",
      "This number is already saved as another contact."
    );
  }

  contactStatements.update.run({
    telegram_id: id,
    id: rowId,
    name: cleanName,
    phone_number: cleanPhone,
    now: Date.now()
  });

  return contactStatements.getById.get(id, rowId);
}

export function deleteContact(telegramId, contactId) {
  const rowId = Number.parseInt(contactId, 10);

  if (!Number.isInteger(rowId)) {
    return false;
  }

  return contactStatements.remove.run(String(telegramId), rowId).changes > 0;
}

export function deleteContactByPhone(telegramId, phone) {
  const cleanPhone = normalizePhoneNumber(phone);

  if (!cleanPhone) {
    return false;
  }

  return contactStatements.removeByPhone.run(
    String(telegramId),
    cleanPhone
  ).changes > 0;
}

export function listContacts(telegramId, limit = 1000) {
  const safeLimit = Math.min(2000, Math.max(1, Number(limit) || 1000));

  return contactStatements.list.all(String(telegramId), safeLimit);
}

// Catat event panggilan WhatsApp. Aman dipanggil berulang untuk call_id sama.
export function recordCall(input) {
  const telegramId = String(input.telegramId ?? "");
  const callId = String(input.callId ?? "");

  if (!/^\d+$/.test(telegramId) || !callId) {
    throw new Error("Telegram ID and call ID are required.");
  }

  if (!["incoming", "outgoing"].includes(input.direction)) {
    throw new Error("Invalid call direction.");
  }

  if (!["ringing", "answered", "missed", "rejected", "no_answer"]
    .includes(input.status)) {
    throw new Error("Invalid call status.");
  }

  const now = Date.now();
  const timestamp = Number(input.timestampMs);

  callStatements.upsert.run({
    telegram_id: telegramId,
    call_id: callId,
    direction: input.direction,
    status: input.status,
    is_video: input.isVideo ? 1 : 0,
    is_group: input.isGroup ? 1 : 0,
    peer_jid: input.peerJid || null,
    phone_number: normalizePhoneNumber(input.phoneNumber),
    call_timestamp: Number.isFinite(timestamp) && timestamp > 0
      ? timestamp
      : now,
    now
  });
}

export function listCalls(telegramId, options = {}) {
  return callStatements.list.all({
    telegram_id: String(telegramId),
    limit: Math.min(200, Math.max(1, Number(options.limit) || 100)),
    offset: Math.max(0, Number(options.offset) || 0)
  });
}

// ---------------------------------------------------------------------------
// [ADDED] Media for the Mini App
// Files are not stored locally: we keep the Telegram file_id of the copy
// that the bot already forwarded, and the API streams it on demand.
// ---------------------------------------------------------------------------

const mediaStatements = {
  attach: db.prepare(`
    UPDATE messages
    SET telegram_file_id = @file_id,
        telegram_file_kind = @kind
    WHERE telegram_id = @telegram_id
      AND whatsapp_chat_id = @chat_id
      AND whatsapp_message_id = @message_id
  `),

  get: db.prepare(`
    SELECT id, telegram_file_id, telegram_file_kind,
           media_mimetype, media_file_name
    FROM messages
    WHERE telegram_id = ? AND id = ?
  `)
};

// Remember which Telegram file holds the media of a WhatsApp message.
export function attachTelegramFile({
  telegramId,
  whatsappChatId,
  messageId,
  fileId,
  kind
}) {
  if (!fileId || !messageId) {
    return false;
  }

  return mediaStatements.attach.run({
    telegram_id: String(telegramId),
    chat_id: String(whatsappChatId),
    message_id: String(messageId),
    file_id: String(fileId),
    kind: kind || null
  }).changes > 0;
}

// Only returns media that belongs to this Telegram user.
export function getMessageMedia(telegramId, messageRowId) {
  return mediaStatements.get.get(String(telegramId), Number(messageRowId)) || null;
}

// Saved contact name for a phone number (null if not saved).
export function findContactName(telegramId, phone) {
  const cleanPhone = normalizePhoneNumber(phone);

  if (!cleanPhone) {
    return null;
  }

  const row = contactStatements.getByPhone.get(String(telegramId), cleanPhone);

  return row ? row.name : null;
}

// Tutup database saat aplikasi berhenti.
export function closeDatabase() {
  if (db.open) {
    db.close();
  }
}

export default db;