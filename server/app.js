import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createAdminApi } from './admin/routes.js';
import { sendJson, sendText } from './http.js';
import { PokerHub } from './poker/hub.js';
import { createStaticHandler } from './static.js';
import { attachWebSocket } from './ws.js';

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');
const JOIN_PATH = /^\/join\/[A-Za-z0-9-]{1,32}\/?$/;

/**
 * Erstellt den HTTP-Server mit WebSocket-Endpunkt, startet ihn aber noch nicht.
 *
 * @param {ReturnType<import('./config.js').loadConfig>} config
 * @param {object} deps
 * @param {import('./rooms/store.js').RoomStore} deps.rooms geladener Raum-Speicher
 * @param {Parameters<typeof createAdminApi>[0]['sessions']} [deps.sessions]
 * @param {Parameters<typeof createAdminApi>[0]['loginLimiter']} [deps.loginLimiter]
 * @param {Partial<ConstructorParameters<typeof PokerHub>[0]>} [deps.hubOptions]
 */
export function createApp(config, { rooms, sessions, loginLimiter, hubOptions = {} }) {
  const serveStatic = createStaticHandler(PUBLIC_DIR);
  const hub = new PokerHub({ rooms, ...hubOptions });
  const handleAdminApi = createAdminApi({
    rooms,
    adminPassword: config.adminPassword,
    sessions,
    loginLimiter,
  });

  async function handleRequest(req, res) {
    const { pathname } = new URL(req.url ?? '/', 'http://localhost');

    if (await handleAdminApi(req, res, pathname)) return;
    if (pathname.startsWith('/api/')) {
      sendJson(res, 404, { error: 'Nicht gefunden' });
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendText(res, 405, 'Methode nicht erlaubt', { Allow: 'GET, HEAD' });
      return;
    }

    if (pathname === '/healthz') {
      sendText(res, 200, 'ok');
      return;
    }

    if (pathname === '/admin') {
      res.writeHead(301, { Location: '/admin/' });
      res.end();
      return;
    }

    // Einladungslink: Startseite ausliefern, der Code wird im Browser übernommen.
    if (JOIN_PATH.test(pathname)) {
      if (await serveStatic(req, res, '/index.html')) return;
    }

    if (await serveStatic(req, res, pathname)) return;

    sendText(res, 404, 'Nicht gefunden');
  }

  const server = http.createServer(async (req, res) => {
    try {
      await handleRequest(req, res);
    } catch (error) {
      console.error('Fehler bei der Anfrage:', error);
      if (!res.headersSent) sendText(res, 500, 'Interner Fehler');
      else res.destroy();
    }
  });

  const wss = attachWebSocket(server, { hub });

  /** Beendet Server und alle WebSocket-Verbindungen. */
  async function close() {
    hub.close();
    for (const client of wss.clients) client.terminate();
    await new Promise((resolve) => wss.close(resolve));
    await new Promise((resolve) => server.close(resolve));
  }

  return { server, close, hub };
}
