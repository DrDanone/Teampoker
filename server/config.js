import path from 'node:path';

const DEFAULT_PORT = 3000;

/**
 * Liest die Konfiguration aus Umgebungsvariablen.
 *
 * - PORT:           TCP-Port des Servers (Standard 3000)
 * - DATA_DIR:       Verzeichnis für dauerhafte Daten (Standard ./data)
 * - ADMIN_PASSWORD: Passwort des Superadmins (wird ab Issue #3 verwendet)
 *
 * @param {NodeJS.ProcessEnv} env
 */
export function loadConfig(env = process.env) {
  return {
    port: parsePort(env.PORT),
    dataDir: path.resolve(env.DATA_DIR || './data'),
    adminPassword: env.ADMIN_PASSWORD || '',
  };
}

function parsePort(value) {
  if (value === undefined || value === '') return DEFAULT_PORT;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Ungültiger PORT: ${value}`);
  }
  return port;
}
