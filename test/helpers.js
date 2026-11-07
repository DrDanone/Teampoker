import { createApp } from '../server/app.js';
import { loadConfig } from '../server/config.js';

/** Startet die App auf einem freien Port und gibt Basis-URL und `close` zurück. */
export async function startTestServer(env = {}) {
  const app = createApp(loadConfig({ PORT: '0', ...env }));
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const { port } = app.server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}/ws`,
    close: app.close,
  };
}
