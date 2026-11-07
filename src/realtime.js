// [ADDED] Per-user WebSocket fan-out for Mini App clients.
const clientsByUser = new Map();

export function addMiniAppClient(telegramId, socket) {
  const id = String(telegramId);
  let clients = clientsByUser.get(id);
  if (!clients) {
    clients = new Set();
    clientsByUser.set(id, clients);
  }
  clients.add(socket);
  socket.once("close", () => {
    clients.delete(socket);
    if (clients.size === 0) clientsByUser.delete(id);
  });
}

export function publishToMiniApp(telegramId, event) {
  const clients = clientsByUser.get(String(telegramId));
  if (!clients?.size) return 0;
  const payload = JSON.stringify({ ...event, sentAt: Date.now() });
  let delivered = 0;
  for (const socket of clients) {
    if (socket.readyState !== 1) continue;
    try { socket.send(payload); delivered += 1; } catch { /* close handler cleans up */ }
  }
  return delivered;
}

export function closeMiniAppClients() {
  for (const clients of clientsByUser.values()) {
    for (const socket of clients) {
      try { socket.close(1001, "Server shutting down"); }
      catch { socket.terminate?.(); }
    }
  }
  clientsByUser.clear();
}
