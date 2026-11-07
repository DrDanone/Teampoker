import { access, constants, mkdir } from 'node:fs/promises';

import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { LogoStore } from './branding/logo.js';
import { RoomStore } from './rooms/store.js';

let config;
let rooms;
let logo;
try {
  config = loadConfig();
  await assertWritable(config.dataDir);
  rooms = await new RoomStore(config.dataDir).load();
  logo = await new LogoStore(config.dataDir).load();
} catch (error) {
  console.error(`Start abgebrochen: ${error.message}`);
  process.exit(1);
}

const { server, close } = createApp(config, { rooms, logo });

server.listen(config.port, () => {
  console.log(`Wilkenpoker läuft auf Port ${server.address().port}`);
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} empfangen, fahre herunter …`);
  await close();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

/** Bricht früh mit einer verständlichen Meldung ab, wenn DATA_DIR nicht beschreibbar ist. */
async function assertWritable(dir) {
  try {
    await mkdir(dir, { recursive: true });
    await access(dir, constants.W_OK);
  } catch {
    const uid = process.getuid?.() ?? '?';
    throw new Error(
      `Datenverzeichnis ${dir} ist nicht beschreibbar (Benutzer-ID ${uid}). ` +
        `Auf dem Host z. B. mit "chown -R ${uid}:${uid} <Ordner>" freigeben.`,
    );
  }
}
