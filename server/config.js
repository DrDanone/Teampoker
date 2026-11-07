import path from 'node:path';

import { PRIVATE_NETWORKS, parseNetworks } from './network.js';

const DEFAULT_PORT = 3000;
export const MIN_ADMIN_PASSWORD_LENGTH = 12;

/**
 * Liest die Konfiguration aus Umgebungsvariablen.
 *
 * - PORT:           TCP-Port des Servers (Standard 3000)
 * - DATA_DIR:       Verzeichnis für dauerhafte Daten (Standard ./data)
 * - ADMIN_PASSWORD: Passwort des Superadmins, Pflicht, mind. 12 Zeichen
 * - ADMIN_NETWORKS: Netze, aus denen die Verwaltung erreichbar ist
 *                   (Standard: private Netze). Über Tunnel oder Proxy ist sie
 *                   dann nicht erreichbar. `*` = überall, auch über Tunnel/Proxy.
 * - PUBLIC_URL:     öffentliche Adresse für Einladungslinks, z. B.
 *                   https://poker.example.de (Standard: Adresse der Verwaltung)
 * - TRUSTED_PROXIES: Netze der Proxys/Tunnel, deren weitergegebene
 *                   Client-Adresse übernommen wird (Standard: private Netze)
 *
 * @param {NodeJS.ProcessEnv} env
 */
export function loadConfig(env = process.env) {
  return {
    port: parsePort(env.PORT),
    dataDir: path.resolve(env.DATA_DIR || './data'),
    adminPassword: parseAdminPassword(env.ADMIN_PASSWORD),
    adminNetworks: parseNetworks(env.ADMIN_NETWORKS || PRIVATE_NETWORKS, 'ADMIN_NETWORKS'),
    trustedProxies: parseNetworks(env.TRUSTED_PROXIES || PRIVATE_NETWORKS, 'TRUSTED_PROXIES'),
    publicUrl: parsePublicUrl(env.PUBLIC_URL),
  };
}

function parseAdminPassword(value) {
  if (!value) {
    throw new Error('ADMIN_PASSWORD ist nicht gesetzt. Ohne Passwort startet Wilkenpoker nicht.');
  }
  if ([...value].length < MIN_ADMIN_PASSWORD_LENGTH) {
    throw new Error(
      `ADMIN_PASSWORD muss mindestens ${MIN_ADMIN_PASSWORD_LENGTH} Zeichen lang sein.`,
    );
  }
  return value;
}

/**
 * Öffentliche Adresse ohne Pfad, z. B. `https://poker.example.de`.
 * Leer = keine Angabe.
 */
function parsePublicUrl(value) {
  if (!value) return '';
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Ungültige PUBLIC_URL: ${value}`);
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error(`PUBLIC_URL muss mit http:// oder https:// beginnen: ${value}`);
  }
  if ((url.pathname !== '/' && url.pathname !== '') || url.search || url.hash || url.username) {
    throw new Error(
      `PUBLIC_URL darf nur Protokoll und Adresse enthalten, z. B. https://poker.example.de: ${value}`,
    );
  }
  return url.origin;
}

function parsePort(value) {
  if (value === undefined || value === '') return DEFAULT_PORT;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Ungültiger PORT: ${value}`);
  }
  return port;
}
