import { WebSocketServer, WebSocket } from 'ws';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { one } from '../db/database.js';
import { loadUser, isPolice } from '../middleware/auth.js';

/**
 * Realtime hub. v1 broadcast every event, including every vehicle's live GPS, to
 * anyone who opened a socket. Now a client must authenticate first and only
 * receives what is addressed to its user or to the police channel.
 */
const clients = new Map(); // ws -> { userId, police }

export function attachHub(server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    if (!req.url?.startsWith('/ws')) return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });
  wss.on('connection', (ws) => {
    const timer = setTimeout(() => ws.close(4001, 'auth timeout'), 5000);
    ws.on('message', (raw) => {
      let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.type === 'AUTH' && !clients.has(ws)) {
        try {
          const { id } = jwt.verify(String(msg.token), config.jwtSecret);
          const user = loadUser(id);
          if (!user) throw new Error('no user');
          clearTimeout(timer);
          clients.set(ws, { userId: user.id, police: isPolice(user) });
          ws.send(JSON.stringify({ type: 'READY', police: isPolice(user) }));
        } catch { ws.close(4003, 'bad token'); }
      } else if (msg.type === 'PING') ws.send(JSON.stringify({ type: 'PONG', t: Date.now() }));
    });
    ws.on('close', () => { clearTimeout(timer); clients.delete(ws); });
    ws.on('error', () => { clients.delete(ws); });
  });
  return wss;
}

const send = (ws, payload) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload)); };
export const sendToUser = (userId, payload) => { for (const [ws, c] of clients) if (c.userId === userId) send(ws, payload); };
export const sendToPolice = (payload) => { for (const [ws, c] of clients) if (c.police) send(ws, payload); };
export const hubStats = () => ({ connected: clients.size, police: [...clients.values()].filter((c) => c.police).length });
