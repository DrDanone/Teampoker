import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createStaticHandler } from './static.js';
import { attachWebSocket } from './ws.js';

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');

/**
 * Erstellt den HTTP-Server mit WebSocket-Endpunkt, startet ihn aber noch nicht.
 *
 * @param {ReturnType<import('./config.js').loadConfig>} _config
 */
export function createApp(_config) {
  const serveStatic = createStaticHandler(PUBLIC_DIR);

  const server = http.createServer(async (req, res) => {
    try {
      await handleRequest(req, res, serveStatic);
    } catch (error) {
      console.error('Fehler bei der Anfrage:', error);
      if (!res.headersSent) sendText(res, 500, 'Interner Fehler');
      else res.destroy();
    }
  });

  const wss = attachWebSocket(server);

  /** Beendet Server und alle WebSocket-Verbindungen. */
  async function close() {
    for (const client of wss.clients) client.terminate();
    await new Promise((resolve) => wss.close(resolve));
    await new Promise((resolve) => server.close(resolve));
  }

  return { server, close };
}

async function handleRequest(req, res, serveStatic) {
  const { pathname } = new URL(req.url ?? '/', 'http://localhost');

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    sendText(res, 405, 'Methode nicht erlaubt');
    return;
  }

  if (pathname === '/healthz') {
    sendText(res, 200, 'ok');
    return;
  }

  if (await serveStatic(req, res, pathname)) return;

  sendText(res, 404, 'Nicht gefunden');
}

function sendText(res, status, text) {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(text);
}
