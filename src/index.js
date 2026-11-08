
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import pino from "pino";
import express from "express";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";

import { bot, createWhatsAppCallbacks } from "./telegram.js";

import {
  getAllSessions,
  cleanupForwardedMessages,
  closeDatabase,
  updateSession,
  getMembership,
  setFreePauseDate
} from "./database.js";

import {
  restoreWhatsAppSessions,
  shutdownWhatsApp,
  disconnectWhatsApp
} from "./whatsapp.js";

// [ADDED] Mini App REST API router.
import miniAppApi, { verifyTelegramInitData } from "./miniapp-api.js";
import { getUser } from "./database.js";
import { addMiniAppClient, closeMiniAppClients, publishToMiniApp } from "./realtime.js";

// [ADDED] Suppress verbose libsignal session dumps emitted directly to stdout.
// Keep all other application logs and errors unchanged.
const originalConsoleLog = console.log.bind(console);
const originalConsoleInfo = console.info.bind(console);
function isVerboseSessionDump(args) {
  return typeof args[0] === "string" &&
    /^Closing session:\s*SessionEntry\b/.test(args[0]);
}
console.log = (...args) => {
  if (!isVerboseSessionDump(args)) originalConsoleLog(...args);
};
console.info = (...args) => {
  if (!isVerboseSessionDump(args)) originalConsoleInfo(...args);
};

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
  level: LOG_LEVEL,
  // [ADDED] Redact account/session identifiers from application logs.
  redact: {
    paths: ["telegramId", "*.telegramId"],
    censor: "[REDACTED]"
  }
});

// [ADDED] Express application and HTTP server.
const app = express();

let apiServer = null;

// [ADDED] Authenticated WebSocket endpoint for Mini App updates.
const webSocketServer = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
let webSocketHeartbeat = null;

webSocketServer.on("connection", (socket) => {
  let telegramId = null;
  let authenticated = false;

  socket.isAlive = true;
  socket.on("pong", () => { socket.isAlive = true; });

  // [ADDED] initData is sent as the first frame, not in the URL or access logs.
  const authTimer = setTimeout(() => {
    if (!authenticated) socket.close(1008, "Authentication timeout");
  }, 5000);
  authTimer.unref?.();

  socket.on("message", (raw) => {
    if (authenticated) return;

    try {
      const payload = JSON.parse(raw.toString());
      const verified = payload?.type === "auth"
        ? verifyTelegramInitData(payload.initData)
        : null;
      const user = verified ? getUser(verified.id) : null;

      if (!verified || !user || user.is_active !== 1) {
        socket.close(1008, "Authentication failed");
        return;
      }

      authenticated = true;
      telegramId = verified.id;
      clearTimeout(authTimer);
      addMiniAppClient(telegramId, socket);
      socket.send(JSON.stringify({
        type: "connected",
        data: { telegramId },
        sentAt: Date.now()
      }));
    } catch {
      socket.close(1008, "Invalid authentication payload");
    }
  });

  socket.on("close", () => clearTimeout(authTimer));
  socket.on("error", (error) => {
    logger.warn({ err: error, telegramId }, "Mini App WebSocket error");
  });
});

// [ADDED] Prevent simultaneous shutdown execution.
let shuttingDown = false;

// [ADDED] Periodic cleanup timer.
let cleanupTimer = null;
// [ADDED] Dedicated scheduler for the 08:00 WITA Free-tier pause.
let freePauseTimer = null;

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
    const membership = getMembership(session.telegram_id);
    return session.is_active === 1 &&
      hasSavedAuth(session.telegram_id) &&
      !(membership?.plan === "free" && session.connection_status === "paused");
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
    // [MODIFIED] Restore sessions quietly so PM2/server restarts do not spam Telegram.
    (telegramId) => createWhatsAppCallbacks(telegramId, { silentStartup: true })
  );
}

// [ADDED] Start the API server before restoring WhatsApp sessions.
function startApiServer() {
  return new Promise((resolve, reject) => {
    const server = createServer(app);

    // [ADDED] Verify Telegram initData before upgrading to WebSocket.
    server.on("upgrade", (request, socket, head) => {
      let requestUrl;
      try {
        requestUrl = new URL(request.url, "http://localhost");
      } catch {
        socket.destroy();
        return;
      }

      if (requestUrl.pathname !== "/ws/miniapp") {
        socket.destroy();
        return;
      }

      webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
        webSocketServer.emit("connection", webSocket, request);
      });
    });

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

    server.listen(MINIAPP_API_PORT, MINIAPP_API_HOST);

    // [ADDED] Detect dead mobile WebSocket connections.
    webSocketHeartbeat = setInterval(() => {
      for (const socket of webSocketServer.clients) {
        if (socket.isAlive === false) {
          socket.terminate();
          continue;
        }
        socket.isAlive = false;
        socket.ping();
      }
    }, 30000);
    webSocketHeartbeat.unref?.();
  });
}

// [ADDED] WITA calendar date and hour for the daily Free-tier pause.
function getWitaClock() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Makassar",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23"
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return { date: `${values.year}-${values.month}-${values.day}`, hour: Number(values.hour) };
}

// [ADDED] Pause Free sessions at 08:00 WITA. Auth files are preserved.
async function enforceFreeDailyPause() {
  const { date, hour } = getWitaClock();
  if (hour < 8) return;

  for (const session of getAllSessions()) {
    if (session.connection_status !== "connected") continue;
    const membership = getMembership(session.telegram_id);
    if (!membership || membership.plan !== "free") continue;
    if (session.free_pause_date === date) continue;

    try {
      await disconnectWhatsApp(session.telegram_id);
      updateSession(session.telegram_id, "paused");
      setFreePauseDate(session.telegram_id, date);
      publishToMiniApp(session.telegram_id, {
        type: "connection.status",
        data: { status: "paused", phoneNumber: session.phone_number || null }
      });
    } catch (error) {
      logger.error({ err: error }, "Could not pause expired Free WhatsApp session.");
    }
  }
}

// [ADDED] Periodically remove expired message deduplication records.
function startMaintenance() {
  freePauseTimer = setInterval(() => {
    void enforceFreeDailyPause();
  }, 10000);
  freePauseTimer.unref?.();

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

  if (webSocketHeartbeat) {
    clearInterval(webSocketHeartbeat);
    webSocketHeartbeat = null;
  }
  closeMiniAppClients();
  webSocketServer.close();

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
  if (freePauseTimer) {
    clearInterval(freePauseTimer);
    freePauseTimer = null;
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

    // [MODIFIED] Stop sockets while preserving saved authentication.
    const sessionsBeforeShutdown = getAllSessions();
    await shutdownWhatsApp();

    // [ADDED] Free sessions require an explicit Connect after a server restart.
    for (const session of sessionsBeforeShutdown) {
      try {
        updateSession(
          session.telegram_id,
          getMembership(session.telegram_id)?.plan === "free"
            ? "paused"
            : "disconnected"
        );
      } catch (error) {
        logger.warn({ err: error }, "Could not update session status during shutdown.");
      }
    }

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
