import { createApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const { server, close } = createApp(config);

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
