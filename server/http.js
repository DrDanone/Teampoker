/** Fehler mit HTTP-Status; `message` darf dem Benutzer angezeigt werden. */
export class HttpError extends Error {
  constructor(status, message, headers = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.headers = headers;
  }
}

export const MAX_JSON_BODY_BYTES = 10 * 1024;

/**
 * Liest einen JSON-Body. Verlangt `Content-Type: application/json`
 * (verhindert u. a. Cross-Site-Formular-Posts) und begrenzt die Größe.
 *
 * @param {import('node:http').IncomingMessage} req
 */
export async function readJson(req, limit = MAX_JSON_BODY_BYTES) {
  const type = (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') {
    throw new HttpError(415, 'Erwartet application/json');
  }
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) {
    throw new HttpError(413, 'Anfrage zu groß');
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'Anfrage zu groß');
    chunks.push(chunk);
  }

  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw new HttpError(400, 'Ungültiges JSON');
  }
}

/**
 * Liest einen Body als Buffer mit Größenlimit.
 *
 * @param {import('node:http').IncomingMessage} req
 */
export async function readRaw(req, limit, tooLargeMessage = 'Anfrage zu groß') {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) throw new HttpError(413, tooLargeMessage);
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, tooLargeMessage);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function sendJson(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

export function sendText(res, status, text, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    ...headers,
  });
  res.end(text);
}

/** Liest Cookies aus dem Request-Header. */
export function parseCookies(req) {
  const cookies = {};
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (name && !(name in cookies)) cookies[name] = value;
  }
  return cookies;
}

/** Ob die Anfrage über HTTPS kam (direkt oder über einen Reverse Proxy). */
export function isHttps(req) {
  if (req.socket.encrypted) return true;
  // Ein gefälschter Header kann hier nur dazu führen, dass Cookies
  // strenger (mit Secure) gesetzt werden – daher unkritisch.
  return (
    String(req.headers['x-forwarded-proto'] ?? '')
      .split(',')[0]
      .trim() === 'https'
  );
}

/** Client-Adresse; wird pro Anfrage in app.js über `resolveClientIp` gesetzt. */
export function clientIp(req) {
  return req.clientIp ?? req.socket.remoteAddress ?? 'unbekannt';
}

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Maskiert Text für die Ausgabe in HTML (Inhalt und Attributwerte). */
export function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]);
}
