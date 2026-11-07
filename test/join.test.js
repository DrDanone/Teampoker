import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { CLOSE_CODES } from '../server/poker/hub.js';
import { MAX_NAME_LENGTH, cleanParticipantName } from '../server/poker/names.js';
import { MAX_PARTICIPANTS, RoomSession } from '../server/poker/room-session.js';
import { FailureLimiter } from '../server/ratelimit.js';
import { startTestServer } from './helpers.js';
import { connectClient, eventually } from './ws-client.js';

const pick = ({ id, name, online }) => ({ id, name, online });

describe('Raum beitreten', () => {
  let server;
  let room;
  let now;
  const clients = [];

  async function client() {
    const c = await connectClient(server.wsUrl);
    clients.push(c);
    return c;
  }

  beforeEach(async () => {
    now = 1_000_000;
    server = await startTestServer({
      deps: {
        hubOptions: {
          now: () => now,
          autoSweep: false,
          joinLimiter: new FailureLimiter({ maxFailures: 3, now: () => now }),
        },
      },
    });
    room = await server.rooms.create('Team ESM');
  });

  afterEach(async () => {
    for (const c of clients.splice(0)) c.ws.terminate();
    await server.close();
  });

  it('tritt mit Code und Namen bei', async () => {
    const anna = await client();
    const joined = await anna.join(room.code, 'Anna');
    assert.equal(joined.type, 'joined');
    assert.equal(joined.room.name, 'Team ESM');
    assert.ok(joined.token.length >= 32);

    const state = await anna.next('state');
    assert.deepEqual(state.room, { name: 'Team ESM' });
    assert.deepEqual(state.participants.map(pick), [
      { id: joined.you, name: 'Anna', online: true },
    ]);
  });

  it('akzeptiert den Code in Kleinbuchstaben und mit Leerzeichen', async () => {
    const anna = await client();
    const code = `${room.code.slice(0, 4).toLowerCase()} ${room.code.slice(4)}`;
    assert.equal((await anna.join(code, 'Anna')).type, 'joined');
  });

  it('meldet einen falschen Code verständlich', async () => {
    const anna = await client();
    const reply = await anna.join('ZZZZ2222', 'Anna');
    assert.deepEqual(reply, {
      type: 'error',
      code: 'invalid-code',
      message: 'Diesen Raum-Code gibt es nicht',
      consumed: true,
    });
  });

  it('sperrt nach zu vielen falschen Codes – auch für richtige', async () => {
    const anna = await client();
    for (let i = 0; i < 3; i++)
      assert.equal((await anna.join('ZZZZ2222', 'Anna')).code, 'invalid-code');
    const locked = await anna.join(room.code, 'Anna');
    assert.equal(locked.code, 'locked');
    assert.match(locked.message, /Zu viele falsche Codes/);

    now += 16 * 60_000;
    assert.equal((await anna.join(room.code, 'Anna')).type, 'joined');
  });

  it('zeigt allen die Teilnehmerliste live', async () => {
    const anna = await client();
    const ben = await client();
    const a = await anna.join(room.code, 'Anna');
    const b = await ben.join(room.code, 'Ben');

    const state = await anna.next('state', (s) => s.participants.length === 2);
    assert.deepEqual(state.participants.map(pick), [
      { id: a.you, name: 'Anna', online: true },
      { id: b.you, name: 'Ben', online: true },
    ]);
  });

  it('verschickt keine Tokens an andere', async () => {
    const anna = await client();
    const ben = await client();
    const a = await anna.join(room.code, 'Anna');
    await ben.join(room.code, 'Ben');
    await anna.next('state', (s) => s.participants.length === 2);
    const leaked = ben.messages.some((m) => JSON.stringify(m).includes(a.token));
    assert.equal(leaked, false);
  });

  it('lehnt einen Namen ab, der online schon vergeben ist (Groß-/Kleinschreibung egal)', async () => {
    const anna = await client();
    const other = await client();
    await anna.join(room.code, 'Anna');
    const reply = await other.join(room.code, '  aNNa ');
    assert.equal(reply.code, 'name-taken');
  });

  for (const [name, code] of [
    ['', 'invalid-name'],
    ['   ', 'invalid-name'],
    ['x'.repeat(MAX_NAME_LENGTH + 1), 'invalid-name'],
    [42, 'invalid-name'],
  ]) {
    it(`lehnt ungültigen Namen ab: ${JSON.stringify(name).slice(0, 20)}`, async () => {
      const anna = await client();
      assert.equal((await anna.join(room.code, name)).code, code);
    });
  }

  it('erkennt nach Neuladen dieselbe Person am Token', async () => {
    const anna = await client();
    const ben = await client();
    const first = await anna.join(room.code, 'Anna');
    await ben.join(room.code, 'Ben');
    await anna.close();

    const offline = await ben.next('state', (s) => s.participants.some((p) => !p.online));
    assert.deepEqual(
      offline.participants.map((p) => [p.name, p.online]),
      [
        ['Anna', false],
        ['Ben', true],
      ],
    );

    const reloaded = await client();
    const again = await reloaded.join(room.code, 'Anna', first.token);
    assert.equal(again.you, first.you);
    const state = await ben.next('state', (s) => s.participants.every((p) => p.online));
    assert.equal(state.participants.length, 2, 'kein doppelter Teilnehmer');
  });

  it('erlaubt mehrere Tabs derselben Person', async () => {
    const tab1 = await client();
    const tab2 = await client();
    const first = await tab1.join(room.code, 'Anna');
    const second = await tab2.join(room.code, 'Anna', first.token);
    assert.equal(second.you, first.you);
    await tab1.close();
    // Ein Tab ist noch offen: weiterhin online
    const session = server.hub.sessionFor(room.id);
    assert.equal(session.publicParticipants()[0].online, true);
  });

  it('übernimmt den Namen einer Person, die offline ist (Gerätewechsel)', async () => {
    const laptop = await client();
    const first = await laptop.join(room.code, 'Anna');
    await laptop.close();
    await eventually(() => !server.hub.sessionFor(room.id).publicParticipants()[0].online);

    const phone = await client();
    const second = await phone.join(room.code, 'Anna');
    assert.equal(second.you, first.you);
    assert.notEqual(second.token, first.token, 'altes Token wird ungültig');
  });

  it('entfernt Teilnehmer nach längerer Zeit offline', async () => {
    const anna = await client();
    const ben = await client();
    await anna.join(room.code, 'Anna');
    await ben.join(room.code, 'Ben');
    await anna.close();
    await ben.next('state', (s) => s.participants.some((p) => !p.online));

    now += 10 * 60_000;
    server.hub.sweep();
    const state = await ben.next('state', (s) => s.participants.length === 1);
    assert.equal(state.participants[0].name, 'Ben');
  });

  it('räumt leere Räume auf', async () => {
    const anna = await client();
    await anna.join(room.code, 'Anna');
    await anna.close();
    now += 10 * 60_000;
    await eventually(() => {
      server.hub.sweep();
      return server.hub.sessionFor(room.id) === null;
    });
  });

  it('verlässt den Raum auf Wunsch sofort', async () => {
    const anna = await client();
    const ben = await client();
    await anna.join(room.code, 'Anna');
    await ben.join(room.code, 'Ben');
    anna.send({ type: 'leave' });
    await anna.next('left');
    const state = await ben.next('state', (s) => s.participants.length === 1);
    assert.equal(state.participants[0].name, 'Ben');
  });

  it('meldet leave ohne Raum als Fehler', async () => {
    const anna = await client();
    anna.send({ type: 'leave' });
    assert.equal((await anna.next('error')).code, 'not-joined');
  });

  it('wechselt beim erneuten Beitritt in einen anderen Raum', async () => {
    const other = await server.rooms.create('Team B');
    const anna = await client();
    await anna.join(room.code, 'Anna');
    await anna.join(other.code, 'Anna');
    await eventually(() => {
      const first = server.hub.sessionFor(room.id);
      return first && !first.publicParticipants()[0].online;
    });
  });

  it('beendet alle Verbindungen, wenn der Raum gelöscht wird', async () => {
    const anna = await client();
    const ben = await client();
    await anna.join(room.code, 'Anna');
    await ben.join(room.code, 'Ben');
    await server.rooms.delete(room.id);

    for (const c of [anna, ben]) {
      const kicked = await c.next('kicked');
      assert.equal(kicked.reason, 'room-deleted');
      assert.equal((await c.closed()).code, CLOSE_CODES.roomDeleted);
    }
    assert.equal(server.hub.sessionFor(room.id), null);
  });

  it('beendet alle Verbindungen, wenn der Code neu erzeugt wird', async () => {
    const anna = await client();
    const first = await anna.join(room.code, 'Anna');
    const updated = await server.rooms.regenerateCode(room.id);

    const kicked = await anna.next('kicked');
    assert.equal(kicked.reason, 'code-changed');
    assert.equal((await anna.closed()).code, CLOSE_CODES.codeChanged);

    // Mit altem Code und Token kein Zutritt mehr
    const retry = await client();
    assert.equal((await retry.join(room.code, 'Anna', first.token)).code, 'invalid-code');
    // Mit neuem Code geht es – als neue Person
    const fresh = await retry.join(updated.code, 'Anna', first.token);
    assert.equal(fresh.type, 'joined');
    assert.notEqual(fresh.you, first.you);
  });

  it('zeigt einen neuen Raumnamen sofort an', async () => {
    const anna = await client();
    await anna.join(room.code, 'Anna');
    await server.rooms.rename(room.id, 'Team Abrechnung');
    const state = await anna.next('state', (s) => s.room.name === 'Team Abrechnung');
    assert.ok(state);
  });

  it('liefert für Einladungslinks die Startseite aus', async () => {
    const res = await fetch(`${server.baseUrl}/join/${room.code}`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /<script src="\/app\.js" type="module"><\/script>/);
  });
});

describe('RoomSession', () => {
  it('begrenzt die Teilnehmerzahl', () => {
    const session = new RoomSession('raum', { maxParticipants: 2 });
    session.attach(session.join({ name: 'A' }), {});
    session.attach(session.join({ name: 'B' }), {});
    assert.throws(
      () => session.join({ name: 'C' }),
      (e) => e.code === 'room-full',
    );
    assert.equal(MAX_PARTICIPANTS, 30);
  });

  it('löst Namenskonflikt beim Wiederkommen mit Token auf', () => {
    const session = new RoomSession('raum');
    const anna = session.join({ name: 'Anna' });
    const ben = session.join({ name: 'Ben' }); // nie verbunden → offline
    // Anna kommt mit ihrem Token, aber nennt sich jetzt "Ben"
    const again = session.join({ name: 'Ben', token: anna.token });
    assert.equal(again.id, anna.id);
    assert.equal(session.participants.has(ben.id), false);
  });
});

describe('Teilnehmernamen', () => {
  it('bereinigt Steuer- und unsichtbare Zeichen und Leerraum', () => {
    assert.equal(cleanParticipantName('  Anna\u0000  Maria\u200b '), 'Anna Maria');
    assert.equal(cleanParticipantName('Jo\u0308rg'), 'Jörg');
  });

  it('zählt Zeichen statt Bytes', () => {
    assert.equal(cleanParticipantName('ö'.repeat(MAX_NAME_LENGTH)).length, MAX_NAME_LENGTH);
  });
});
