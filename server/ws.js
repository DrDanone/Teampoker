import { WebSocketServer } from 'ws';

/** Maximale Größe einer eingehenden WebSocket-Nachricht in Bytes. */
export const MAX_MESSAGE_BYTES = 4 * 1024;

export const WS_PATH = '/ws';

/**
 * Hängt den WebSocket-Endpunkt an den HTTP-Server.
 * Platzhalter für Issue #5/#6: beantwortet bisher nur `ping`.
 *
 * @param {import('node:http').Server} server
 */
export function attachWebSocket(server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });

  server.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url ?? '/', 'http://localhost');
    if (pathname !== WS_PATH) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws) => {
    // Fehler einer einzelnen Verbindung (z. B. übergroße Nachricht) dürfen
    // den Server nicht beenden; `ws` schließt die Verbindung selbst.
    ws.on('error', () => {});

    ws.on('message', (data, isBinary) => {
      const message = isBinary ? null : parseMessage(data.toString());
      if (!message) {
        send(ws, { type: 'error', message: 'Ungültige Nachricht' });
        return;
      }
      if (message.type === 'ping') {
        send(ws, { type: 'pong' });
        return;
      }
      send(ws, { type: 'error', message: 'Unbekannter Nachrichtentyp' });
    });
  });

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

function send(ws, payload) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
}
