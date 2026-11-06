import path from 'node:path';

const DEFAULT_PORT = 3000;
export const MIN_ADMIN_PASSWORD_LENGTH = 12;

/**
 * Liest die Konfiguration aus Umgebungsvariablen.
 *
 * - PORT:           TCP-Port des Servers (Standard 3000)
 * - DATA_DIR:       Verzeichnis für dauerhafte Daten (Standard ./data)
 * - ADMIN_PASSWORD: Passwort des Superadmins, Pflicht, mind. 12 Zeichen
 *
 * @param {NodeJS.ProcessEnv} env
 */
export function loadConfig(env = process.env) {
  return {
    port: parsePort(env.PORT),
    dataDir: path.resolve(env.DATA_DIR || './data'),
    adminPassword: parseAdminPassword(env.ADMIN_PASSWORD),
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

function parsePort(value) {
  if (value === undefined || value === '') return DEFAULT_PORT;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Ungültiger PORT: ${value}`);
  }
  return port;
}
