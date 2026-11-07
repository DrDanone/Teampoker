import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { CODE_ALPHABET, CODE_LENGTH, generateCode, normalizeCode } from '../server/rooms/codes.js';
import { MAX_ROOM_NAME_LENGTH, ROOMS_FILE, RoomError, RoomStore } from '../server/rooms/store.js';

describe('Raum-Codes', () => {
  it('erzeugt 8 Zeichen aus dem erlaubten Alphabet', () => {
    for (let i = 0; i < 1000; i++) {
      const code = generateCode();
      assert.equal(code.length, CODE_LENGTH);
      for (const char of code) assert.ok(CODE_ALPHABET.includes(char), `Zeichen ${char}`);
    }
  });

  it('enthält keine verwechselbaren Zeichen', () => {
    for (const char of '0O1IL') assert.ok(!CODE_ALPHABET.includes(char), char);
    assert.equal(CODE_ALPHABET.length, 31);
  });

  it('nutzt alle Zeichen des Alphabets', () => {
    const seen = new Set();
    for (let i = 0; i < 500; i++) for (const char of generateCode()) seen.add(char);
    assert.equal(seen.size, CODE_ALPHABET.length);
  });

  it('normalisiert Eingaben', () => {
    assert.equal(normalizeCode('abcd2345'), 'ABCD2345');
    assert.equal(normalizeCode(' ABCD-2345 '), 'ABCD2345');
    assert.equal(normalizeCode('abcd 2345'), 'ABCD2345');
  });

  for (const input of ['', 'ABCD234', 'ABCD23456', 'ABCD0345', 'ABCDI345', 'ÄBCD2345', 42, null]) {
    it(`lehnt ungültige Eingabe ab: ${JSON.stringify(input)}`, () => {
      assert.equal(normalizeCode(input), null);
    });
  }
});

describe('RoomStore', () => {
  let dataDir;
  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'wilkenpoker-'));
  });
  afterEach(async () => {
    await chmod(dataDir, 0o700).catch(() => {});
    await rm(dataDir, { recursive: true, force: true });
  });

  async function freshStore() {
    return new RoomStore(dataDir).load();
  }

  it('startet ohne Datei leer', async () => {
    const store = await freshStore();
    assert.deepEqual(store.list(), []);
  });

  it('legt das Datenverzeichnis an, falls es fehlt', async () => {
    const nested = path.join(dataDir, 'unter', 'ordner');
    const store = await new RoomStore(nested).load();
    await store.create('Team ESM');
    assert.ok((await stat(path.join(nested, ROOMS_FILE))).isFile());
  });

  it('legt Räume an und findet sie über den Code', async () => {
    const store = await freshStore();
    const room = await store.create('  Team ESM  ');
    assert.equal(room.name, 'Team ESM');
    assert.ok(normalizeCode(room.code));
    assert.deepEqual(store.findByCode(room.code.toLowerCase()), room);
    assert.equal(store.findByCode('ABCD2345'), null);
  });

  it('überlebt einen Neustart', async () => {
    const store = await freshStore();
    const a = await store.create('Team A');
    const b = await store.create('Team B');
    const reloaded = await freshStore();
    assert.deepEqual(reloaded.list(), [a, b]);
    assert.deepEqual(reloaded.findByCode(b.code), b);
  });

  it('sortiert Räume nach Name', async () => {
    const store = await freshStore();
    await store.create('Zähler');
    await store.create('Abrechnung');
    await store.create('Ärger');
    assert.deepEqual(
      store.list().map((r) => r.name),
      ['Abrechnung', 'Ärger', 'Zähler'],
    );
  });

  it('vergibt eindeutige Codes', async () => {
    const store = await freshStore();
    const codes = new Set();
    for (let i = 0; i < 50; i++) codes.add((await store.create(`Team ${i}`)).code);
    assert.equal(codes.size, 50);
  });

  it('benennt Räume um', async () => {
    const store = await freshStore();
    const room = await store.create('Alt');
    await store.rename(room.id, 'Neu');
    assert.equal((await freshStore()).get(room.id).name, 'Neu');
  });

  it('macht den alten Code beim Neuerzeugen sofort ungültig', async () => {
    const store = await freshStore();
    const room = await store.create('Team');
    let event;
    store.on('codeChanged', (changed, oldCode) => (event = { changed, oldCode }));

    const updated = await store.regenerateCode(room.id);
    assert.notEqual(updated.code, room.code);
    assert.equal(store.findByCode(room.code), null);
    assert.equal(store.findByCode(updated.code).id, room.id);
    assert.deepEqual(event, { changed: updated, oldCode: room.code });

    const reloaded = await freshStore();
    assert.equal(reloaded.findByCode(room.code), null);
    assert.equal(reloaded.findByCode(updated.code).id, room.id);
  });

  it('löscht Räume', async () => {
    const store = await freshStore();
    const room = await store.create('Team');
    let deleted;
    store.on('deleted', (r) => (deleted = r));
    await store.delete(room.id);
    assert.equal(store.get(room.id), null);
    assert.equal(store.findByCode(room.code), null);
    assert.deepEqual(deleted, room);
    assert.deepEqual((await freshStore()).list(), []);
  });

  it('meldet unbekannte Räume', async () => {
    const store = await freshStore();
    for (const action of [
      () => store.rename('gibt-es-nicht', 'X'),
      () => store.regenerateCode('gibt-es-nicht'),
      () => store.delete('gibt-es-nicht'),
    ]) {
      await assert.rejects(
        action,
        (error) => error instanceof RoomError && error.code === 'not-found',
      );
    }
  });

  for (const name of ['', '   ', '\u0000\u0007', 'x'.repeat(MAX_ROOM_NAME_LENGTH + 1), 42, null]) {
    it(`lehnt ungültigen Namen ab: ${JSON.stringify(name)?.slice(0, 20)}`, async () => {
      const store = await freshStore();
      await assert.rejects(
        store.create(name),
        (error) => error instanceof RoomError && error.code === 'invalid-name',
      );
      assert.deepEqual(store.list(), []);
    });
  }

  it('entfernt Steuerzeichen aus Namen', async () => {
    const store = await freshStore();
    assert.equal((await store.create('Team\u0000 ESM\n')).name, 'Team ESM');
  });

  it('erlaubt Namen mit genau der Höchstlänge, auch mit Umlauten', async () => {
    const store = await freshStore();
    const name = 'ä'.repeat(MAX_ROOM_NAME_LENGTH);
    assert.equal((await store.create(name)).name, name);
  });

  it('speichert die Datei nur für den Eigentümer lesbar', async () => {
    const store = await freshStore();
    await store.create('Team');
    const { mode } = await stat(path.join(dataDir, ROOMS_FILE));
    assert.equal(mode & 0o777, 0o600);
  });

  it('hinterlässt keine temporären Dateien', async () => {
    const store = await freshStore();
    await Promise.all([store.create('A'), store.create('B'), store.create('C')]);
    assert.deepEqual(await readdir(dataDir), [ROOMS_FILE]);
    assert.equal((await freshStore()).list().length, 3);
  });

  it('speichert gleichzeitige Änderungen vollständig', async () => {
    const store = await freshStore();
    const rooms = await Promise.all(Array.from({ length: 20 }, (_, i) => store.create(`T${i}`)));
    await Promise.all(rooms.map((room) => store.rename(room.id, `${room.name}-neu`)));
    const names = (await freshStore()).list().map((r) => r.name);
    assert.equal(names.length, 20);
    assert.ok(names.every((n) => n.endsWith('-neu')));
  });

  it('enthält keine Schätzungen in der Datei', async () => {
    const store = await freshStore();
    await store.create('Team');
    const data = JSON.parse(await readFile(path.join(dataDir, ROOMS_FILE), 'utf8'));
    assert.deepEqual(Object.keys(data.rooms[0]).sort(), ['code', 'createdAt', 'id', 'name']);
  });

  it('bricht bei beschädigter Datei ab, statt sie zu überschreiben', async () => {
    const file = path.join(dataDir, ROOMS_FILE);
    await writeFile(file, '{ kaputt');
    await assert.rejects(new RoomStore(dataDir).load(), /beschädigt/);
    assert.equal(await readFile(file, 'utf8'), '{ kaputt');
  });

  for (const [label, content] of [
    ['falsche Version', { version: 99, rooms: [] }],
    ['ungültiger Code', { version: 1, rooms: [room({ code: 'abc' })] }],
    [
      'doppelte ID',
      { version: 1, rooms: [room({ code: 'AAAA2222' }), room({ code: 'BBBB3333' })] },
    ],
    ['doppelter Code', { version: 1, rooms: [room({ id: 'a' }), room({ id: 'b' })] }],
  ]) {
    it(`lehnt ungültigen Dateiinhalt ab: ${label}`, async () => {
      await writeFile(path.join(dataDir, ROOMS_FILE), JSON.stringify(content));
      await assert.rejects(new RoomStore(dataDir).load());
    });
  }

  it('nimmt Änderungen zurück, wenn das Speichern scheitert', async (t) => {
    if (process.getuid?.() === 0) {
      t.skip('als root greifen Dateirechte nicht');
      return;
    }
    const store = await freshStore();
    const room = await store.create('Team');
    await chmod(dataDir, 0o500);

    await assert.rejects(store.create('Neu'));
    await assert.rejects(store.rename(room.id, 'Anders'));
    await assert.rejects(store.regenerateCode(room.id));
    await assert.rejects(store.delete(room.id));

    assert.deepEqual(store.list(), [room]);
    assert.deepEqual(store.findByCode(room.code), room);

    await chmod(dataDir, 0o700);
    await store.create('Danach');
    assert.equal((await freshStore()).list().length, 2);
  });

  it('verlangt load() vor Änderungen', async () => {
    const store = new RoomStore(dataDir);
    await assert.rejects(store.create('Team'), /load/);
  });
});

function room(overrides) {
  return {
    id: 'raum-1',
    name: 'Team',
    code: 'ABCD2345',
    createdAt: '2026-11-06T12:00:00.000Z',
    ...overrides,
  };
}
