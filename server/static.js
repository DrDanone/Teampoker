import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * Liefert Dateien aus `rootDir` aus. Pfade außerhalb von `rootDir`
 * (z. B. über `..` oder kodierte Schrägstriche) werden abgewiesen.
 *
 * @param {string} rootDir absoluter Pfad des öffentlichen Verzeichnisses
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, pathname: string) => Promise<boolean>}
 *   gibt `true` zurück, wenn eine Datei ausgeliefert wurde
 */
export function createStaticHandler(rootDir) {
  const root = path.resolve(rootDir);

  return async function serveStatic(req, res, pathname) {
    const filePath = resolveSafe(root, pathname);
    if (!filePath) return false;

    let info;
    try {
      info = await stat(filePath);
    } catch {
      return false;
    }
    if (!info.isFile()) return false;

    const type = CONTENT_TYPES[path.extname(filePath).toLowerCase()];
    if (!type) return false;

    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': info.size,
      'Cache-Control': 'no-cache',
    });
    if (req.method === 'HEAD') {
      res.end();
      return true;
    }
    createReadStream(filePath).pipe(res);
    return true;
  };
}

/**
 * Wandelt einen URL-Pfad in einen Dateipfad innerhalb von `root` um
 * oder gibt `null` zurück, wenn der Pfad unzulässig ist.
 */
export function resolveSafe(root, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return null;

  const relative = decoded.endsWith('/') ? `${decoded}index.html` : decoded;
  const filePath = path.resolve(root, `.${path.posix.normalize(`/${relative}`)}`);
  if (filePath !== root && !filePath.startsWith(root + path.sep)) return null;

  // Versteckte Dateien (z. B. .env) nie ausliefern
  if (
    path
      .relative(root, filePath)
      .split(path.sep)
      .some((part) => part.startsWith('.'))
  ) {
    return null;
  }
  return filePath;
}
