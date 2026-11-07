import { createHash, randomUUID } from 'node:crypto';
import { open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';

export const MAX_LOGO_BYTES = 1024 * 1024;
const LOGO_FILE = 'logo.bin';
const META_FILE = 'logo.json';

export const LOGO_TYPES = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  svg: 'image/svg+xml',
};

/** Fehler, deren Meldung dem Superadmin angezeigt werden darf. */
export class LogoError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LogoError';
  }
}

/**
 * Speichert das Logo der Website in `dataDir`. Es gibt höchstens ein Logo.
 */
export class LogoStore {
  #dataDir;
  /** @type {{ type: string, data: Buffer, etag: string } | null} */
  #logo = null;

  constructor(dataDir) {
    this.#dataDir = dataDir;
  }

  /**
   * Lädt das gespeicherte Logo. Ein fehlendes oder beschädigtes Logo
   * verhindert den Start nicht – die Website läuft dann ohne Logo.
   */
  async load() {
    try {
      const meta = JSON.parse(await readFile(path.join(this.#dataDir, META_FILE), 'utf8'));
      const data = await readFile(path.join(this.#dataDir, LOGO_FILE));
      // Auch beim Laden prüfen – die Datei könnte verändert worden sein.
      const type = validateLogo(data, meta.type);
      this.#logo = { type, data, etag: etagOf(data) };
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.warn(`Logo wird nicht verwendet: ${error.message}`);
      }
    }
    return this;
  }

  /** @returns {{ type: string, data: Buffer, etag: string } | null} */
  get() {
    return this.#logo;
  }

  /**
   * Prüft und speichert ein neues Logo.
   *
   * @param {Buffer} data
   * @param {string} declaredType Content-Type der Anfrage
   */
  async save(data, declaredType) {
    const type = validateLogo(data, declaredType);
    await writeAtomic(path.join(this.#dataDir, LOGO_FILE), data);
    await writeAtomic(
      path.join(this.#dataDir, META_FILE),
      Buffer.from(`${JSON.stringify({ type, uploadedAt: new Date().toISOString() })}\n`),
    );
    this.#logo = { type, data, etag: etagOf(data) };
    return this.#logo;
  }

  async remove() {
    await rm(path.join(this.#dataDir, META_FILE), { force: true });
    await rm(path.join(this.#dataDir, LOGO_FILE), { force: true });
    this.#logo = null;
  }
}

/**
 * Prüft Größe, Dateisignatur und – bei SVG – den Inhalt.
 *
 * @returns {string} der erkannte Content-Type
 */
export function validateLogo(data, declaredType) {
  if (!Buffer.isBuffer(data) || data.length === 0) throw new LogoError('Die Datei ist leer');
  if (data.length > MAX_LOGO_BYTES) throw new LogoError('Das Logo darf höchstens 1 MB groß sein');

  const declared = String(declaredType ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  const detected = detectType(data);
  if (!detected) {
    throw new LogoError('Unbekanntes Dateiformat. Erlaubt sind PNG, JPG, WebP und SVG.');
  }
  if (declared !== detected && !(declared === 'image/jpg' && detected === LOGO_TYPES.jpeg)) {
    throw new LogoError('Dateiendung und Inhalt passen nicht zusammen');
  }
  if (detected === LOGO_TYPES.svg) checkSvg(decodeUtf8(data));
  return detected;
}

/** Erkennt das Format an den ersten Bytes, nicht an Endung oder Angabe des Browsers. */
export function detectType(data) {
  if (startsWith(data, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return LOGO_TYPES.png;
  if (startsWith(data, [0xff, 0xd8, 0xff])) return LOGO_TYPES.jpeg;
  if (
    data.length >= 12 &&
    data.toString('latin1', 0, 4) === 'RIFF' &&
    data.toString('latin1', 8, 12) === 'WEBP'
  ) {
    return LOGO_TYPES.webp;
  }
  if (looksLikeSvg(data)) return LOGO_TYPES.svg;
  return null;
}

function decodeUtf8(data) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(data);
  } catch {
    throw new LogoError('Das SVG ist kein gültiges UTF-8');
  }
}

function startsWith(data, bytes) {
  return data.length >= bytes.length && bytes.every((byte, i) => data[i] === byte);
}

function looksLikeSvg(data) {
  const text = data.toString('utf8', 0, Math.min(data.length, 4096)).replace(/^\uFEFF/, '');
  // Optional XML-Deklaration und Kommentare, dann das svg-Element.
  return /^\s*(<\?xml[^>]*\?>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(text);
}

/**
 * Lehnt SVGs mit aktiven oder nachladenden Inhalten ab. Das ist bewusst
 * streng: lieber ein Logo ablehnen als Skripte ausliefern. Zusätzlich wird
 * das Logo mit einer CSP ausgeliefert, die Skripte verbietet (siehe routes).
 */
export function checkSvg(text) {
  const rules = [
    [/<!DOCTYPE|<!ENTITY|<!\[CDATA\[/i, 'DOCTYPE, ENTITY oder CDATA'],
    [/<\s*script/i, 'Skripte'],
    [
      /<\s*(foreignObject|iframe|object|embed|audio|video|canvas|handler|listener)\b/i,
      'eingebettete Inhalte',
    ],
    [/<\s*(animate\w*|set)\b/i, 'Animationen'],
    [/\son[a-z]+\s*=/i, 'Event-Handler'],
    [/javascript:|vbscript:|data:\s*text\/html/i, 'Skript-Links'],
    [/&#|&[a-z]+;/i, 'kodierte Zeichen'],
    [
      /(?:xlink:)?href\s*=\s*["']\s*(?!#|data:image\/(?:png|jpe?g|gif|webp);base64,)/i,
      'Verweise auf andere Dateien',
    ],
    [/url\(\s*["']?\s*(?!#)/i, 'Verweise auf andere Dateien'],
    [/@import/i, 'Verweise auf andere Dateien'],
  ];
  for (const [pattern, label] of rules) {
    if (pattern.test(text)) {
      throw new LogoError(
        `Das SVG enthält nicht erlaubte Bestandteile (${label}). Bitte als einfaches SVG ohne Skripte exportieren oder PNG verwenden.`,
      );
    }
  }
}

function etagOf(data) {
  return `"${createHash('sha256').update(data).digest('base64url').slice(0, 22)}"`;
}

async function writeAtomic(filePath, data) {
  const tmpPath = `${filePath}.${randomUUID()}.tmp`;
  const handle = await open(tmpPath, 'w', 0o600);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmpPath, filePath);
}
