
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

// [ADDED] Resolve database path from environment.
const configuredPath = process.env.SQLITE_PATH || "./data/bridge.db";
const databasePath = path.resolve(configuredPath);

// [ADDED] Ensure the database directory exists.
fs.mkdirSync(path.dirname(databasePath), { recursive: true });

// [ADDED] Open SQLite database.
const db = new Database(databasePath);

// [ADDED] SQLite performance and integrity settings.
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");
db.pragma("foreign_keys = ON");
db.pragma("busy_timeout = 5000");

// [ADDED] Create tables and indexes.
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
      REFERENCES telegram_users(telegram_id)
      ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS forwarded_messages (
    message_id TEXT NOT NULL,
    telegram_id TEXT NOT NULL,
    forwarded_at INTEGER NOT NULL,
    PRIMARY KEY (message_id, telegram_id),
    FOREIGN KEY (telegram_id)
      REFERENCES telegram_users(telegram_id)
      ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_forwarded_messages_time
    ON forwarded_messages(forwarded_at);

  CREATE INDEX IF NOT EXISTS idx_whatsapp_sessions_status
    ON whatsapp_sessions(connection_status);
`);

// [ADDED] Prepared statements.
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
    SELECT *
    FROM telegram_users
    WHERE telegram_id = ?
  `),

  getAllActiveUsers: db.prepare(`
    SELECT *
    FROM telegram_users
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
    SELECT *
    FROM whatsapp_sessions
    WHERE telegram_id = ?
  `),

  getAllSessions: db.prepare(`
    SELECT s.*, u.is_active
    FROM whatsapp_sessions s
    INNER JOIN telegram_users u
      ON u.telegram_id = s.telegram_id
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
    DELETE FROM whatsapp_sessions
    WHERE telegram_id = ?
  `),

  insertForwardedMessage: db.prepare(`
    INSERT OR IGNORE INTO forwarded_messages (
      message_id, telegram_id, forwarded_at
    )
    VALUES (?, ?, ?)
  `),

  cleanupForwardedMessages: db.prepare(`
    DELETE FROM forwarded_messages
    WHERE forwarded_at < ?
  `)
};

// [ADDED] Register or update a Telegram user.
export function registerUser(user) {
  const now = Date.now();
  const telegramId = String(user.id);

  const transaction = db.transaction(() => {
    statements.upsertUser.run({
      telegram_id: telegramId,
      username: user.username || null,
      first_name: user.first_name || null,
      now
    });

    statements.ensureSession.run(telegramId, now, now);
  });

  transaction();

  return statements.getUser.get(telegramId);
}

// [ADDED] Get a registered user.
export function getUser(telegramId) {
  return statements.getUser.get(String(telegramId)) || null;
}

// [ADDED] Get all active Telegram users.
export function getAllActiveUsers() {
  return statements.getAllActiveUsers.all();
}

// [ADDED] Activate or deactivate a user.
export function setUserActive(telegramId, isActive) {
  return statements.setUserActive.run(
    isActive ? 1 : 0,
    Date.now(),
    String(telegramId)
  ).changes > 0;
}

// [ADDED] Get a user's WhatsApp session metadata.
export function getSession(telegramId) {
  return statements.getSession.get(String(telegramId)) || null;
}

// [ADDED] Get sessions belonging to active users.
export function getAllSessions() {
  return statements.getAllSessions.all();
}

// [ADDED] Update WhatsApp connection status.
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

  statements.ensureSession.run(
    String(telegramId),
    now,
    now
  );

  statements.updateSession.run({
    telegram_id: String(telegramId),
    status,
    phone_number: phoneNumber,
    now
  });

  return getSession(telegramId);
}

// [ADDED] Mark a session as disconnected without deleting its credentials.
export function markSessionDisconnected(telegramId) {
  const now = Date.now();

  statements.ensureSession.run(
    String(telegramId),
    now,
    now
  );

  statements.disconnectSession.run({
    telegram_id: String(telegramId),
    now
  });

  return getSession(telegramId);
}

// [ADDED] Delete a session's database metadata.
export function deleteSession(telegramId) {
  return statements.deleteSession.run(String(telegramId)).changes > 0;
}

// [ADDED] Atomically reserve a message ID for deduplication.
// Returns true if this message has not been recorded before.
export function reserveForwardedMessage(messageId, telegramId) {
  const result = statements.insertForwardedMessage.run(
    String(messageId),
    String(telegramId),
    Date.now()
  );

  return result.changes > 0;
}

// [ADDED] Remove old deduplication records.
export function cleanupForwardedMessages(maxAgeMs = 7 * 24 * 60 * 60 * 1000) {
  const cutoff = Date.now() - maxAgeMs;

  return statements.cleanupForwardedMessages.run(cutoff).changes;
}

// [ADDED] Close database cleanly when the process shuts down.
export function closeDatabase() {
  if (db.open) {
    db.close();
  }
}

export default db;
