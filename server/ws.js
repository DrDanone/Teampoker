import { WebSocketServer } from 'ws';

import { clientIp } from './http.js';
import { send } from './poker/hub.js';

/** Maximale Größe einer eingehenden WebSocket-Nachricht in Bytes. */
export const MAX_MESSAGE_BYTES = 4 * 1024;

export const WS_PATH = '/ws';

/** Abstand der Lebenszeichen; wer zweimal nicht antwortet, wird getrennt. */
export const HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * Hängt den WebSocket-Endpunkt an den HTTP-Server und reicht Nachrichten
 * an den PokerHub weiter.
 *
 * @param {import('node:http').Server} server
 * @param {object} options
 * @param {import('./poker/hub.js').PokerHub} options.hub
 * @param {number} [options.heartbeatMs]
 */
export function attachWebSocket(server, { hub, heartbeatMs = HEARTBEAT_INTERVAL_MS }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });

  server.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url ?? '/', 'http://localhost');
    if (pathname !== WS_PATH) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws, req) => {
    const ip = clientIp(req);
    ws.isAlive = true;

    // Fehler einer einzelnen Verbindung (z. B. übergroße Nachricht) dürfen
    // den Server nicht beenden; `ws` schließt die Verbindung selbst.
    ws.on('error', () => {});
    ws.on('pong', () => {
      ws.isAlive = true;
    });
    ws.on('close', () => hub.handleClose(ws));

    ws.on('message', (data, isBinary) => {
      ws.isAlive = true;
      const message = isBinary ? null : parseMessage(data.toString());
      if (!message) {
        send(ws, { type: 'error', code: 'invalid-message', message: 'Ungültige Nachricht' });
        return;
      }
      if (message.type === 'ping') {
        send(ws, { type: 'pong' });
        return;
      }
      try {
        if (!hub.handleMessage(ws, ip, message)) {
          send(ws, {
            type: 'error',
            code: 'invalid-message',
            message: 'Unbekannter Nachrichtentyp',
          });
        }
      } catch (error) {
        console.error('Fehler bei WebSocket-Nachricht:', error);
        send(ws, { type: 'error', code: 'internal', message: 'Interner Fehler' });
      }
    });
  });

  // Tote Verbindungen (z. B. WLAN weg) erkennen, damit der Teilnehmer offline erscheint.
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, heartbeatMs);
  heartbeat.unref();
  wss.on('close', () => clearInterval(heartbeat));

  return wss;
}

function parseMessage(text) {
  try {
    const value = JSON.parse(text);
    if (value && typeof value === 'object' && typeof value.type === 'string') return value;
  } catch {
    // ungültiges JSON
  }
  return null;
}
