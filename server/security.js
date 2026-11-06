import { isHttps } from './http.js';

/**
 * Content-Security-Policy für alle Seiten: nur eigene Skripte, Styles,
 * Bilder und Verbindungen; keine Inline-Skripte, kein Einbetten in Frames.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

/**
 * Setzt Sicherheits-Header für jede HTTP-Antwort. Einzelne Antworten
 * (z. B. das Logo) dürfen die CSP strenger überschreiben.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 */
export function applySecurityHeaders(req, res) {
  res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  // Der Einladungslink enthält den Raum-Code – nie als Referrer weitergeben.
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  if (isHttps(req)) {
    res.setHeader('Strict-Transport-Security', 'max-age=15552000');
  }
}

/**
 * Prüft den Origin-Header gegen den Host. Browser schicken ihn bei
 * WebSocket-Verbindungen immer mit; fehlt er, ist es kein Browser und
 * damit kein Cross-Site-Angriff möglich.
 *
 * @param {import('node:http').IncomingMessage} req
 */
export function isSameOrigin(req) {
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}
