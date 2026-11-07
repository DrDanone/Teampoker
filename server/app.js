import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createAdminApi, logoInfo } from './admin/routes.js';
import { sendJson, sendText } from './http.js';
import { isAdminAllowed, resolveClientIp } from './network.js';
import { PokerHub } from './poker/hub.js';
import { applySecurityHeaders } from './security.js';
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
 * @param {import('./branding/logo.js').LogoStore} deps.logo geladener Logo-Speicher
 * @param {Parameters<typeof createAdminApi>[0]['sessions']} [deps.sessions]
 * @param {Parameters<typeof createAdminApi>[0]['loginLimiter']} [deps.loginLimiter]
 * @param {Partial<ConstructorParameters<typeof PokerHub>[0]>} [deps.hubOptions]
 * @param {{ limits?: Partial<import('./ws.js').LIMITS> }} [deps.wsOptions]
 */
export function createApp(
  config,
  { rooms, logo, sessions, loginLimiter, hubOptions = {}, wsOptions = {} },
) {
  // Zweite Sicherung: Dateien unter public/admin/ werden nur ausgeliefert,
  // wenn die Verwaltung für diese Anfrage erlaubt ist – unabhängig davon,
  // wie der Pfad geschrieben wurde.
  const serveStatic = createStaticHandler(PUBLIC_DIR, {
    isDenied: (req, relativePath) =>
      isAdminFile(relativePath) && !isAdminAllowed(req, config.adminNetworks),
  });
  const hub = new PokerHub({ rooms, ...hubOptions });
  const handleAdminApi = createAdminApi({
    rooms,
    logo,
    adminPassword: config.adminPassword,
    publicUrl: config.publicUrl,
    sessions,
    loginLimiter,
  });

  async function handleRequest(req, res) {
    const { pathname } = new URL(req.url ?? '/', 'http://localhost');

    // Die Verwaltung gibt es nur im Heimnetz. Von außen (Tunnel) sieht sie
    // aus, als gäbe es sie nicht.
    if (isAdminPath(pathname) && !isAdminAllowed(req, config.adminNetworks)) {
      if (pathname.startsWith('/api/')) sendJson(res, 404, { error: 'Nicht gefunden' });
      else sendText(res, 404, 'Nicht gefunden');
      return;
    }

    if (await handleAdminApi(req, res, pathname)) return;
    if (pathname === '/api/branding' && req.method === 'GET') {
      sendJson(res, 200, { logo: logoInfo(logo.get()) });
      return;
    }
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

    if (pathname === '/logo') {
      serveLogo(req, res, logo.get());
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
    applySecurityHeaders(req, res);
    req.clientIp = resolveClientIp(req, config.trustedProxies);
    try {
      await handleRequest(req, res);
    } catch (error) {
      console.error('Fehler bei der Anfrage:', error);
      if (!res.headersSent) sendText(res, 500, 'Interner Fehler');
      else res.destroy();
    }
  });

  // WebSocket-Upgrades laufen am Request-Handler vorbei – Client-Adresse hier setzen.
  server.prependListener('upgrade', (req) => {
    req.clientIp = resolveClientIp(req, config.trustedProxies);
  });
  const wss = attachWebSocket(server, { hub, ...wsOptions });

  // Langsame oder hängende Anfragen nicht ewig offen halten.
  server.headersTimeout = 20_000;
  server.requestTimeout = 30_000;

  /** Beendet Server und alle WebSocket-Verbindungen. */
  async function close() {
    hub.close();
    for (const client of wss.clients) client.terminate();
    await new Promise((resolve) => wss.close(resolve));
    await new Promise((resolve) => server.close(resolve));
  }

  return { server, close, hub };
}

/**
 * Liefert das Logo aus. Die CSP mit `sandbox` verhindert, dass ein SVG beim
 * direkten Aufruf Skripte im Kontext der Website ausführt.
 */
function serveLogo(req, res, current) {
  if (!current) {
    sendText(res, 404, 'Kein Logo');
    return;
  }
  const headers = {
    'Content-Type': current.type,
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy':
      "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox",
    'Cache-Control': 'no-cache',
    ETag: current.etag,
  };
  if (req.headers['if-none-match'] === current.etag) {
    res.writeHead(304, headers);
    res.end();
    return;
  }
  res.writeHead(200, { ...headers, 'Content-Length': current.data.length });
  res.end(req.method === 'HEAD' ? undefined : current.data);
}

/**
 * Ob der Pfad zur Verwaltung gehört. Geprüft werden die rohe, die dekodierte
 * und die normalisierte Form – so wie die statische Auslieferung den Pfad
 * auflöst –, damit z. B. `/%61dmin/`, `/%2fadmin/` oder `/x/..%2fadmin/`
 * nicht an der Sperre vorbei ausgeliefert werden.
 */
export function isAdminPath(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    decoded = pathname;
  }
  const normalized = path.posix.normalize(`/${decoded}`);
  return [pathname, decoded, normalized].some((candidate) => {
    const lower = candidate.toLowerCase();
    return (
      lower === '/admin' ||
      lower.startsWith('/admin/') ||
      lower === '/api/admin' ||
      lower.startsWith('/api/admin/')
    );
  });
}

function isAdminFile(relativePath) {
  const first = relativePath.split(/[\\/]/)[0].toLowerCase();
  return first === 'admin';
}
