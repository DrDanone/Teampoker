import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';

import { writeAtomic } from './logo.js';

export const DEFAULT_SITE_NAME = 'Teampoker';
export const MAX_SITE_NAME_LENGTH = 40;
const SITE_FILE = 'site.json';

/** Fehler, deren Meldung dem Superadmin angezeigt werden darf. */
export class SiteNameError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SiteNameError';
  }
}

/**
 * Name der Website oben links und im Browser-Titel. Ohne eigene Angabe
 * gilt der Standardname.
 */
export class SiteNameStore {
  #dataDir;
  /** @type {string | null} eigener Name oder `null` für den Standard */
  #name = null;

  constructor(dataDir) {
    this.#dataDir = dataDir;
  }

  /**
   * Lädt den gespeicherten Namen. Eine fehlende oder beschädigte Datei
   * verhindert den Start nicht – dann gilt der Standardname.
   */
  async load() {
    try {
      const stored = JSON.parse(await readFile(this.#filePath(), 'utf8'));
      this.#name = cleanSiteName(stored?.name);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.warn('Eigener Seitenname wird nicht verwendet: Datei ungültig');
      }
      this.#name = null;
    }
    return this;
  }

  /** Der angezeigte Name (eigener Name oder Standard). */
  get() {
    return this.#name ?? DEFAULT_SITE_NAME;
  }

  /**
   * Speichert einen neuen Namen. Ein leerer Name (oder der Standardname)
   * stellt den Standard wieder her.
   *
   * @param {unknown} value
   * @returns {Promise<string>} der jetzt angezeigte Name
   */
  async save(value) {
    if (typeof value !== 'string') throw new SiteNameError('Name fehlt');
    if (value.trim() === '') {
      await rm(this.#filePath(), { force: true });
      this.#name = null;
      return this.get();
    }
    const name = cleanSiteName(value);
    if (name === DEFAULT_SITE_NAME) {
      await rm(this.#filePath(), { force: true });
      this.#name = null;
      return this.get();
    }
    await writeAtomic(
      this.#filePath(),
      Buffer.from(`${JSON.stringify({ name, updatedAt: new Date().toISOString() })}\n`),
    );
    this.#name = name;
    return name;
  }

  #filePath() {
    return path.join(this.#dataDir, SITE_FILE);
  }
}

/**
 * Prüft einen Seitennamen und gibt ihn bereinigt zurück: Unicode
 * normalisiert, Steuer- und unsichtbare Zeichen entfernt, Leerraum
 * zusammengefasst.
 *
 * @param {unknown} value
 */
export function cleanSiteName(value) {
  if (typeof value !== 'string' || value.length > 500) {
    throw new SiteNameError(`Der Name darf höchstens ${MAX_SITE_NAME_LENGTH} Zeichen haben`);
  }
  const cleaned = value
    .normalize('NFC')
    // Tabulatoren und Zeilenumbrüche werden zu Leerzeichen, nicht entfernt.
    .replace(/\s+/g, ' ')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2064\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length === 0) throw new SiteNameError('Name fehlt');
  if ([...cleaned].length > MAX_SITE_NAME_LENGTH) {
    throw new SiteNameError(`Der Name darf höchstens ${MAX_SITE_NAME_LENGTH} Zeichen haben`);
  }
  return cleaned;
}
