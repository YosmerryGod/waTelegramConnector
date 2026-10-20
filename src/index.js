
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import pino from "pino";

import { bot, createWhatsAppCallbacks } from "./telegram.js";

import {
  getAllSessions,
  cleanupForwardedMessages,
  closeDatabase,
  updateSession
} from "./database.js";

import {
  restoreWhatsAppSessions,
  shutdownWhatsApp
} from "./whatsapp.js";

// [ADDED] Application configuration.
const LOG_LEVEL = process.env.LOG_LEVEL || "warn";
const AUTH_DIR = path.resolve(
  process.env.WHATSAPP_AUTH_DIR || "./auth"
);

const logger = pino({
  level: LOG_LEVEL
});

// [ADDED] Prevent simultaneous shutdown execution.
let shuttingDown = false;

// [ADDED] Periodic cleanup timer.
let cleanupTimer = null;

// [ADDED] Check whether a user has a persisted WhatsApp auth directory.
function hasSavedAuth(telegramId) {
  const authPath = path.join(AUTH_DIR, String(telegramId));

  if (!fs.existsSync(authPath)) {
    return false;
  }

  try {
    return fs.statSync(authPath).isDirectory() &&
      fs.readdirSync(authPath).length > 0;
  } catch (error) {
    logger.warn(
      { err: error, telegramId },
      "Could not inspect saved WhatsApp credentials"
    );

    return false;
  }
}

// [ADDED] Restore valid sessions for active Telegram users.
async function restoreSessions() {
  const sessions = getAllSessions().filter((session) => {
    return session.is_active === 1 &&
      hasSavedAuth(session.telegram_id);
  });

  if (sessions.length === 0) {
    logger.info("No saved WhatsApp sessions to restore.");
    return;
  }

  logger.info(
    { count: sessions.length },
    "Restoring saved WhatsApp sessions."
  );

  await restoreWhatsAppSessions(
    sessions,
    (telegramId) => createWhatsAppCallbacks(telegramId)
  );
}

// [ADDED] Periodically remove expired message deduplication records.
function startMaintenance() {
  cleanupTimer = setInterval(() => {
    try {
      const deleted = cleanupForwardedMessages();

      if (deleted > 0) {
        logger.info(
          { deleted },
          "Expired deduplication records removed."
        );
      }
    } catch (error) {
      logger.error(
        { err: error },
        "Database maintenance failed."
      );
    }
  }, 60 * 60 * 1000);

  cleanupTimer.unref?.();
}

// [ADDED] Gracefully stop WhatsApp, Telegram polling, and SQLite.
async function shutdown(signal) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;

  logger.info({ signal }, "Application shutdown started.");

  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }

  try {
    // [ADDED] Mark active sessions disconnected in SQLite.
    // Credentials remain on disk for a future restart.
    for (const session of getAllSessions()) {
      try {
        updateSession(
          session.telegram_id,
          "disconnected"
        );
      } catch (error) {
        logger.warn(
          {
            err: error,
            telegramId: session.telegram_id
          },
          "Could not update session status during shutdown."
        );
      }
    }

    await shutdownWhatsApp();

    try {
      await bot.stopPolling();
    } catch (error) {
      logger.warn(
        { err: error },
        "Telegram polling was already stopped."
      );
    }

    closeDatabase();

    logger.info("Application shutdown completed.");
    process.exitCode = 0;
  } catch (error) {
    logger.error(
      { err: error },
      "Application shutdown failed."
    );

    process.exitCode = 1;
  }
}

// [ADDED] Start the application.
async function main() {
  logger.info("Starting WhatsApp Telegram Bridge.");

  // [ADDED] Ensure the authentication directory exists.
  fs.mkdirSync(AUTH_DIR, { recursive: true });

  // [ADDED] Register graceful shutdown handlers.
  process.once("SIGINT", () => {
    void shutdown("SIGINT");
  });

  process.once("SIGTERM", () => {
    void shutdown("SIGTERM");
  });

  process.once("uncaughtException", (error) => {
    logger.fatal(
      { err: error },
      "Uncaught exception."
    );

    void shutdown("uncaughtException");
  });

  process.once("unhandledRejection", (reason) => {
    logger.error(
      { reason },
      "Unhandled promise rejection."
    );
  });

  // [ADDED] Clean up stale deduplication records at startup.
  try {
    cleanupForwardedMessages();
  } catch (error) {
    logger.warn(
      { err: error },
      "Initial database cleanup failed."
    );
  }

  startMaintenance();

  // [ADDED] Telegram polling starts when telegram.js is imported.
  // Restore WhatsApp sessions after the database is ready.
  try {
    await restoreSessions();
  } catch (error) {
    logger.error(
      { err: error },
      "Could not restore WhatsApp sessions."
    );
  }

  logger.info("WhatsApp Telegram Bridge is running.");
}

main().catch((error) => {
  logger.fatal(
    { err: error },
    "Application startup failed."
  );

  void shutdown("startup-failure");
});
