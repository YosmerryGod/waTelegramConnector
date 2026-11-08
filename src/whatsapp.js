
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import pino from "pino";

import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState
} from "@whiskeysockets/baileys";

// [MODIFIED] Persistent authentication directory.
const AUTH_DIR = path.resolve(
  process.env.WHATSAPP_AUTH_DIR || "./auth"
);

const INITIAL_RECONNECT_DELAY = Math.max(
  1000,
  Number(process.env.RECONNECT_DELAY_MS || 3000)
);

const MAX_RECONNECT_DELAY = Math.max(
  INITIAL_RECONNECT_DELAY,
  Number(process.env.MAX_RECONNECT_DELAY_MS || 30000)
);

// [ADDED] Keep-alive / timeout tuning to reduce idle disconnects.
const KEEPALIVE_MS = Math.max(
  10000,
  Number(process.env.WA_KEEPALIVE_MS || 25000)
);

const CONNECT_TIMEOUT_MS = Math.max(
  10000,
  Number(process.env.WA_CONNECT_TIMEOUT_MS || 60000)
);

// A connection that lived this long counts as stable (resets backoff).
const STABLE_CONNECTION_MS = 30000;

const logger = pino({
  level: process.env.LOG_LEVEL || "warn"
});

// [ADDED] Each Telegram user owns an isolated WhatsApp connection.
const connections = new Map();
const intentionalDisconnects = new Set();

// [ADDED] Normalize a phone-number JID returned by Baileys.
function normalizePhoneJid(value) {
  if (typeof value !== "string" || !value) {
    return null;
  }

  // Accept a complete PN JID.
  const jidMatch = value.match(/^(\d+)(?::\d+)?@s\.whatsapp\.net$/);

  if (jidMatch) {
    return `${jidMatch[1]}@s.whatsapp.net`;
  }

  // Also accept a bare phone number if the API returns one.
  if (/^\d+$/.test(value)) {
    return `${value}@s.whatsapp.net`;
  }

  return null;
}

// [ADDED] Remember a LID -> phone-number pair in the per-connection cache.
function rememberMapping(cache, lid, pn) {
  const phoneJid = normalizePhoneJid(pn);

  if (
    cache &&
    typeof lid === "string" &&
    lid.endsWith("@lid") &&
    phoneJid
  ) {
    cache.set(lid.replace(/:\d+@/, "@"), phoneJid);
  }
}

// [ADDED] Learn mappings from contact objects (Baileys v7 exposes lid/phoneNumber).
function learnFromContacts(cache, contacts) {
  for (const contact of contacts || []) {
    const ids = [
      contact?.id,
      contact?.lid,
      contact?.phoneNumber
    ].filter((v) => typeof v === "string");

    const lid = ids.find((v) => v.endsWith("@lid"));
    const pn = ids.find(
      (v) => v.endsWith("@s.whatsapp.net") || /^\d+$/.test(v)
    );

    if (lid && pn) {
      rememberMapping(cache, lid, pn);
    }
  }
}

// [MODIFIED] Resolve an LID to its phone-number JID (cache, own account, Baileys store).
async function resolveLidToPhone(socket, jid, cache) {
  if (typeof jid !== "string" || !jid.endsWith("@lid")) {
    return null;
  }

  const cleanLid = jid.replace(/:\d+@/, "@");

  // 1) Mapping learned from events.
  if (cache?.has(cleanLid)) {
    return cache.get(cleanLid);
  }

  // 2) Our own account (e.g. testing with the linked phone itself).
  const ownLid = socket.user?.lid?.replace(/:\d+@/, "@");
  const ownPn = normalizePhoneJid(socket.user?.id);

  if (ownLid && ownPn && ownLid === cleanLid) {
    return ownPn;
  }

  // 3) Baileys persistent LID mapping store.
  try {
    const lidMapping = socket.signalRepository?.lidMapping;

    if (typeof lidMapping?.getPNForLID !== "function") {
      logger.warn(
        { jid },
        "Baileys LID mapping API is unavailable (check Baileys version, v7+ required)"
      );

      return null;
    }

    const phoneJid = normalizePhoneJid(
      await lidMapping.getPNForLID(cleanLid)
    );

    if (phoneJid) {
      cache?.set(cleanLid, phoneJid);
      return phoneJid;
    }

    logger.warn(
      { jid },
      "No phone-number mapping available yet for this LID"
    );

    return null;
  } catch (error) {
    logger.warn(
      { jid, error: error.message },
      "Failed to resolve WhatsApp LID"
    );

    return null;
  }
}

// [ADDED] Enrich message identifiers before forwarding them to Telegram.
async function enrichMessageIdentifiers(socket, message, cache) {
  const key = message?.key;

  if (!key) {
    return;
  }

  // Private conversation: resolve the remote JID if it is a LID.
  if (
    typeof key.remoteJid === "string" &&
    key.remoteJid.endsWith("@lid") &&
    !normalizePhoneJid(key.remoteJidAlt)
  ) {
    const phoneJid = await resolveLidToPhone(
      socket,
      key.remoteJid,
      cache
    );

    if (phoneJid) {
      key.remoteJidAlt = phoneJid;
    }
  }

  // Group conversation: resolve the participant LID if possible.
  if (
    typeof key.participant === "string" &&
    key.participant.endsWith("@lid") &&
    !normalizePhoneJid(key.participantAlt) &&
    !normalizePhoneJid(key.participantPn)
  ) {
    const phoneJid = await resolveLidToPhone(
      socket,
      key.participant,
      cache
    );

    if (phoneJid) {
      key.participantAlt = phoneJid;
    }
  }
}

// [ADDED] Detect a WhatsApp call-log message (Baileys spells it with 3 s).
function isCallLogMessage(message) {
  return Boolean(
    message?.message?.callLogMesssage ||
      message?.message?.callLogMessage
  );
}

function getAuthPath(telegramId) {
  const id = String(telegramId);

  if (!/^\d+$/.test(id)) {
    throw new Error("Invalid Telegram user ID.");
  }

  return path.join(AUTH_DIR, id);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function getWhatsAppStatus(telegramId) {
  const entry = connections.get(String(telegramId));

  if (!entry) {
    return {
      status: "disconnected",
      phoneNumber: null
    };
  }

  return {
    status: entry.status,
    phoneNumber: entry.phoneNumber || null
  };
}

// [ADDED] Read the linked WhatsApp account's display name and profile photo.
export async function getWhatsAppAccountProfile(telegramId) {
  const entry = connections.get(String(telegramId));
  if (!entry || entry.status !== "connected" || !entry.socket) {
    return { displayName: null, pictureUrl: null };
  }

  const user = entry.socket.user || {};
  const jid = String(user.id || "").replace(/:\d+@/, "@");
  let pictureUrl = null;

  if (jid) {
    try {
      pictureUrl = await entry.socket.profilePictureUrl(jid, "image");
    } catch {
      try {
        pictureUrl = await entry.socket.profilePictureUrl(jid, "preview");
      } catch {
        pictureUrl = null;
      }
    }
  }

  return {
    displayName: user.name || user.notify || null,
    pictureUrl: pictureUrl || null
  };
}

// [ADDED] Expose the current pairing QR only to the authenticated Mini App API.
export function getWhatsAppQr(telegramId) {
  const entry = connections.get(String(telegramId));
  return entry?.status === "qr" ? entry.qr || null : null;
}

// [ADDED] Resolve a WhatsApp LID to its public phone number for profile display.
export async function getWhatsAppPhoneNumber(telegramId, whatsappJid) {
  const entry = connections.get(String(telegramId));

  if (!entry || entry.status !== "connected" || !entry.socket) {
    return null;
  }

  const jid = String(whatsappJid || "");
  const direct = normalizePhoneJid(jid);

  if (direct) {
    return direct.split("@")[0];
  }

  if (!jid.endsWith("@lid")) {
    return null;
  }

  const phoneJid = await resolveLidToPhone(
    entry.socket,
    jid,
    entry.lidCache
  );

  return phoneJid ? phoneJid.split("@")[0] : null;
}

// [ADDED] Fetch a contact or group profile on demand through its own WhatsApp session.
export async function getWhatsAppProfile(telegramId, whatsappJid) {
  const entry = connections.get(String(telegramId));

  if (!entry || entry.status !== "connected" || !entry.socket) {
    throw new Error("WHATSAPP_NOT_CONNECTED");
  }

  const socket = entry.socket;
  const jid = String(whatsappJid || "");

  const withTimeout = (promise, timeoutMs) => new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("PROFILE_REQUEST_TIMEOUT")),
      timeoutMs
    );

    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });

  const [pictureResult, statusResult] = await Promise.allSettled([
    withTimeout(socket.profilePictureUrl(jid, "image", 12000), 13000)
      .catch(() => withTimeout(socket.profilePictureUrl(jid, "preview", 8000), 9000)),
    withTimeout(socket.fetchStatus(jid), 10000)
  ]);

  const pictureUrl = pictureResult.status === "fulfilled"
    ? pictureResult.value || null
    : null;
  const status = statusResult.status === "fulfilled"
    ? statusResult.value || null
    : null;

  return {
    pictureUrl,
    aboutText: typeof status?.status === "string" ? status.status : null,
    statusSetAt: status?.setAt instanceof Date
      ? status.setAt.getTime()
      : status?.setAt
        ? new Date(status.setAt).getTime() || null
        : null
  };
}

export async function connectWhatsApp(telegramId, callbacks = {}) {
  const id = String(telegramId);

  if (!/^\d+$/.test(id)) {
    throw new Error("Invalid Telegram user ID.");
  }

  const existing = connections.get(id);

  if (
    existing &&
    ["connecting", "qr", "connected"].includes(existing.status)
  ) {
    return {
      status: existing.status,
      phoneNumber: existing.phoneNumber || null
    };
  }

  intentionalDisconnects.delete(id);

  const entry = {
    socket: null,
    status: "connecting",
    phoneNumber: null,
    qr: null, // [ADDED] Current Baileys pairing QR for the Mini App.
    reconnectTimer: null,
    reconnectDelay: INITIAL_RECONNECT_DELAY,
    stopping: false,
    lidCache: new Map(),
    callbacks
  };

  connections.set(id, entry);

  await createSocket(id, entry);

  return {
    status: entry.status,
    phoneNumber: entry.phoneNumber
  };
}

async function createSocket(id, entry) {
  if (entry.stopping || intentionalDisconnects.has(id)) {
    return;
  }

  const authPath = getAuthPath(id);
  fs.mkdirSync(authPath, { recursive: true });

  try {
    const { state, saveCreds } = await useMultiFileAuthState(authPath);

    if (entry.stopping || intentionalDisconnects.has(id)) {
      return;
    }

    // [ADDED] Never keep two sockets alive for the same session.
    if (entry.socket) {
      try {
        entry.socket.end(undefined);
      } catch {
        // Previous socket was already closed.
      }

      entry.socket = null;
    }

    const socket = makeWASocket({
      auth: state,
      logger,
      printQRInTerminal: false,
      browser: ["WhatsApp Bridge", "Chrome", "1.0.0"],
      markOnlineOnConnect: false,
      syncFullHistory: false,
      shouldSyncHistoryMessage: () => false,
      generateHighQualityLinkPreview: false,
      keepAliveIntervalMs: KEEPALIVE_MS,
      connectTimeoutMs: CONNECT_TIMEOUT_MS,
      defaultQueryTimeoutMs: 60000,
      retryRequestDelayMs: 500,
      // Needed so WhatsApp message retries do not fail the session.
      getMessage: async () => undefined
    });

    entry.socket = socket;
    entry.status = "connecting";
    entry.callbacks.onStatus?.("connecting");

    socket.ev.on("creds.update", saveCreds);

    // [MODIFIED] Learn LID-to-PN mappings from Baileys events.
    socket.ev.on("lid-mapping.update", (mapping) => {
      const list = Array.isArray(mapping) ? mapping : [mapping];

      for (const item of list) {
        rememberMapping(entry.lidCache, item?.lid, item?.pn);
      }
    });

    socket.ev.on("contacts.upsert", (contacts) => {
      learnFromContacts(entry.lidCache, contacts);
    });

    socket.ev.on("contacts.update", (contacts) => {
      learnFromContacts(entry.lidCache, contacts);
    });

    // Handle QR, successful connection, and reconnect.
    socket.ev.on("connection.update", async (update) => {
      // [MODIFIED] Ignore events from a stale (replaced) socket.
      if (
        connections.get(id) !== entry ||
        entry.stopping ||
        entry.socket !== socket
      ) {
        return;
      }

      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        entry.qr = qr; // [ADDED] Keep the latest QR until it is scanned or replaced.
        entry.status = "qr";

        try {
          await entry.callbacks.onQr?.(qr);
        } catch (error) {
          logger.error(
            { err: error, telegramId: id },
            "QR callback failed"
          );
        }

        entry.callbacks.onStatus?.("qr");
      }

      if (connection === "open") {
        entry.qr = null; // [ADDED] Never expose a QR after successful pairing.
        entry.status = "connected";
        entry.connectedAt = Date.now();

        entry.phoneNumber = socket.user?.id?.split(":")[0] || null;

        entry.callbacks.onStatus?.(
          "connected",
          entry.phoneNumber
        );
      }

      if (connection === "close") {
        entry.socket = null;

        const statusCode =
          lastDisconnect?.error?.output?.statusCode;

        const loggedOut =
          statusCode === DisconnectReason.loggedOut;

        const replaced =
          statusCode === DisconnectReason.connectionReplaced;

        const restartRequired =
          statusCode === DisconnectReason.restartRequired;

        // [ADDED] Reset the backoff only after a stable connection.
        if (
          entry.connectedAt &&
          Date.now() - entry.connectedAt > STABLE_CONNECTION_MS
        ) {
          entry.reconnectDelay = INITIAL_RECONNECT_DELAY;
        }

        entry.connectedAt = null;

        if (entry.stopping || intentionalDisconnects.has(id)) {
          entry.status = "disconnected";

          entry.callbacks.onStatus?.("disconnected", null, {
            intentional: true
          });

          return;
        }

        if (loggedOut) {
          entry.status = "logged_out";
          entry.callbacks.onStatus?.("logged_out");
          entry.callbacks.onLoggedOut?.();
          return;
        }

        // [ADDED] Another login/instance took over this session.
        // Reconnecting would start a fight loop, so stop here.
        if (replaced) {
          logger.warn(
            { telegramId: id },
            "WhatsApp session replaced by another connection"
          );

          entry.status = "replaced";
          entry.callbacks.onStatus?.("replaced");
          return;
        }

        logger.warn(
          { telegramId: id, statusCode },
          "WhatsApp connection closed, reconnecting"
        );

        entry.status = "disconnected";

        entry.callbacks.onStatus?.("disconnected", null, {
          statusCode
        });

        // 515 (restart required) is expected after pairing: retry fast.
        scheduleReconnect(
          id,
          entry,
          restartRequired ? 500 : undefined
        );
      }
    });

    // [MODIFIED] Forward real-time messages, including outgoing messages.
    socket.ev.on("messages.upsert", async ({ messages, type }) => {
      if (connections.get(id) !== entry || entry.stopping) {
        return;
      }

      for (const message of messages || []) {
        if (!message?.key || !message.message) {
          continue;
        }

        // [MODIFIED] Log View Once metadata when CALL_DEBUG=1 without logging media content.
        if (process.env.CALL_DEBUG === "1") {
          const imageMessage = message.message.imageMessage;
          const videoMessage = message.message.videoMessage;
          const audioMessage = message.message.audioMessage;

          logger.warn(
            {
              telegramId: id,
              type,
              fromMe: Boolean(message.key.fromMe),
              keys: Object.keys(message.message),
              isViewOnce: Boolean(message.key.isViewOnce),
              imageViewOnce: Boolean(imageMessage?.viewOnce),
              videoViewOnce: Boolean(videoMessage?.viewOnce),
              audioViewOnce: Boolean(audioMessage?.viewOnce)
            },
            "WhatsApp message upsert"
          );
        }

        // [MODIFIED] Only "notify" is real-time, except call logs: outgoing
        // calls may arrive as a call-log message with another upsert type.
        if (type !== "notify" && !isCallLogMessage(message)) {
          continue;
        }

        if (message.key.remoteJid === "status@broadcast") {
          continue;
        }

        try {
          // [ADDED] Resolve LID before Telegram formats the sender.
          await enrichMessageIdentifiers(
            socket,
            message,
            entry.lidCache
          );

          await entry.callbacks.onMessage?.({
            telegramId: id,
            message,
            socket
          });
        } catch (error) {
          logger.error(
            {
              err: error,
              telegramId: id,
              messageId: message.key.id
            },
            "Message forwarding callback failed"
          );
        }
      }
    });

    // [MODIFIED] Forward call events (offer / timeout / reject / ...).
    socket.ev.on("call", async (events) => {
      if (connections.get(id) !== entry || entry.stopping) {
        return;
      }

      for (const call of events || []) {
        // [ADDED] Set CALL_DEBUG=1 in .env to log every raw call event.
        if (process.env.CALL_DEBUG === "1") {
          logger.warn({ telegramId: id, call }, "WhatsApp call event");
        }

        try {
          // [ADDED] Resolve a LID caller to a phone number when possible.
          if (
            typeof call?.from === "string" &&
            call.from.endsWith("@lid") &&
            !normalizePhoneJid(call.callerPn)
          ) {
            const phoneJid = await resolveLidToPhone(
              socket,
              call.from,
              entry.lidCache
            );

            if (phoneJid) {
              call.callerPn = phoneJid;
            }
          }

          await entry.callbacks.onCall?.({
            telegramId: id,
            call,
            socket
          });
        } catch (error) {
          logger.error(
            { err: error, telegramId: id },
            "Call event callback failed"
          );
        }
      }
    });
  } catch (error) {
    entry.socket = null;

    if (!entry.stopping && !intentionalDisconnects.has(id)) {
      logger.error(
        { err: error, telegramId: id },
        "Failed to create WhatsApp connection"
      );

      entry.callbacks.onError?.(error);
      scheduleReconnect(id, entry);
    }
  }
}

function scheduleReconnect(id, entry, delayOverride) {
  if (
    connections.get(id) !== entry ||
    entry.stopping ||
    intentionalDisconnects.has(id) ||
    entry.reconnectTimer
  ) {
    return;
  }

  const delay =
    typeof delayOverride === "number"
      ? delayOverride
      : entry.reconnectDelay;

  if (typeof delayOverride !== "number") {
    entry.reconnectDelay = Math.min(
      entry.reconnectDelay * 2,
      MAX_RECONNECT_DELAY
    );
  }

  entry.reconnectTimer = setTimeout(async () => {
    entry.reconnectTimer = null;

    if (
      connections.get(id) !== entry ||
      entry.stopping ||
      intentionalDisconnects.has(id)
    ) {
      return;
    }

    await createSocket(id, entry);
  }, delay);

  entry.reconnectTimer.unref?.();
}

export async function disconnectWhatsApp(telegramId, options = {}) {
  const id = String(telegramId);
  const entry = connections.get(id);

  intentionalDisconnects.add(id);

  if (entry) {
    entry.stopping = true;

    if (entry.reconnectTimer) {
      clearTimeout(entry.reconnectTimer);
      entry.reconnectTimer = null;
    }

    try {
      if (entry.socket) {
        if (options.logout === true) {
          await entry.socket.logout();
        } else {
          entry.socket.end(undefined);
        }
      }
    } catch (error) {
      logger.warn(
        { err: error, telegramId: id },
        "Error closing WhatsApp connection"
      );
    }

    entry.socket = null;
    entry.status = "disconnected";

    entry.callbacks.onStatus?.("disconnected", null, {
      intentional: true
    });

    connections.delete(id);
  }

  if (options.clearAuth === true) {
    fs.rmSync(getAuthPath(id), {
      recursive: true,
      force: true
    });
  }

  return {
    status: "disconnected",
    credentialsDeleted: options.clearAuth === true
  };
}

export async function restoreWhatsAppSessions(
  sessions,
  callbacksFactory
) {
  for (const session of sessions || []) {
    const id = String(session.telegram_id);
    const authPath = getAuthPath(id);

    if (
      session.is_active === 0 ||
      !fs.existsSync(authPath) ||
      intentionalDisconnects.has(id)
    ) {
      continue;
    }

    if (connections.has(id)) {
      continue;
    }

    try {
      await connectWhatsApp(id, callbacksFactory(id));
    } catch (error) {
      logger.error(
        { err: error, telegramId: id },
        "Failed to restore WhatsApp session"
      );
    }

    await wait(250);
  }
}

export async function shutdownWhatsApp() {
  const ids = [...connections.keys()];

  await Promise.all(
    ids.map((id) => disconnectWhatsApp(id))
  );
}
