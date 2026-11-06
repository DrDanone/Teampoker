import { WebSocketServer } from 'ws';

import { clientIp } from './http.js';
import { send } from './poker/hub.js';
import { isSameOrigin } from './security.js';

/** Maximale Größe einer eingehenden WebSocket-Nachricht in Bytes. */
export const MAX_MESSAGE_BYTES = 4 * 1024;

export const WS_PATH = '/ws';

/** Abstand der Lebenszeichen; wer zweimal nicht antwortet, wird getrennt. */
export const HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * Grenzen gegen Überlastung. Hinter einem Tunnel oder Reverse Proxy teilen
 * sich alle dieselbe IP – die Grenze pro IP ist deshalb großzügig.
 */
export const LIMITS = {
  maxConnections: 1000,
  maxConnectionsPerIp: 200,
  /** Nachrichten pro Sekunde im Mittel und kurzfristig erlaubte Spitze. */
  messagesPerSecond: 10,
  messageBurst: 30,
};

/** WebSocket-Close-Code bei Verstoß gegen die Regeln (RFC 6455). */
export const CLOSE_POLICY_VIOLATION = 1008;

/**
 * Hängt den WebSocket-Endpunkt an den HTTP-Server und reicht Nachrichten
 * an den PokerHub weiter.
 *
 * @param {import('node:http').Server} server
 * @param {object} options
 * @param {import('./poker/hub.js').PokerHub} options.hub
 * @param {number} [options.heartbeatMs]
 */
export function attachWebSocket(
  server,
  { hub, heartbeatMs = HEARTBEAT_INTERVAL_MS, limits: limitOverrides = {} },
) {
  const limits = { ...LIMITS, ...limitOverrides };
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
  /** @type {Map<string, number>} offene Verbindungen pro IP */
  const perIp = new Map();

  server.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url ?? '/', 'http://localhost');
    if (pathname !== WS_PATH) {
      socket.destroy();
      return;
    }
    // Schutz gegen Cross-Site-WebSocket-Hijacking: nur von der eigenen Seite.
    if (!isSameOrigin(req)) {
      reject(socket, 403, 'Forbidden');
      return;
    }
    const ip = clientIp(req);
    if (
      wss.clients.size >= limits.maxConnections ||
      (perIp.get(ip) ?? 0) >= limits.maxConnectionsPerIp
    ) {
      reject(socket, 429, 'Too Many Requests');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws, req) => {
    const ip = clientIp(req);
    perIp.set(ip, (perIp.get(ip) ?? 0) + 1);
    ws.once('close', () => {
      const count = (perIp.get(ip) ?? 1) - 1;
      if (count > 0) perIp.set(ip, count);
      else perIp.delete(ip);
    });
    ws.isAlive = true;
    const bucket = { tokens: limits.messageBurst, last: Date.now() };

    // Fehler einer einzelnen Verbindung (z. B. übergroße Nachricht) dürfen
    // den Server nicht beenden; `ws` schließt die Verbindung selbst.
    ws.on('error', () => {});
    ws.on('pong', () => {
      ws.isAlive = true;
    });
    ws.on('close', () => hub.handleClose(ws));

    ws.on('message', (data, isBinary) => {
      ws.isAlive = true;
      if (!takeToken(bucket, limits)) {
        ws.close(CLOSE_POLICY_VIOLATION, 'Zu viele Nachrichten');
        return;
      }
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

/** Token-Bucket: erlaubt kurze Spitzen, begrenzt aber den Dauerbeschuss. */
function takeToken(bucket, limits) {
  const now = Date.now();
  bucket.tokens = Math.min(
    limits.messageBurst,
    bucket.tokens + ((now - bucket.last) / 1000) * limits.messagesPerSecond,
  );
  bucket.last = now;
  if (bucket.tokens < 1) return false;
  bucket.tokens -= 1;
  return true;
}

function reject(socket, status, text) {
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
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
