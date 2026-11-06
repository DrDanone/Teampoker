import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createApp } from '../server/app.js';
import { loadConfig } from '../server/config.js';
import { RoomStore } from '../server/rooms/store.js';

export const TEST_PASSWORD = 'test-passwort-123';

/**
 * Startet die App mit eigenem Datenverzeichnis auf einem freien Port.
 *
 * @param {object} [options]
 * @param {Record<string, string>} [options.env]
 * @param {object} [options.deps] zusätzliche Abhängigkeiten für createApp
 */
export async function startTestServer({ env = {}, deps = {} } = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'wilkenpoker-'));
  const config = loadConfig({
    PORT: '0',
    ADMIN_PASSWORD: TEST_PASSWORD,
    DATA_DIR: dataDir,
    ...env,
  });
  const rooms = await new RoomStore(config.dataDir).load();
  const app = createApp(config, { rooms, ...deps });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const { port } = app.server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}/ws`,
    rooms,
    hub: app.hub,
    dataDir,
    async close() {
      await app.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}
