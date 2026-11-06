import { BlockList, isIP } from 'node:net';

/** Private Adressbereiche: Heimnetz, Docker-Netze, localhost. */
export const PRIVATE_NETWORKS = [
  '127.0.0.0/8',
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '::1/128',
  'fc00::/7',
  'fe80::/10',
].join(',');

/**
 * Header, mit denen Proxys und Tunnel die ursprüngliche Client-Adresse
 * weitergeben. Cloudflare setzt `CF-Connecting-IP` immer und überschreibt
 * einen vom Client mitgeschickten Wert.
 */
const FORWARDING_HEADERS = [
  'cf-connecting-ip',
  'true-client-ip',
  'x-forwarded-for',
  'x-real-ip',
  'forwarded',
];

/**
 * Liest eine kommagetrennte Liste von Netzen (CIDR oder einzelne Adressen).
 * `*` bedeutet: keine Einschränkung (`null`).
 *
 * @param {string} value
 * @param {string} name Name der Einstellung für Fehlermeldungen
 * @returns {BlockList | null}
 */
export function parseNetworks(value, name) {
  const trimmed = value.trim();
  if (trimmed === '*') return null;
  const list = new BlockList();
  for (const entry of trimmed.split(',').map((part) => part.trim())) {
    if (!entry) continue;
    const [address, prefixText] = entry.split('/');
    const type = isIP(address);
    if (type === 0) throw new Error(`${name}: ungültige Adresse „${entry}“`);
    const family = type === 4 ? 'ipv4' : 'ipv6';
    if (prefixText === undefined) {
      list.addAddress(address, family);
      continue;
    }
    const prefix = Number(prefixText);
    const max = type === 4 ? 32 : 128;
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > max) {
      throw new Error(`${name}: ungültiges Netz „${entry}“`);
    }
    list.addSubnet(address, prefix, family);
  }
  return list;
}

/** Wandelt IPv4-in-IPv6-Adressen (`::ffff:192.168.1.5`) in IPv4 um. */
export function normalizeIp(ip) {
  if (typeof ip !== 'string') return '';
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  return mapped ? mapped[1] : ip;
}

/** Ob `ip` in einem der Netze liegt. `null` (= `*`) erlaubt alles. */
export function inNetworks(networks, ip) {
  if (networks === null) return true;
  const address = normalizeIp(ip);
  const type = isIP(address);
  if (type === 0) return false;
  return networks.check(address, type === 4 ? 'ipv4' : 'ipv6');
}

/** Ob die Anfrage über einen Proxy oder Tunnel kam. */
export function isForwarded(req) {
  return FORWARDING_HEADERS.some((header) => req.headers[header] !== undefined);
}

/**
 * Ermittelt die Adresse des Clients. Kommt die Anfrage von einem
 * vertrauenswürdigen Proxy (z. B. dem Cloudflare-Tunnel im Heimnetz), gilt
 * die von ihm weitergegebene Adresse – sonst die der Verbindung.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {BlockList | null} trustedProxies
 */
export function resolveClientIp(req, trustedProxies) {
  const direct = normalizeIp(req.socket.remoteAddress);
  if (!inNetworks(trustedProxies, direct)) return direct;

  const cf = firstValue(req.headers['cf-connecting-ip']);
  if (cf && isIP(normalizeIp(cf))) return normalizeIp(cf);

  // X-Forwarded-For: der letzte Eintrag stammt vom vertrauenswürdigen Proxy.
  const forwarded = firstValue(req.headers['x-forwarded-for']);
  if (forwarded) {
    const last = normalizeIp(forwarded.split(',').at(-1).trim());
    if (isIP(last)) return last;
  }
  return direct;
}

/**
 * Ob die Verwaltung für diese Anfrage erreichbar ist: nur direkt aus den
 * erlaubten Netzen, nie über Tunnel oder Proxy.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {BlockList | null} adminNetworks
 */
export function isAdminAllowed(req, adminNetworks) {
  if (adminNetworks === null) return true;
  if (isForwarded(req)) return false;
  return inNetworks(adminNetworks, req.socket.remoteAddress);
}

function firstValue(value) {
  return Array.isArray(value) ? value[0] : value;
}
