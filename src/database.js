import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
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
  -- [ADDED] Cached WhatsApp profile metadata, isolated per Telegram account.
  CREATE TABLE IF NOT EXISTS whatsapp_profile_cache (
    telegram_id TEXT NOT NULL,
    whatsapp_jid TEXT NOT NULL,
    display_name TEXT,
    about_text TEXT,
    picture_url TEXT,
    status_set_at INTEGER,
    fetched_at INTEGER NOT NULL,
    PRIMARY KEY (telegram_id, whatsapp_jid),
    FOREIGN KEY (telegram_id)
      REFERENCES telegram_users(telegram_id) ON DELETE CASCADE
  );

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

// [ADDED] Role and membership fields; existing accounts remain Free by default.
const telegramUserColumns = db
  .prepare("PRAGMA table_info(telegram_users)")
  .all()
  .map((column) => column.name);

if (!telegramUserColumns.includes("role")) {
  db.exec("ALTER TABLE telegram_users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'");
}
if (!telegramUserColumns.includes("plan")) {
  db.exec("ALTER TABLE telegram_users ADD COLUMN plan TEXT NOT NULL DEFAULT 'free'");
}
if (!telegramUserColumns.includes("plan_expires_at")) {
  db.exec("ALTER TABLE telegram_users ADD COLUMN plan_expires_at INTEGER");
}
if (!telegramUserColumns.includes("plan_updated_at")) {
  db.exec("ALTER TABLE telegram_users ADD COLUMN plan_updated_at INTEGER");
}

// [ADDED] Free-tier daily pause tracking (Asia/Makassar / WITA).
const whatsappSessionColumns = db
  .prepare("PRAGMA table_info(whatsapp_sessions)")
  .all()
  .map((column) => column.name);

if (!whatsappSessionColumns.includes("free_pause_date")) {
  db.exec("ALTER TABLE whatsapp_sessions ADD COLUMN free_pause_date TEXT");
}

// [ADDED] Independent WhatsApp accounts per Telegram user, with legacy-session migration.
db.exec(`
  CREATE TABLE IF NOT EXISTS whatsapp_accounts (
    session_id TEXT PRIMARY KEY,
    telegram_id TEXT NOT NULL,
    label TEXT,
    phone_number TEXT,
    connection_status TEXT NOT NULL DEFAULT 'disconnected'
      CHECK (connection_status IN ('disconnected', 'connecting', 'connected', 'qr', 'logged_out', 'paused')),
    is_primary INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (telegram_id)
      REFERENCES telegram_users(telegram_id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_whatsapp_accounts_owner
    ON whatsapp_accounts(telegram_id, created_at ASC);
`);

db.exec(`
  INSERT OR IGNORE INTO whatsapp_accounts (
    session_id, telegram_id, phone_number, connection_status,
    is_primary, created_at, updated_at
  )
  SELECT telegram_id, telegram_id, phone_number, connection_status,
         1, created_at, updated_at
  FROM whatsapp_sessions;
`);

// [ADDED] Persist the administrator's Free-tier pause mode across restarts.
db.exec(`
  CREATE TABLE IF NOT EXISTS app_settings (
    setting_key TEXT PRIMARY KEY,
    setting_value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
`);

// [ADDED] Persistent, owner/session-scoped WAGRAM AI business configuration and feedback examples.
db.exec(`
  CREATE TABLE IF NOT EXISTS ai_business_profiles (
    telegram_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    settings_json TEXT NOT NULL DEFAULT '{}',
    prompt_template TEXT NOT NULL DEFAULT '',
    intent_config_json TEXT NOT NULL DEFAULT '[]',
    fallback_config_json TEXT NOT NULL DEFAULT '{}',
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (telegram_id, session_id),
    FOREIGN KEY (telegram_id) REFERENCES telegram_users(telegram_id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS ai_business_examples (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    question TEXT NOT NULL,
    data_json TEXT NOT NULL DEFAULT '{}',
    ideal_answer TEXT NOT NULL,
    intent TEXT,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (telegram_id) REFERENCES telegram_users(telegram_id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_ai_business_examples_owner
    ON ai_business_examples(telegram_id, session_id, created_at DESC);
`);

// [ADDED] Keep Premium payment order schema in a separate SQLite statement.
db.exec(`
  CREATE TABLE IF NOT EXISTS premium_payment_orders (
    id TEXT PRIMARY KEY,
    telegram_id TEXT NOT NULL,
    plan_period TEXT NOT NULL CHECK (plan_period IN ('3d', '7d', '30d')),
    base_amount INTEGER NOT NULL,
    unique_code INTEGER NOT NULL CHECK (unique_code BETWEEN 100 AND 999),
    amount INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    FOREIGN KEY (telegram_id)
      REFERENCES telegram_users(telegram_id) ON DELETE CASCADE
  );
`);

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_premium_orders_owner
    ON premium_payment_orders(telegram_id, created_at DESC);

  CREATE INDEX IF NOT EXISTS idx_premium_orders_pending_amount
    ON premium_payment_orders(amount, status, expires_at);
`);

// [ADDED] Track whether the user has reported a completed payment.
const premiumOrderColumns = db
  .prepare("PRAGMA table_info(premium_payment_orders)")
  .all()
  .map((column) => column.name);

if (!premiumOrderColumns.includes("payment_reported_at")) {
  db.exec("ALTER TABLE premium_payment_orders ADD COLUMN payment_reported_at INTEGER");
}

export function getPremiumPaymentOrder(telegramId, orderId) {
  return db.prepare(`
    SELECT * FROM premium_payment_orders
    WHERE id = ? AND telegram_id = ?
    LIMIT 1
  `).get(String(orderId), String(telegramId)) || null;
}

// [ADDED] Admin lookup and one-time review decision for Premium payment orders.
export function getPremiumPaymentOrderById(orderId) {
  return db.prepare(`
    SELECT * FROM premium_payment_orders
    WHERE id = ?
    LIMIT 1
  `).get(String(orderId)) || null;
}

export function reviewPremiumPaymentOrder(orderId, decision) {
  if (!["approved", "rejected"].includes(decision)) {
    throw new Error("INVALID_PREMIUM_PAYMENT_DECISION");
  }
  const result = db.prepare(`
    UPDATE premium_payment_orders
    SET status = ?
    WHERE id = ? AND status = 'pending' AND payment_reported_at IS NOT NULL
  `).run(decision, String(orderId));
  return result.changes > 0 ? getPremiumPaymentOrderById(orderId) : null;
}

export function markPremiumPaymentReported(telegramId, orderId) {
  const now = Date.now();
  const result = db.prepare(`
    UPDATE premium_payment_orders
    SET payment_reported_at = ?
    WHERE id = ?
      AND telegram_id = ?
      AND status = 'pending'
      AND expires_at > ?
      AND payment_reported_at IS NULL
  `).run(now, String(orderId), String(telegramId), now);
  return result.changes > 0;
}



const configuredAdminIds = String(
  process.env.ADMIN_TELEGRAM_IDS || "6838814141"
).split(",").map((id) => id.trim()).filter((id) => /^\d+$/.test(id));

if (configuredAdminIds.length > 0) {
  const promoteAdmin = db.prepare(`
    UPDATE telegram_users
    SET role = 'admin', updated_at = ?
    WHERE telegram_id = ?
  `);
  for (const adminId of configuredAdminIds) {
    promoteAdmin.run(Date.now(), adminId);
  }
}

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

if (!messageColumns.includes("media_storage_path")) {
  db.exec("ALTER TABLE messages ADD COLUMN media_storage_path TEXT");
}

// [ADDED] Persist WhatsApp revoke state without resetting existing message history.
if (!messageColumns.includes("is_deleted")) {
  db.exec("ALTER TABLE messages ADD COLUMN is_deleted INTEGER NOT NULL DEFAULT 0");
}

// [ADDED] Retain original protobuf content for encrypted edit decryption and scoped retry lookup.
if (!messageColumns.includes("message_content")) {
  db.exec("ALTER TABLE messages ADD COLUMN message_content TEXT");
}

// [ADDED] Track edits independently from message deletion.
if (!messageColumns.includes("is_edited")) {
  db.exec("ALTER TABLE messages ADD COLUMN is_edited INTEGER NOT NULL DEFAULT 0");
}

// [ADDED] Preserve the first pre-edit text so users can expand it in the conversation.
if (!messageColumns.includes("original_body")) {
  db.exec("ALTER TABLE messages ADD COLUMN original_body TEXT");
}

// [ADDED] Migrate existing profile-cache databases before preparing queries.
const profileCacheColumns = db
  .prepare("PRAGMA table_info(whatsapp_profile_cache)")
  .all()
  .map((column) => column.name);

if (!profileCacheColumns.includes("picture_url")) {
  db.exec("ALTER TABLE whatsapp_profile_cache ADD COLUMN picture_url TEXT");
}

if (!profileCacheColumns.includes("about_text")) {
  db.exec("ALTER TABLE whatsapp_profile_cache ADD COLUMN about_text TEXT");
}

if (!profileCacheColumns.includes("status_set_at")) {
  db.exec("ALTER TABLE whatsapp_profile_cache ADD COLUMN status_set_at INTEGER");
}

// [ADDED] Independent favorite/archive flags for individual call-history records.
const callColumns = db
  .prepare("PRAGMA table_info(calls)")
  .all()
  .map((column) => column.name);

if (!callColumns.includes("is_favorite")) {
  db.exec("ALTER TABLE calls ADD COLUMN is_favorite INTEGER NOT NULL DEFAULT 0");
}

if (!callColumns.includes("is_archived")) {
  db.exec("ALTER TABLE calls ADD COLUMN is_archived INTEGER NOT NULL DEFAULT 0");
}

// [ADDED] Keep legacy primary-session keys intact while namespacing extra accounts.
function scopeSessionKey(telegramId, sessionId, value) {
  const ownerId = String(telegramId);
  const accountId = String(sessionId || ownerId);
  const rawValue = String(value ?? "");
  return accountId === ownerId ? rawValue : `${accountId}::${rawValue}`;
}

function unScopeSessionKey(telegramId, sessionId, value) {
  const ownerId = String(telegramId);
  const accountId = String(sessionId || ownerId);
  const prefix = accountId === ownerId ? "" : `${accountId}::`;
  const rawValue = String(value ?? "");
  return prefix && rawValue.startsWith(prefix) ? rawValue.slice(prefix.length) : rawValue;
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
      message_content,
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
      @message_content,
      @now
    )
  `),

  // [ADDED] Update the original message body after a WhatsApp edit event.
  updateEditedMessage: db.prepare(`
    UPDATE messages
    SET original_body = COALESCE(original_body, body),
        body = ?,
        is_edited = 1
    WHERE telegram_id = ?
      AND whatsapp_chat_id = ?
      AND whatsapp_message_id = ?
      AND is_deleted = 0
  `),

  // [ADDED] Retrieve original content only when owner, chat, message ID, and direction match.
  getMessageContent: db.prepare(`
    SELECT message_content
    FROM messages
    WHERE telegram_id = ?
      AND whatsapp_chat_id = ?
      AND whatsapp_message_id = ?
      AND direction = ?
    LIMIT 1
  `),

  // [ADDED] Mark a stored WhatsApp message as revoked while preserving its body.
  markMessageDeleted: db.prepare(`
    UPDATE messages
    SET is_deleted = 1
    WHERE telegram_id = ?
      AND whatsapp_chat_id = ?
      AND whatsapp_message_id = ?
      AND is_deleted = 0
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
      wpc.picture_url AS profile_picture_url,
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
    LEFT JOIN whatsapp_profile_cache wpc
      ON wpc.telegram_id = c.telegram_id
      AND wpc.whatsapp_jid = c.whatsapp_chat_id
    LEFT JOIN contacts ct
      ON ct.telegram_id = c.telegram_id
      AND c.chat_type = 'private'
      AND ct.phone_number = (
        CASE WHEN instr(c.whatsapp_chat_id, '::') > 0
          THEN substr(c.whatsapp_chat_id, 1, instr(c.whatsapp_chat_id, '::') - 1) || '::'
          ELSE ''
        END
      ) || COALESCE(
        c.phone_number,
        CASE WHEN c.whatsapp_chat_id LIKE '%@s.whatsapp.net'
          THEN substr(c.whatsapp_chat_id, 1, instr(c.whatsapp_chat_id, '@') - 1)
        END
      )
    WHERE c.telegram_id = @telegram_id
      AND (
        (@session_id = @telegram_id AND instr(c.whatsapp_chat_id, '::') = 0)
        OR (@session_id != @telegram_id AND c.whatsapp_chat_id LIKE @session_id || '::%')
      )
      AND (@include_archived = 1 OR c.is_archived = 0)
    ORDER BY c.is_favorite DESC, c.last_message_at DESC, c.id DESC
    LIMIT @limit OFFSET @offset
  `),

  getChat: db.prepare(`
    SELECT
      c.*,
      wpc.picture_url AS profile_picture_url,
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
    LEFT JOIN whatsapp_profile_cache wpc
      ON wpc.telegram_id = c.telegram_id
      AND wpc.whatsapp_jid = c.whatsapp_chat_id
    LEFT JOIN contacts ct
      ON ct.telegram_id = c.telegram_id
      AND c.chat_type = 'private'
      AND ct.phone_number = (
        CASE WHEN instr(c.whatsapp_chat_id, '::') > 0
          THEN substr(c.whatsapp_chat_id, 1, instr(c.whatsapp_chat_id, '::') - 1) || '::'
          ELSE ''
        END
      ) || COALESCE(
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
      AND ct.phone_number = (
        CASE WHEN instr(m.whatsapp_chat_id, '::') > 0
          THEN substr(m.whatsapp_chat_id, 1, instr(m.whatsapp_chat_id, '::') - 1) || '::'
          ELSE ''
        END
      ) || CASE
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

    // [ADDED] Ensure every Telegram account has its legacy primary WhatsApp account.
    db.prepare(`
      INSERT OR IGNORE INTO whatsapp_accounts (
        session_id, telegram_id, connection_status, is_primary, created_at, updated_at
      )
      VALUES (?, ?, 'disconnected', 1, ?, ?)
    `).run(telegramId, telegramId, now, now);

    // [ADDED] Keep configured administrators promoted when they register via /start.
    if (configuredAdminIds.includes(telegramId)) {
      db.prepare(`
        UPDATE telegram_users
        SET role = 'admin', updated_at = ?
        WHERE telegram_id = ?
      `).run(now, telegramId);
    }
  })();

  return statements.getUser.get(telegramId);
}

export function getUser(telegramId) {
  return statements.getUser.get(String(telegramId)) || null;
}

// [ADDED] Membership plans used by manual admin testing and future billing.
export const MEMBERSHIP_PLANS = Object.freeze({
  free: { label: "Free", days: 0, sessions: 1, price: 0 },
  "premium-a": { label: "Premium A", days: 3, sessions: 2, price: 14000 },
  "premium-b": { label: "Premium B", days: 7, sessions: 3, price: 44000 },
  "premium-c": { label: "Premium C", days: 30, sessions: 5, price: 149000 }
});

export function getMembership(telegramId) {
  const user = getUser(telegramId);
  if (!user) return null;

  const now = Date.now();
  let plan = MEMBERSHIP_PLANS[user.plan] ? user.plan : "free";
  let expiresAt = user.plan_expires_at || null;

  if (plan !== "free" && expiresAt && expiresAt <= now) {
    db.prepare(`
      UPDATE telegram_users
      SET plan = 'free', plan_expires_at = NULL, plan_updated_at = ?, updated_at = ?
      WHERE telegram_id = ?
    `).run(now, now, String(telegramId));
    plan = "free";
    expiresAt = null;
  }

  const definition = MEMBERSHIP_PLANS[plan];
  return {
    telegram_id: String(user.telegram_id),
    role: user.role || "user",
    plan,
    plan_label: definition.label,
    plan_expires_at: expiresAt,
    sessions_limit: definition.sessions,
    price: definition.price,
    is_admin: user.role === "admin"
  };
}

export function setMembership(telegramId, plan) {
  if (!Object.prototype.hasOwnProperty.call(MEMBERSHIP_PLANS, plan)) {
    throw new Error("INVALID_MEMBERSHIP_PLAN");
  }

  const id = String(telegramId);
  const user = getUser(id);
  if (!user) return null;

  const now = Date.now();
  const expiresAt = plan === "free"
    ? null
    : now + MEMBERSHIP_PLANS[plan].days * 24 * 60 * 60 * 1000;

  db.prepare(`
    UPDATE telegram_users
    SET plan = ?, plan_expires_at = ?, plan_updated_at = ?, updated_at = ?
    WHERE telegram_id = ?
  `).run(plan, expiresAt, now, now, id);

  return getMembership(id);
}

export function listMembershipUsers() {
  return getAllActiveUsers().map((user) => ({
    ...user,
    membership: getMembership(user.telegram_id)
  }));
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

// [ADDED] Return all WhatsApp accounts owned by one authenticated Telegram user.
export function getWhatsAppAccounts(telegramId) {
  return db.prepare(`
    SELECT a.session_id, a.telegram_id, a.label, a.phone_number,
           CASE WHEN a.is_primary = 1 THEN COALESCE(s.connection_status, a.connection_status)
                ELSE a.connection_status END AS connection_status,
           a.is_primary, a.created_at, a.updated_at
    FROM whatsapp_accounts a
    LEFT JOIN whatsapp_sessions s ON s.telegram_id = a.telegram_id
    WHERE a.telegram_id = ?
    ORDER BY a.is_primary DESC, a.created_at ASC
  `).all(String(telegramId));
}

// [ADDED] Look up a WhatsApp account while enforcing owner isolation.
// [ADDED] Startup restoration list, including all accounts for active Telegram users.
export function getAllWhatsAppAccounts() {
  return db.prepare(`
    SELECT a.session_id, a.telegram_id, a.label, a.phone_number,
           CASE WHEN a.is_primary = 1 THEN COALESCE(s.connection_status, a.connection_status)
                ELSE a.connection_status END AS connection_status,
           a.is_primary, a.created_at, a.updated_at, u.is_active
    FROM whatsapp_accounts a
    INNER JOIN telegram_users u ON u.telegram_id = a.telegram_id
    LEFT JOIN whatsapp_sessions s ON s.telegram_id = a.telegram_id
    WHERE u.is_active = 1
    ORDER BY a.created_at ASC
  `).all();
}

export function getWhatsAppAccount(telegramId, sessionId) {
  return db.prepare(`
    SELECT a.session_id, a.telegram_id, a.label, a.phone_number,
           CASE WHEN a.is_primary = 1 THEN COALESCE(s.connection_status, a.connection_status)
                ELSE a.connection_status END AS connection_status,
           a.is_primary, a.created_at, a.updated_at
    FROM whatsapp_accounts a
    LEFT JOIN whatsapp_sessions s ON s.telegram_id = a.telegram_id
    WHERE a.telegram_id = ? AND a.session_id = ?
    LIMIT 1
  `).get(String(telegramId), String(sessionId)) || null;
}

// [ADDED] Create an account only when the current membership has remaining capacity.
export function createWhatsAppAccount(telegramId, label = null) {
  const ownerId = String(telegramId);
  const membership = getMembership(ownerId);
  if (!membership) throw new Error("USER_NOT_FOUND");
  const now = Date.now();
  const sessionId = crypto.randomUUID();
  return db.transaction(() => {
    const count = db.prepare(
      "SELECT COUNT(*) AS count FROM whatsapp_accounts WHERE telegram_id = ?"
    ).get(ownerId).count;
    if (count >= membership.sessions_limit) {
      throw new Error("SESSION_LIMIT_REACHED");
    }
    db.prepare(`
      INSERT INTO whatsapp_accounts (
        session_id, telegram_id, label, connection_status,
        is_primary, created_at, updated_at
      ) VALUES (?, ?, ?, 'disconnected', 0, ?, ?)
    `).run(sessionId, ownerId, label ? String(label).trim().slice(0, 60) : null, now, now);
    return getWhatsAppAccount(ownerId, sessionId);
  })();
}

// [ADDED] Persist status updates for a non-primary WhatsApp account.
export function updateWhatsAppAccountSession(telegramId, sessionId, status, phoneNumber = null) {
  const allowedStatuses = new Set([
    "disconnected", "connecting", "connected", "qr", "logged_out", "paused"
  ]);
  if (!allowedStatuses.has(status)) {
    throw new Error(`Invalid WhatsApp connection status: ${status}`);
  }
  const now = Date.now();
  const result = db.prepare(`
    UPDATE whatsapp_accounts
    SET connection_status = ?,
        phone_number = COALESCE(?, phone_number),
        updated_at = ?
    WHERE telegram_id = ? AND session_id = ?
  `).run(status, phoneNumber, now, String(telegramId), String(sessionId));
  if (result.changes === 0) return null;
  return getWhatsAppAccount(telegramId, sessionId);
}

// [ADDED] Remove only a non-primary account after its socket has been stopped.
export function deleteWhatsAppAccount(telegramId, sessionId) {
  return db.prepare(`
    DELETE FROM whatsapp_accounts
    WHERE telegram_id = ? AND session_id = ? AND is_primary = 0
  `).run(String(telegramId), String(sessionId)).changes > 0;
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
    "logged_out",
    "paused"
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

// [ADDED] Record the WITA calendar day already covered by the automatic Free pause.
export function setFreePauseDate(telegramId, date) {
  const now = Date.now();
  statements.ensureSession.run(String(telegramId), now, now);
  db.prepare("UPDATE whatsapp_sessions SET free_pause_date = ?, updated_at = ? WHERE telegram_id = ?")
    .run(String(date), now, String(telegramId));
  return getSession(telegramId);
}

// [ADDED] Read a persisted application setting with a safe fallback.
export function getAppSetting(key, fallback = null) {
  const row = db.prepare(
    "SELECT setting_value FROM app_settings WHERE setting_key = ?"
  ).get(String(key));
  return row?.setting_value ?? fallback;
}

// [ADDED] Persist an application setting.
export function setAppSetting(key, value) {
  db.prepare(`
    INSERT INTO app_settings (setting_key, setting_value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(setting_key) DO UPDATE SET
      setting_value = excluded.setting_value,
      updated_at = excluded.updated_at
  `).run(String(key), String(value), Date.now());
  return getAppSetting(key);
}

export function deleteSession(telegramId) {
  return statements.deleteSession.run(String(telegramId)).changes > 0;
}

export function reserveForwardedMessage(messageId, telegramId, sessionId = telegramId) {
  return statements.insertForwardedMessage.run(
    scopeSessionKey(telegramId, sessionId, messageId),
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
  const sessionId = String(input.sessionId || telegramId);
  const whatsappChatId = scopeSessionKey(telegramId, sessionId, input.whatsappChatId);
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
      sender_jid: input.senderJid ? scopeSessionKey(telegramId, input.sessionId || telegramId, input.senderJid) : null,
      sender_name: input.senderName || null,
      direction: input.direction,
      message_type: input.messageType || "text",
      body,
      media_mimetype: input.mediaMimetype || null,
      media_file_name: input.mediaFileName || null,
      message_timestamp: timestamp,
      message_content: input.messageContent || null,
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

// [ADDED] Update an existing WhatsApp message after an authenticated edit event.
export function updateWhatsAppMessage(telegramId, whatsappChatId, messageId, body, sessionId = telegramId) {
  const ownerId = String(telegramId ?? "");
  const chatId = scopeSessionKey(ownerId, sessionId, whatsappChatId);
  const waMessageId = String(messageId ?? "");
  const editedBody = body == null ? null : String(body);

  if (!/^\d+$/.test(ownerId) || !chatId || !waMessageId || editedBody === null) {
    return false;
  }

  const changed = statements.updateEditedMessage.run(
    editedBody,
    ownerId,
    chatId,
    waMessageId
  ).changes > 0;

  if (changed) {
    const preview = editedBody.replace(/\s+/g, " ").slice(0, 240);
    db.prepare(`
      UPDATE chats
      SET last_message_preview = @preview,
          updated_at = @now
      WHERE telegram_id = @telegram_id
        AND whatsapp_chat_id = @whatsapp_chat_id
        AND last_message_at = (
          SELECT message_timestamp
          FROM messages
          WHERE telegram_id = @telegram_id
            AND whatsapp_chat_id = @whatsapp_chat_id
          ORDER BY message_timestamp DESC, id DESC
          LIMIT 1
        )
    `).run({
      preview,
      now: Date.now(),
      telegram_id: ownerId,
      whatsapp_chat_id: chatId
    });
  }

  return changed;
}

// [ADDED] Retrieve stored protobuf content for Baileys, scoped to the exact chat and sender direction.
export function getWhatsAppMessageContent(telegramId, whatsappChatId, messageId, fromMe, sessionId = telegramId) {
  const ownerId = String(telegramId ?? "");
  const chatId = scopeSessionKey(ownerId, sessionId, whatsappChatId);
  const waMessageId = String(messageId ?? "");

  if (!/^\d+$/.test(ownerId) || !chatId || !waMessageId) {
    return null;
  }

  const row = statements.getMessageContent.get(
    ownerId,
    chatId,
    waMessageId,
    fromMe ? "outgoing" : "incoming"
  );

  return row?.message_content || null;
}

// [ADDED] Persist a WhatsApp revoke event for the owning Telegram account.
export function markWhatsAppMessageDeleted(telegramId, whatsappChatId, messageId, sessionId = telegramId) {
  const ownerId = String(telegramId ?? "");
  const chatId = scopeSessionKey(ownerId, sessionId, whatsappChatId);
  const waMessageId = String(messageId ?? "");

  if (!/^\d+$/.test(ownerId) || !chatId || !waMessageId) {
    return false;
  }

  return statements.markMessageDeleted.run(
    ownerId,
    chatId,
    waMessageId
  ).changes > 0;
}

// Ambil daftar chat milik satu pengguna Telegram.
export function listChats(telegramId, options = {}) {
  const ownerId = String(telegramId);
  const sessionId = String(options.sessionId || ownerId);
  const limit = Math.min(100, Math.max(1, Number(options.limit) || 50));
  const offset = Math.max(0, Number(options.offset) || 0);
  return statements.listChats.all({
    telegram_id: ownerId,
    session_id: sessionId,
    include_archived: options.includeArchived ? 1 : 0,
    limit,
    offset
  }).map((row) => ({
    ...row,
    whatsapp_chat_id: unScopeSessionKey(ownerId, sessionId, row.whatsapp_chat_id)
  }));
}

// Ambil satu chat milik pengguna yang ditentukan.
export function getChat(telegramId, whatsappChatId, sessionId = telegramId) {
  const ownerId = String(telegramId);
  const scopedChatId = scopeSessionKey(ownerId, sessionId, whatsappChatId);
  const row = statements.getChat.get(ownerId, scopedChatId) || null;
  return row ? { ...row, whatsapp_chat_id: unScopeSessionKey(ownerId, sessionId, row.whatsapp_chat_id) } : null;
}

// Ambil pesan dari satu chat, dimulai dari yang terbaru.
export function listMessages(telegramId, whatsappChatId, limit = 100, sessionId = telegramId) {
  const ownerId = String(telegramId);
  const scopedChatId = scopeSessionKey(ownerId, sessionId, whatsappChatId);
  if (!getChat(ownerId, whatsappChatId, sessionId)) return [];
  const safeLimit = Math.min(200, Math.max(1, Number(limit) || 100));
  return statements.listMessages.all(ownerId, scopedChatId, safeLimit)
    .map((row) => ({ ...row, whatsapp_chat_id: unScopeSessionKey(ownerId, sessionId, row.whatsapp_chat_id), sender_jid: row.sender_jid ? unScopeSessionKey(ownerId, sessionId, row.sender_jid) : null }));
}

// Tandai pesan dibaca di Mini App saja.
export function markChatReadInMiniApp(telegramId, whatsappChatId, sessionId = telegramId) {
  if (!getChat(telegramId, whatsappChatId, sessionId)) return 0;
  return statements.markChatRead.run(
    Date.now(),
    String(telegramId),
    scopeSessionKey(telegramId, sessionId, whatsappChatId)
  ).changes;
}

// Tandai atau lepaskan favorit chat.
export function setChatFavorite(telegramId, whatsappChatId, isFavorite, sessionId = telegramId) {
  return statements.setChatFavorite.run(
    isFavorite ? 1 : 0, Date.now(), String(telegramId),
    scopeSessionKey(telegramId, sessionId, whatsappChatId)
  ).changes > 0;
}

// Arsipkan atau keluarkan chat dari arsip.
export function setChatArchived(telegramId, whatsappChatId, isArchived, sessionId = telegramId) {
  return statements.setChatArchived.run(
    isArchived ? 1 : 0, Date.now(), String(telegramId),
    scopeSessionKey(telegramId, sessionId, whatsappChatId)
  ).changes > 0;
}

// Perbarui preferensi chat. Nilai null tidak mengubah nilai sebelumnya.
export function updateChatPreferences(
  telegramId, whatsappChatId, preferences = {}, sessionId = telegramId
) {
  if (!getChat(telegramId, whatsappChatId, sessionId)) {
    return false;
  }

  statements.upsertChatPreference.run({
    telegram_id: String(telegramId),
    whatsapp_chat_id: scopeSessionKey(telegramId, sessionId, whatsappChatId),
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
        (
          SELECT wpc.display_name
          FROM whatsapp_profile_cache wpc
          WHERE wpc.telegram_id = c.telegram_id
            AND (
              wpc.whatsapp_jid = c.peer_jid
              OR wpc.whatsapp_jid = c.phone_number || '@s.whatsapp.net'
            )
            AND wpc.display_name IS NOT NULL
            AND TRIM(wpc.display_name) <> ''
          ORDER BY CASE WHEN wpc.whatsapp_jid = c.peer_jid THEN 0 ELSE 1 END
          LIMIT 1
        ),
        (
          SELECT ch.name
          FROM chats ch
          WHERE ch.telegram_id = c.telegram_id
            AND (
              ch.whatsapp_chat_id = c.peer_jid
              OR ch.phone_number = c.phone_number
            )
            AND ch.name IS NOT NULL
            AND TRIM(ch.name) <> ''
          ORDER BY CASE WHEN ch.whatsapp_chat_id = c.peer_jid THEN 0 ELSE 1 END
          LIMIT 1
        ),
        CASE WHEN c.phone_number IS NOT NULL
          THEN '+' || c.phone_number
        END,
        'Nomor tidak diketahui'
      ) AS display_name,
      CASE WHEN ct.id IS NULL THEN 0 ELSE 1 END AS is_saved
    FROM calls c
    LEFT JOIN contacts ct
      ON ct.telegram_id = c.telegram_id
      AND ct.phone_number = CASE
        WHEN instr(c.call_id, '::') > 0
          THEN substr(c.call_id, 1, instr(c.call_id, '::') - 1) || '::' || c.phone_number
        ELSE c.phone_number
      END
    WHERE c.telegram_id = @telegram_id
      AND (
        (@session_id = @telegram_id AND instr(c.call_id, '::') = 0)
        OR (@session_id != @telegram_id AND c.call_id LIKE @session_id || '::%')
      )
      AND (@include_archived = 1 OR c.is_archived = 0)
    ORDER BY c.call_timestamp DESC, c.id DESC
    LIMIT @limit OFFSET @offset
  `)
};

// Simpan kontak baru. Jika nomor sudah ada, nama diperbarui.
export function saveContact(telegramId, { name, phone }, sessionId = telegramId) {
  const id = String(telegramId);
  const validated = validateContactInput({ name, phone });
  const cleanName = validated.cleanName;
  const cleanPhone = scopeSessionKey(id, sessionId, validated.cleanPhone);

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
      contact: (() => { const row = contactStatements.getByPhone.get(id, cleanPhone); return row ? { ...row, phone_number: unScopeSessionKey(id, sessionId, row.phone_number) } : null; })()
    };
  })();
}

// Ubah nama/nomor kontak. Mengembalikan null jika kontak tidak ditemukan.
export function updateContact(telegramId, contactId, { name, phone }, sessionId = telegramId) {
  const id = String(telegramId);
  const rowId = Number.parseInt(contactId, 10);
  const validated = validateContactInput({ name, phone });
  const cleanName = validated.cleanName;
  const cleanPhone = scopeSessionKey(id, sessionId, validated.cleanPhone);

  const existingContact = Number.isInteger(rowId) ? contactStatements.getById.get(id, rowId) : null;
  const sessionPrefix = id === String(sessionId) ? "" : `${sessionId}::`;
  if (!existingContact || (sessionPrefix ? !String(existingContact.phone_number).startsWith(sessionPrefix) : String(existingContact.phone_number).includes("::"))) {
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

  const updatedContact = contactStatements.getById.get(id, rowId);
  return updatedContact ? { ...updatedContact, phone_number: unScopeSessionKey(id, sessionId, updatedContact.phone_number) } : null;
}

export function deleteContact(telegramId, contactId, sessionId = telegramId) {
  const ownerId = String(telegramId);
  const rowId = Number.parseInt(contactId, 10);
  if (!Number.isInteger(rowId)) return false;
  const row = contactStatements.getById.get(ownerId, rowId);
  const prefix = ownerId === String(sessionId) ? "" : `${sessionId}::`;
  if (!row || (prefix ? !String(row.phone_number).startsWith(prefix) : String(row.phone_number).includes("::"))) return false;
  return contactStatements.remove.run(ownerId, rowId).changes > 0;
}

export function deleteContactByPhone(telegramId, phone, sessionId = telegramId) {
  const normalizedPhone = normalizePhoneNumber(phone);
  const cleanPhone = normalizedPhone ? scopeSessionKey(telegramId, sessionId, normalizedPhone) : null;

  if (!cleanPhone) {
    return false;
  }

  return contactStatements.removeByPhone.run(
    String(telegramId),
    cleanPhone
  ).changes > 0;
}

export function listContacts(telegramId, limit = 1000, sessionId = telegramId) {
  const safeLimit = Math.min(2000, Math.max(1, Number(limit) || 1000));
  const ownerId = String(telegramId);
  const prefix = ownerId === String(sessionId) ? "" : `${sessionId}::`;
  return contactStatements.list.all(ownerId, 2000)
    .filter((row) => prefix ? String(row.phone_number).startsWith(prefix) : !String(row.phone_number).includes("::"))
    .slice(0, safeLimit)
    .map((row) => ({ ...row, phone_number: unScopeSessionKey(ownerId, sessionId, row.phone_number) }));
}

// Catat event panggilan WhatsApp. Aman dipanggil berulang untuk call_id sama.
export function recordCall(input) {
  const telegramId = String(input.telegramId ?? "");
  const sessionId = String(input.sessionId || telegramId);
  const callId = scopeSessionKey(telegramId, sessionId, input.callId);

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
    peer_jid: input.peerJid ? scopeSessionKey(telegramId, sessionId, input.peerJid) : null,
    phone_number: normalizePhoneNumber(input.phoneNumber),
    call_timestamp: Number.isFinite(timestamp) && timestamp > 0
      ? timestamp
      : now,
    now
  });
}

export function listCalls(telegramId, options = {}) {
  const ownerId = String(telegramId);
  const sessionId = String(options.sessionId || ownerId);
  return callStatements.list.all({
    telegram_id: ownerId,
    session_id: sessionId,
    include_archived: options.archived ? 1 : 0,
    limit: Math.min(200, Math.max(1, Number(options.limit) || 100)),
    offset: Math.max(0, Number(options.offset) || 0)
  }).map((row) => ({
    ...row,
    call_id: unScopeSessionKey(ownerId, sessionId, row.call_id),
    peer_jid: row.peer_jid ? unScopeSessionKey(ownerId, sessionId, row.peer_jid) : null
  }));
}

// [ADDED] Update favorite state for one call-history record only.
export function setCallFavorite(telegramId, callId, favorite, sessionId = telegramId) {
  return db.prepare(`
    UPDATE calls
    SET is_favorite = ?, updated_at = ?
    WHERE telegram_id = ? AND id = ? AND ((? = ? AND instr(call_id, '::') = 0) OR call_id LIKE ?)
  `).run(favorite ? 1 : 0, Date.now(), String(telegramId), Number(callId), String(sessionId), String(telegramId), `${sessionId}::%`).changes > 0;
}

// [ADDED] Archive one call-history record only.
export function setCallArchived(telegramId, callId, archived, sessionId = telegramId) {
  return db.prepare(`
    UPDATE calls
    SET is_archived = ?, updated_at = ?
    WHERE telegram_id = ? AND id = ? AND ((? = ? AND instr(call_id, '::') = 0) OR call_id LIKE ?)
  `).run(archived ? 1 : 0, Date.now(), String(telegramId), Number(callId), String(sessionId), String(telegramId), `${sessionId}::%`).changes > 0;
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

  attachLocal: db.prepare(`
    UPDATE messages
    SET media_storage_path = @storage_path,
        media_mimetype = COALESCE(@mimetype, media_mimetype),
        media_file_name = COALESCE(@file_name, media_file_name)
    WHERE telegram_id = @telegram_id
      AND whatsapp_chat_id = @chat_id
      AND whatsapp_message_id = @message_id
  `),

  get: db.prepare(`
    SELECT id, direction, whatsapp_chat_id, telegram_file_id, telegram_file_kind,
           media_storage_path, media_mimetype, media_file_name
    FROM messages
    WHERE telegram_id = ? AND id = ?
  `)
};

// Remember which Telegram file holds the media of a WhatsApp message.
export function attachTelegramFile({
  telegramId,
  sessionId = telegramId,
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
    chat_id: scopeSessionKey(telegramId, sessionId, whatsappChatId),
    message_id: String(messageId),
    file_id: String(fileId),
    kind: kind || null
  }).changes > 0;
}

// [ADDED] Attach a locally stored WhatsApp media file to its message row.
export function attachLocalMedia({
  telegramId,
  sessionId = telegramId,
  whatsappChatId,
  messageId,
  storagePath,
  mimetype,
  fileName
}) {
  if (!storagePath || !messageId) return false;

  return mediaStatements.attachLocal.run({
    telegram_id: String(telegramId),
    chat_id: scopeSessionKey(telegramId, sessionId, whatsappChatId),
    message_id: String(messageId),
    storage_path: String(storagePath),
    mimetype: mimetype || null,
    file_name: fileName || null
  }).changes > 0;
}

// Only returns media that belongs to this Telegram user.
export function getMessageMedia(telegramId, messageRowId, sessionId = telegramId) {
  const row = mediaStatements.get.get(String(telegramId), Number(messageRowId)) || null;
  if (!row) return null;
  const chatId = String(row.whatsapp_chat_id || "");
  const belongsToSession = String(sessionId) === String(telegramId)
    ? !chatId.includes("::")
    : chatId.startsWith(`${sessionId}::`);
  return belongsToSession ? row : null;
}

// [ADDED] Read and update cached WhatsApp profile data.
export function getWhatsAppProfileCache(telegramId, whatsappJid, sessionId = telegramId) {
  return db.prepare(`
    SELECT * FROM whatsapp_profile_cache
    WHERE telegram_id = ? AND whatsapp_jid = ?
  `).get(String(telegramId), scopeSessionKey(telegramId, sessionId, whatsappJid)) || null;
}

export function saveWhatsAppProfileCache({
  telegramId,
  whatsappJid,
  displayName,
  aboutText,
  pictureUrl,
  statusSetAt,
  sessionId = telegramId
}) {
  const now = Date.now();

  db.prepare(`
    INSERT INTO whatsapp_profile_cache (
      telegram_id, whatsapp_jid, display_name, about_text,
      picture_url, status_set_at, fetched_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(telegram_id, whatsapp_jid) DO UPDATE SET
      display_name = COALESCE(excluded.display_name, whatsapp_profile_cache.display_name),
      about_text = excluded.about_text,
      picture_url = excluded.picture_url,
      status_set_at = excluded.status_set_at,
      fetched_at = excluded.fetched_at
  `).run(
    String(telegramId),
    scopeSessionKey(telegramId, sessionId, whatsappJid),
    displayName || null,
    aboutText || null,
    pictureUrl || null,
    statusSetAt || null,
    now
  );

  return getWhatsAppProfileCache(telegramId, whatsappJid, sessionId);
}

// [ADDED] Resolve the latest sender name from messages owned by this Telegram account.
export function getWhatsAppParticipantName(telegramId, whatsappJid, sessionId = telegramId) {
  const row = db.prepare(`
    SELECT sender_name
    FROM messages
    WHERE telegram_id = ?
      AND sender_jid = ?
      AND sender_name IS NOT NULL
      AND sender_name != ''
    ORDER BY message_timestamp DESC, id DESC
    LIMIT 1
  `).get(String(telegramId), scopeSessionKey(telegramId, sessionId, whatsappJid));

  return row?.sender_name || null;
}

// [ADDED] Confirm a JID belongs to a chat or participant visible to this account.
export function hasWhatsAppParticipant(telegramId, whatsappJid, sessionId = telegramId) {
  const id = String(telegramId);
  const jid = scopeSessionKey(id, sessionId, whatsappJid);

  const chat = db.prepare(`
    SELECT 1 FROM chats
    WHERE telegram_id = ? AND whatsapp_chat_id = ?
    LIMIT 1
  `).get(id, jid);

  if (chat) return true;

  return Boolean(db.prepare(`
    SELECT 1
    FROM messages m
    INNER JOIN chats c
      ON c.telegram_id = m.telegram_id
      AND c.whatsapp_chat_id = m.whatsapp_chat_id
    WHERE m.telegram_id = ?
      AND m.sender_jid = ?
    LIMIT 1
  `).get(id, jid));
}

// Saved contact name for a phone number (null if not saved).
export function findContactName(telegramId, phone, sessionId = telegramId) {
  const cleanPhone = normalizePhoneNumber(phone);

  if (!cleanPhone) {
    return null;
  }

  const row = contactStatements.getByPhone.get(String(telegramId), scopeSessionKey(telegramId, sessionId, cleanPhone));

  return row ? row.name : null;
}

// Tutup database saat aplikasi berhenti.


// [ADDED] Session-scoped cleanup operations used by the Profile settings.
const cleanupStatements = {
  media: db.prepare(`
    UPDATE messages
    SET telegram_file_id = NULL,
        telegram_file_kind = NULL,
        media_storage_path = NULL,
        media_mimetype = NULL,
        media_file_name = NULL
    WHERE telegram_id = @telegram_id
      AND (
        (@session_id = @telegram_id AND instr(whatsapp_chat_id, '::') = 0)
        OR (@session_id != @telegram_id AND whatsapp_chat_id LIKE @session_id || '::%')
      )
  `),
  clearChatPreviews: db.prepare(`
    UPDATE chats
    SET last_message_at = NULL,
        last_message_preview = NULL,
        updated_at = @now
    WHERE telegram_id = @telegram_id
      AND (
        (@session_id = @telegram_id AND instr(whatsapp_chat_id, '::') = 0)
        OR (@session_id != @telegram_id AND whatsapp_chat_id LIKE @session_id || '::%')
      )
  `),
  messages: db.prepare(`
    DELETE FROM messages
    WHERE telegram_id = @telegram_id
      AND (
        (@session_id = @telegram_id AND instr(whatsapp_chat_id, '::') = 0)
        OR (@session_id != @telegram_id AND whatsapp_chat_id LIKE @session_id || '::%')
      )
  `),
  calls: db.prepare(`
    DELETE FROM calls
    WHERE telegram_id = @telegram_id
      AND (
        (@session_id = @telegram_id AND instr(call_id, '::') = 0)
        OR (@session_id != @telegram_id AND call_id LIKE @session_id || '::%')
      )
  `),
  contacts: db.prepare(`
    DELETE FROM contacts
    WHERE telegram_id = @telegram_id
      AND (
        (@session_id = @telegram_id AND instr(phone_number, '::') = 0)
        OR (@session_id != @telegram_id AND phone_number LIKE @session_id || '::%')
      )
  `)
};

export function cleanupUserData(telegramId, type, sessionId = telegramId) {
  const statement = cleanupStatements[type];
  if (!statement) throw new Error("INVALID_CLEANUP_TYPE");
  const params = { telegram_id: String(telegramId), session_id: String(sessionId) };
  return db.transaction(() => {
    if (type === "messages") {
      cleanupStatements.clearChatPreviews.run({ ...params, now: Date.now() });
    }
    return statement.run(params).changes;
  })();
}

// [ADDED] Read and persist WAGRAM AI business configuration per authenticated owner and WhatsApp session.
export function getAIBusinessProfile(telegramId, sessionId = telegramId) {
  const row = db.prepare(`
    SELECT settings_json, prompt_template, intent_config_json, fallback_config_json, updated_at
    FROM ai_business_profiles
    WHERE telegram_id = ? AND session_id = ?
  `).get(String(telegramId), String(sessionId || telegramId));
  if (!row) return null;
  const parse = (value, fallback) => {
    try { return JSON.parse(value); } catch { return fallback; }
  };
  return {
    settings: parse(row.settings_json, {}),
    promptTemplate: row.prompt_template,
    intentConfig: parse(row.intent_config_json, []),
    fallbackConfig: parse(row.fallback_config_json, {}),
    updatedAt: row.updated_at
  };
}

export function saveAIBusinessProfile(telegramId, sessionId = telegramId, profile = {}) {
  const ownerId = String(telegramId);
  const scopedSessionId = String(sessionId || telegramId);
  const now = Date.now();
  const current = getAIBusinessProfile(ownerId, scopedSessionId);
  const settings = profile.settings && typeof profile.settings === "object" ? profile.settings : current?.settings || {};
  const defaultPromptTemplate = "Kamu asisten {{nama_bisnis}}. Jawab hanya berdasarkan blok DATA. Maksimal {{max_kalimat}} kalimat, santai dan sopan. Jika DATA kosong atau tidak memuat jawaban, katakan: {{pesan_tidak_tersedia}}. Jangan menebak atau memberi contoh. Jangan sebut item yang tidak ada di DATA.";
  const promptTemplate = typeof profile.promptTemplate === "string" && profile.promptTemplate.trim()
    ? profile.promptTemplate
    : current?.promptTemplate || defaultPromptTemplate;
  const intentConfig = Array.isArray(profile.intentConfig) && profile.intentConfig.length
    ? profile.intentConfig
    : current?.intentConfig?.length ? current.intentConfig : [
        { name: "greeting", examples: ["hello", "hai", "selamat pagi"] },
        { name: "capabilities", examples: ["apa saja yang bisa kamu lakukan", "kamu bisa bantu apa", "fitur apa yang kamu punya", "apa kemampuanmu", "what can you do"] },
        { name: "manager", examples: ["siapa manager saya", "siapa penanggung jawab usaha"] },
        { name: "outlets", examples: ["berapa outlet", "apa saja cabang saya", "alamat outlet"] },
        { name: "products", examples: ["apa menu usaha ini", "produk apa yang dijual", "daftar makanan"] },
        { name: "product_price", examples: ["berapa harga produk", "harga menu ini berapa"] },
        { name: "product_stock", examples: ["berapa stok produk", "stok menu ini"] },
        { name: "payment", examples: ["informasi pembayaran", "qris usaha"] },
        { name: "business_hours", examples: ["jam buka outlet", "kapan outlet buka"] },
        { name: "general", examples: ["pertanyaan lain tentang usaha"] }
      ];
  const fallbackConfig = profile.fallbackConfig && typeof profile.fallbackConfig === "object" && String(profile.fallbackConfig.notAvailable || "").trim()
    ? profile.fallbackConfig
    : current?.fallbackConfig || { notAvailable: "Informasi tersebut belum tersedia dalam data usaha yang tercatat." };
  db.prepare(`
    INSERT INTO ai_business_profiles (
      telegram_id, session_id, settings_json, prompt_template,
      intent_config_json, fallback_config_json, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(telegram_id, session_id) DO UPDATE SET
      settings_json = excluded.settings_json,
      prompt_template = excluded.prompt_template,
      intent_config_json = excluded.intent_config_json,
      fallback_config_json = excluded.fallback_config_json,
      updated_at = excluded.updated_at
  `).run(
    ownerId, scopedSessionId, JSON.stringify(settings), promptTemplate,
    JSON.stringify(intentConfig), JSON.stringify(fallbackConfig), now
  );
  return getAIBusinessProfile(ownerId, scopedSessionId);
}

export function addAIBusinessExample(telegramId, sessionId, example) {
  const result = db.prepare(`
    INSERT INTO ai_business_examples (
      telegram_id, session_id, question, data_json, ideal_answer, intent, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    String(telegramId), String(sessionId || telegramId),
    String(example.question || "").slice(0, 4000),
    JSON.stringify(example.data || {}),
    String(example.idealAnswer || "").slice(0, 2000),
    String(example.intent || "").slice(0, 100) || null,
    Date.now()
  );
  return result.lastInsertRowid;
}

export function findAIBusinessExamples(telegramId, sessionId, intent, limit = 3) {
  return db.prepare(`
    SELECT question, data_json, ideal_answer, intent
    FROM ai_business_examples
    WHERE telegram_id = ? AND session_id = ?
      AND (? IS NULL OR intent = ?)
    ORDER BY created_at DESC
    LIMIT ?
  `).all(
    String(telegramId), String(sessionId || telegramId),
    intent || null, intent || null, Math.max(1, Math.min(3, Number(limit) || 3))
  ).map((row) => {
    let data = {};
    try { data = JSON.parse(row.data_json); } catch {}
    return { question: row.question, data, idealAnswer: row.ideal_answer, intent: row.intent };
  });
}

export function closeDatabase() {
  if (db.open) {
    db.close();
  }
}

export default db;

// [ADDED] Create a pending Premium payment order and reserve a unique amount.
// The transaction prevents two concurrent users from receiving the same
// amount while an earlier order is still pending.
export function createPremiumPaymentOrder(telegramId, planPeriod, baseAmount) {
  const id = `premium_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const now = Date.now();
  const expiresAt = now + 15 * 60 * 1000;
  const ownerId = String(telegramId);

  const createOrder = db.transaction(() => {
    db.prepare(`
      UPDATE premium_payment_orders
      SET status = 'expired'
      WHERE status = 'pending' AND expires_at <= ?
    `).run(now);

    for (let attempt = 0; attempt < 900; attempt += 1) {
      const uniqueCode = 100 + Math.floor(Math.random() * 900);
      const amount = Number(baseAmount) + uniqueCode;
      const reserved = db.prepare(`
        SELECT 1 FROM premium_payment_orders
        WHERE amount = ? AND status = 'pending' AND expires_at > ?
        LIMIT 1
      `).get(amount, now);

      if (reserved) continue;

      db.prepare(`
        INSERT INTO premium_payment_orders (
          id, telegram_id, plan_period, base_amount, unique_code,
          amount, status, created_at, expires_at
        )
        VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
      `).run(
        id, ownerId, planPeriod, Number(baseAmount),
        uniqueCode, amount, now, expiresAt
      );

      return { id, planPeriod, baseAmount: Number(baseAmount), uniqueCode, amount, createdAt: now, expiresAt };
    }

    throw new Error("PREMIUM_PAYMENT_AMOUNT_POOL_EXHAUSTED");
  });

  return createOrder();
}
