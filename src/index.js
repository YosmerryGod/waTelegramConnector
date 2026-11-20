
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import pino from "pino";
import express from "express";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";

import { bot, createWhatsAppCallbacks } from "./telegram.js";

import {
  getAllSessions,
  getAllWhatsAppAccounts,
  updateWhatsAppAccountSession,
  cleanupForwardedMessages,
  closeDatabase,
  updateSession,
  getMembership,
  setFreePauseDate,
  getAppSetting
} from "./database.js";

import {
  restoreWhatsAppSessions,
  shutdownWhatsApp,
  disconnectWhatsApp
} from "./whatsapp.js";
import miniAppApi, { verifyTelegramInitData } from "./miniapp-api.js";
import { getUser } from "./database.js";
import { addMiniAppClient, closeMiniAppClients, publishToMiniApp } from "./realtime.js";
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
const LOG_LEVEL = process.env.LOG_LEVEL || "warn";
const FREE_PAUSE_HOUR = Number(process.env.FREE_PAUSE_HOUR || 8);
const AUTH_DIR = path.resolve(
  process.env.WHATSAPP_AUTH_DIR || "./auth"
);
const MINIAPP_API_HOST = process.env.MINIAPP_API_HOST || "127.0.0.1";
const MINIAPP_API_PORT = Math.max(
  1,
  Math.min(65535, Number(process.env.MINIAPP_API_PORT || 3000))
);

const logger = pino({
  level: LOG_LEVEL,
  redact: {
    paths: ["telegramId", "*.telegramId"],
    censor: "[REDACTED]"
  }
});
const app = express();
// [MODIFIED] Trust only the explicitly configured reverse-proxy address/range or hop count.
const configuredTrustProxy = String(process.env.TRUST_PROXY || "loopback").trim();
const trustProxySetting = /^(0|[1-9]\\d*)$/.test(configuredTrustProxy)
  ? Number(configuredTrustProxy)
  : configuredTrustProxy.split(",").map((entry) => entry.trim()).filter(Boolean);
app.set("trust proxy", trustProxySetting.length === 1 ? trustProxySetting[0] : trustProxySetting);
app.use(helmet());
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 100,
  standardHeaders: "draft-8",
  legacyHeaders: false
}));

let apiServer = null;
const webSocketServer = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
let webSocketHeartbeat = null;

webSocketServer.on("connection", (socket) => {
  let telegramId = null;
  let authenticated = false;

  socket.isAlive = true;
  socket.on("pong", () => { socket.isAlive = true; });
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
let shuttingDown = false;
let cleanupTimer = null;
let freePauseTimer = null;
app.disable("x-powered-by");

app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
});
app.use(express.json({ limit: "8mb" }));
app.use("/api/miniapp", miniAppApi);
app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "whatsapp-telegram-bridge"
  });
});
app.use("/api", (_req, res) => {
  res.status(404).json({
    ok: false,
    error: "API_NOT_FOUND"
  });
});
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
function hasSavedAuth(sessionId) {
  const authPath = path.join(AUTH_DIR, String(sessionId));

  if (!fs.existsSync(authPath)) {
    return false;
  }

  try {
    return fs.statSync(authPath).isDirectory() &&
      fs.readdirSync(authPath).length > 0;
  } catch (error) {
    logger.warn(
      { err: error, sessionId: String(sessionId) },
      "Could not inspect saved WhatsApp credentials"
    );

    return false;
  }
}
async function restoreSessions() {
  const sessions = getAllWhatsAppAccounts().filter((session) => {
    const membership = getMembership(session.telegram_id);
    return session.is_active === 1 &&
      hasSavedAuth(session.session_id) &&
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
    (telegramId, sessionId) => createWhatsAppCallbacks(telegramId, {
      silentStartup: true,
      sessionId
    })
  );
}
function startApiServer() {
  return new Promise((resolve, reject) => {
    const server = createServer(app);
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
async function enforceFreeDailyPause() {
  if (getAppSetting("free_daily_pause_enabled", "1") !== "1") return;

  const { date, hour } = getWitaClock();
  if (hour < FREE_PAUSE_HOUR) return;

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
async function enforceTierSessionLimits() {
  const grouped = new Map();
  for (const account of getAllWhatsAppAccounts()) {
    if (!grouped.has(account.telegram_id)) grouped.set(account.telegram_id, []);
    grouped.get(account.telegram_id).push(account);
  }

  for (const [telegramId, accounts] of grouped) {
    const membership = getMembership(telegramId);
    const limit = membership?.sessions_limit || 1;
    for (const account of accounts.slice(limit)) {
      if (account.connection_status === "paused") continue;
      try {
        await disconnectWhatsApp(telegramId, {
          sessionId: account.session_id
        });
        updateWhatsAppAccountSession(
          telegramId,
          account.session_id,
          "paused"
        );
        publishToMiniApp(telegramId, {
          type: "connection.status",
          data: {
            sessionId: account.session_id,
            status: "paused",
            phoneNumber: account.phone_number || null
          }
        });
      } catch (error) {
        logger.error(
          { err: error, telegramId },
          "Could not pause WhatsApp account above the current tier limit."
        );
      }
    }
  }
}
function startMaintenance() {
  freePauseTimer = setInterval(() => {
    void enforceFreeDailyPause();
    void enforceTierSessionLimits();
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
    server.closeIdleConnections?.();
  });
}
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
    try {
      await stopApiServer();
    } catch (error) {
      logger.warn(
        { err: error },
        "Could not cleanly close the Mini App API server."
      );
    }
    const sessionsBeforeShutdown = getAllSessions();
    await shutdownWhatsApp();
    // Preserve sessions already paused by the scheduler; mark other sessions
    // disconnected so valid saved credentials can be restored on startup.
    for (const session of sessionsBeforeShutdown) {
      try {
        updateSession(
          session.telegram_id,
          session.connection_status === "paused" ? "paused" : "disconnected"
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
async function main() {
  logger.info("Starting WhatsApp Telegram Bridge.");
  fs.mkdirSync(AUTH_DIR, { recursive: true });
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
  try {
    cleanupForwardedMessages();
  } catch (error) {
    logger.warn(
      { err: error },
      "Initial database cleanup failed."
    );
  }

  startMaintenance();
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
