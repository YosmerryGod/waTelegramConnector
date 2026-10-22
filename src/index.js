
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import pino from "pino";
import express from "express";

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

// [ADDED] Mini App REST API router.
import miniAppApi from "./miniapp-api.js";

// [ADDED] Application configuration.
const LOG_LEVEL = process.env.LOG_LEVEL || "warn";
const AUTH_DIR = path.resolve(
  process.env.WHATSAPP_AUTH_DIR || "./auth"
);

// [ADDED] API server configuration.
const MINIAPP_API_HOST = process.env.MINIAPP_API_HOST || "127.0.0.1";
const MINIAPP_API_PORT = Math.max(
  1,
  Math.min(65535, Number(process.env.MINIAPP_API_PORT || 3000))
);

const logger = pino({
  level: LOG_LEVEL
});

// [ADDED] Express application and HTTP server.
const app = express();

let apiServer = null;

// [ADDED] Prevent simultaneous shutdown execution.
let shuttingDown = false;

// [ADDED] Periodic cleanup timer.
let cleanupTimer = null;

// [ADDED] Basic security headers for API responses.
app.disable("x-powered-by");

app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
});

// [ADDED] Parse JSON bodies for Mini App API requests.
app.use(express.json({ limit: "32kb" }));

// [ADDED] Mount Mini App API.
app.use("/api/miniapp", miniAppApi);

// [ADDED] Root health endpoint for deployment checks.
app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "whatsapp-telegram-bridge"
  });
});

// [ADDED] Handle unknown API endpoints.
app.use("/api", (_req, res) => {
  res.status(404).json({
    ok: false,
    error: "API_NOT_FOUND"
  });
});

// [ADDED] Handle unexpected Express errors without exposing internals.
app.use((error, _req, res, _next) => {
  logger.error(
    { err: error },
    "Mini App API request failed."
  );

  if (res.headersSent) {
    return;
  }

  res.status(error.status === 400 ? 400 : 500).json({
    ok: false,
    error: error.status === 400
      ? "INVALID_REQUEST"
      : "INTERNAL_SERVER_ERROR"
  });
});

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

// [ADDED] Start the API server before restoring WhatsApp sessions.
function startApiServer() {
  return new Promise((resolve, reject) => {
    const server = app.listen(
      MINIAPP_API_PORT,
      MINIAPP_API_HOST
    );

    apiServer = server;

    server.once("listening", () => {
      logger.info(
        {
          host: MINIAPP_API_HOST,
          port: MINIAPP_API_PORT
        },
        "Mini App API server started."
      );

      resolve(server);
    });

    server.once("error", (error) => {
      apiServer = null;
      reject(error);
    });
  });
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

// [ADDED] Gracefully close the HTTP server.
async function stopApiServer() {
  if (!apiServer) {
    return;
  }

  const server = apiServer;
  apiServer = null;

  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });

    // [ADDED] Close idle HTTP connections where supported.
    server.closeIdleConnections?.();
  });
}

// [ADDED] Gracefully stop WhatsApp, API, Telegram polling, and SQLite.
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
    // [ADDED] Stop accepting new API requests.
    try {
      await stopApiServer();
    } catch (error) {
      logger.warn(
        { err: error },
        "Could not cleanly close the Mini App API server."
      );
    }

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

  // [ADDED] Start the API before restoring WhatsApp sessions.
  await startApiServer();

  // Telegram polling starts when telegram.js is imported.
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
