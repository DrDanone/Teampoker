import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';

import { generateCode, normalizeCode } from './codes.js';

export const ROOMS_FILE = 'rooms.json';
export const MAX_ROOM_NAME_LENGTH = 50;
const FILE_VERSION = 1;
const MAX_CODE_ATTEMPTS = 100;

/** Fehler, deren Meldung dem Benutzer angezeigt werden darf. */
export class RoomError extends Error {
  /** @param {'invalid-name' | 'not-found'} code */
  constructor(code, message) {
    super(message);
    this.name = 'RoomError';
    this.code = code;
  }
}

/**
 * @typedef {object} Room
 * @property {string} id
 * @property {string} name
 * @property {string} code
 * @property {string} createdAt ISO-Zeitstempel
 */

/**
 * Verwaltet die Räume und speichert sie als JSON-Datei in `dataDir`.
 * Schätzungen werden hier bewusst nicht gespeichert.
 *
 * Ereignisse:
 * - `renamed` (room) – Raum wurde umbenannt
 * - `codeChanged` (room, oldCode) – Code wurde neu erzeugt
 * - `deleted` (room) – Raum wurde gelöscht
 */
export class RoomStore extends EventEmitter {
  /** @type {Map<string, Room>} */
  #rooms = new Map();
  /** @type {Map<string, string>} Code → Raum-ID */
  #byCode = new Map();
  #filePath;
  #dataDir;
  #writeQueue = Promise.resolve();
  #loaded = false;

  /** @param {string} dataDir */
  constructor(dataDir) {
    super();
    this.#dataDir = dataDir;
    this.#filePath = path.join(dataDir, ROOMS_FILE);
  }

  /**
   * Lädt die Räume. Fehlt die Datei, startet der Store leer. Ist sie
   * beschädigt, wird abgebrochen, statt sie zu überschreiben.
   */
  async load() {
    await mkdir(this.#dataDir, { recursive: true });
    let text;
    try {
      text = await readFile(this.#filePath, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.#loaded = true;
      return this;
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`${this.#filePath} ist beschädigt (kein gültiges JSON)`);
    }
    if (data?.version !== FILE_VERSION || !Array.isArray(data.rooms)) {
      throw new Error(`${this.#filePath} hat ein unbekanntes Format`);
    }

    for (const raw of data.rooms) {
      const room = parseStoredRoom(raw);
      if (!room || this.#rooms.has(room.id) || this.#byCode.has(room.code)) {
        throw new Error(`${this.#filePath} enthält einen ungültigen Raum`);
      }
      this.#index(room);
    }
    this.#loaded = true;
    return this;
  }

  /** @returns {Room[]} alle Räume, sortiert nach Name */
  list() {
    return [...this.#rooms.values()]
      .map((room) => ({ ...room }))
      .sort((a, b) => a.name.localeCompare(b.name, 'de'));
  }

  /** @returns {Room | null} */
  get(id) {
    const room = this.#rooms.get(id);
    return room ? { ...room } : null;
  }

  /**
   * Sucht einen Raum anhand eines (vom Benutzer eingegebenen) Codes.
   * Groß-/Kleinschreibung, Leerzeichen und Bindestriche spielen keine Rolle.
   *
   * @returns {Room | null}
   */
  findByCode(input) {
    const code = normalizeCode(input);
    if (!code) return null;
    const id = this.#byCode.get(code);
    return id ? this.get(id) : null;
  }

  /** @returns {Promise<Room>} */
  async create(name) {
    this.#assertLoaded();
    const room = {
      id: randomUUID(),
      name: validateName(name),
      code: this.#uniqueCode(),
      createdAt: new Date().toISOString(),
    };
    this.#index(room);
    await this.#persistOrRollback(() => this.#unindex(room));
    return { ...room };
  }

  /** @returns {Promise<Room>} */
  async rename(id, name) {
    this.#assertLoaded();
    const room = this.#require(id);
    const newName = validateName(name);
    const oldName = room.name;
    room.name = newName;
    await this.#persistOrRollback(() => {
      room.name = oldName;
    });
    this.emit('renamed', { ...room });
    return { ...room };
  }

  /**
   * Erzeugt einen neuen Code. Der alte ist danach sofort ungültig.
   *
   * @returns {Promise<Room>}
   */
  async regenerateCode(id) {
    this.#assertLoaded();
    const room = this.#require(id);
    const oldCode = room.code;
    const newCode = this.#uniqueCode();
    this.#byCode.delete(oldCode);
    room.code = newCode;
    this.#byCode.set(newCode, room.id);
    await this.#persistOrRollback(() => {
      this.#byCode.delete(newCode);
      room.code = oldCode;
      this.#byCode.set(oldCode, room.id);
    });
    this.emit('codeChanged', { ...room }, oldCode);
    return { ...room };
  }

  async delete(id) {
    this.#assertLoaded();
    const room = this.#require(id);
    this.#unindex(room);
    await this.#persistOrRollback(() => this.#index(room));
    this.emit('deleted', { ...room });
  }

  #index(room) {
    this.#rooms.set(room.id, room);
    this.#byCode.set(room.code, room.id);
  }

  #unindex(room) {
    this.#rooms.delete(room.id);
    this.#byCode.delete(room.code);
  }

  /**
   * Speichert den Stand; schlägt das fehl, wird die Änderung im Speicher
   * zurückgenommen, damit Speicher und Datei übereinstimmen.
   */
  async #persistOrRollback(rollback) {
    try {
      await this.#persist();
    } catch (error) {
      rollback();
      throw error;
    }
  }

  #require(id) {
    const room = this.#rooms.get(id);
    if (!room) throw new RoomError('not-found', 'Raum nicht gefunden');
    return room;
  }

  #uniqueCode() {
    for (let i = 0; i < MAX_CODE_ATTEMPTS; i++) {
      const code = generateCode();
      if (!this.#byCode.has(code)) return code;
    }
    throw new Error('Konnte keinen eindeutigen Raum-Code erzeugen');
  }

  #assertLoaded() {
    if (!this.#loaded) throw new Error('RoomStore.load() wurde nicht aufgerufen');
  }

  /**
   * Schreibt den aktuellen Stand atomisch: erst in eine temporäre Datei,
   * dann umbenennen. Schreibvorgänge laufen nacheinander; jeder schreibt
   * den Stand zum Zeitpunkt seiner Ausführung.
   */
  #persist() {
    const run = this.#writeQueue.then(() => {
      const rooms = [...this.#rooms.values()];
      const snapshot = JSON.stringify({ version: FILE_VERSION, rooms }, null, 2);
      return writeAtomic(this.#filePath, `${snapshot}\n`);
    });
    // Ein fehlgeschlagener Schreibvorgang darf spätere nicht blockieren.
    this.#writeQueue = run.catch(() => {});
    return run;
  }
}

async function writeAtomic(filePath, content) {
  const tmpPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(tmpPath, 'w', 0o600);
  try {
    await handle.writeFile(content, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(tmpPath, filePath);
  } catch (error) {
    await rm(tmpPath, { force: true });
    throw error;
  }
}

/**
 * Prüft einen Raumnamen und gibt ihn bereinigt zurück.
 *
 * @param {unknown} name
 */
export function validateName(name) {
  if (typeof name !== 'string') throw new RoomError('invalid-name', 'Name fehlt');
  // eslint-disable-next-line no-control-regex
  const cleaned = name.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (cleaned.length === 0) throw new RoomError('invalid-name', 'Name fehlt');
  if ([...cleaned].length > MAX_ROOM_NAME_LENGTH) {
    throw new RoomError(
      'invalid-name',
      `Name darf höchstens ${MAX_ROOM_NAME_LENGTH} Zeichen lang sein`,
    );
  }
  return cleaned;
}

function parseStoredRoom(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const { id, name, code, createdAt } = raw;
  if (typeof id !== 'string' || id.length === 0) return null;
  if (typeof createdAt !== 'string' || Number.isNaN(Date.parse(createdAt))) return null;
  if (normalizeCode(code) !== code) return null;
  try {
    return { id, name: validateName(name), code, createdAt };
  } catch {
    return null;
  }
}
