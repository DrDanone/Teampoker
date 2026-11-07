import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { CARDS, evaluate, isCard } from '../server/poker/cards.js';
import { startTestServer } from './helpers.js';
import { connectClient } from './ws-client.js';

describe('Auswertung', () => {
  const v = (...votes) => votes.map((vote, i) => ({ id: `p${i}`, vote }));

  it('berechnet Durchschnitt, Median und Spanne', () => {
    const result = evaluate(v('1', '3', '8'));
    assert.equal(result.count, 3);
    assert.equal(result.average, 4);
    assert.equal(result.median, 3);
    assert.equal(result.min, 1);
    assert.equal(result.max, 8);
    assert.equal(result.consensus, false);
    assert.deepEqual(result.highIds, ['p2']);
    assert.deepEqual(result.lowIds, ['p0']);
  });

  it('nimmt beim Median gerader Anzahl die Mitte', () => {
    assert.equal(evaluate(v('2', '3', '5', '8')).median, 4);
  });

  it('rundet auf eine Nachkommastelle', () => {
    assert.equal(evaluate(v('1', '2', '2')).average, 1.7);
  });

  it('rechnet mit ½', () => {
    const result = evaluate(v('0.5', '1'));
    assert.equal(result.average, 0.8);
    assert.equal(result.min, 0.5);
  });

  it('lässt ? und Kaffee aus der Statistik', () => {
    const result = evaluate(v('5', '?', 'coffee', '5', null));
    assert.equal(result.count, 2);
    assert.equal(result.average, 5);
    assert.equal(result.unsure, 1);
    assert.equal(result.coffee, 1);
    assert.equal(result.consensus, false, 'ein ? verhindert Einigkeit');
  });

  it('erkennt Einigkeit', () => {
    const result = evaluate(v('8', '8', '8', 'coffee'));
    assert.equal(result.consensus, true);
    assert.deepEqual(result.highIds, []);
    assert.deepEqual(result.lowIds, []);
  });

  it('nennt bei nur einer Schätzung keine Einigkeit und keine Ausreißer', () => {
    const result = evaluate(v('5'));
    assert.equal(result.consensus, false);
    assert.equal(result.average, 5);
    assert.deepEqual(result.highIds, []);
  });

  it('kommt ohne Zahlen aus', () => {
    const result = evaluate(v('?', 'coffee', null));
    assert.equal(result.count, 0);
    assert.equal(result.average, null);
    assert.equal(result.median, null);
    assert.equal(result.consensus, false);
  });

  it('markiert alle mit dem höchsten und niedrigsten Wert', () => {
    const result = evaluate(v('1', '13', '1', '13', '5'));
    assert.deepEqual(result.highIds, ['p1', 'p3']);
    assert.deepEqual(result.lowIds, ['p0', 'p2']);
  });

  it('kennt das Kartenset', () => {
    assert.deepEqual(CARDS, [
      '0',
      '0.5',
      '1',
      '2',
      '3',
      '5',
      '8',
      '13',
      '20',
      '40',
      '100',
      '?',
      'coffee',
    ]);
    assert.equal(isCard('8'), true);
    assert.equal(isCard('4'), false);
    assert.equal(isCard(8), false);
  });
});

describe('Schätzrunde', () => {
  let server;
  let room;
  const clients = [];

  async function joined(name) {
    const c = await connectClient(server.wsUrl);
    clients.push(c);
    const reply = await c.join(room.code, name);
    assert.equal(reply.type, 'joined');
    c.id = reply.you;
    c.token = reply.token;
    return c;
  }

  /** Wartet auf den nächsten Zustand, der die Bedingung erfüllt. */
  const stateWhere = (c, predicate) => c.next('state', predicate);

  beforeEach(async () => {
    server = await startTestServer({ deps: { hubOptions: { autoSweep: false } } });
    room = await server.rooms.create('Team ESM');
  });

  afterEach(async () => {
    for (const c of clients.splice(0)) c.ws.terminate();
    await server.close();
  });

  it('startet in Runde 1, verdeckt', async () => {
    const anna = await joined('Anna');
    const state = await anna.next('state');
    assert.equal(state.round, 1);
    assert.equal(state.revealed, false);
    assert.equal(state.result, null);
    assert.equal(state.yourVote, null);
    assert.equal(state.participants[0].voted, false);
  });

  it('zeigt vor dem Aufdecken nur, wer gewählt hat – nicht was', async () => {
    const anna = await joined('Anna');
    const ben = await joined('Ben');
    anna.send({ type: 'vote', value: '13' });

    const benView = await stateWhere(ben, (s) => s.participants.some((p) => p.voted));
    const annaEntry = benView.participants.find((p) => p.id === anna.id);
    assert.equal(annaEntry.voted, true);
    assert.equal('vote' in annaEntry, false);
    assert.equal(benView.yourVote, null);

    // Der Wert taucht in keiner Nachricht an Ben auf.
    for (const message of ben.messages) {
      const text = JSON.stringify(message);
      assert.doesNotMatch(text, /"13"/, text);
    }

    const annaView = await stateWhere(anna, (s) => s.yourVote === '13');
    assert.equal(annaView.yourVote, '13');
  });

  it('erlaubt das Ändern und Zurücknehmen der Karte vor dem Aufdecken', async () => {
    const anna = await joined('Anna');
    anna.send({ type: 'vote', value: '3' });
    await stateWhere(anna, (s) => s.yourVote === '3');
    anna.send({ type: 'vote', value: '5' });
    await stateWhere(anna, (s) => s.yourVote === '5');
    anna.send({ type: 'vote', value: null });
    const state = await stateWhere(anna, (s) => s.yourVote === null && !s.participants[0].voted);
    assert.ok(state);
  });

  it('lehnt unbekannte Karten ab', async () => {
    const anna = await joined('Anna');
    for (const value of ['4', 8, { x: 1 }, '']) {
      anna.send({ type: 'vote', value });
      assert.equal((await anna.next('error')).code, 'invalid-message');
    }
  });

  it('verlangt einen Raum für Spielzüge', async () => {
    const stranger = await connectClient(server.wsUrl);
    clients.push(stranger);
    for (const type of ['vote', 'reveal', 'reset']) {
      stranger.send({ type, value: '5', round: 1 });
      assert.equal((await stranger.next('error')).code, 'not-joined');
    }
  });

  it('deckt auf: alle Karten mit Namen und Auswertung', async () => {
    const anna = await joined('Anna');
    const ben = await joined('Ben');
    const carla = await joined('Carla');
    anna.send({ type: 'vote', value: '3' });
    ben.send({ type: 'vote', value: '13' });
    await stateWhere(carla, (s) => s.participants.filter((p) => p.voted).length === 2);

    // Carla hat noch nicht gewählt – aufdecken geht trotzdem.
    carla.send({ type: 'reveal', round: 1 });
    const state = await stateWhere(ben, (s) => s.revealed);
    const votes = Object.fromEntries(state.participants.map((p) => [p.name, p.vote]));
    assert.deepEqual(votes, { Anna: '3', Ben: '13', Carla: null });
    assert.equal(state.result.average, 8);
    assert.deepEqual(state.result.highIds, [ben.id]);
    assert.deepEqual(state.result.lowIds, [anna.id]);
  });

  it('sperrt die Karten nach dem Aufdecken', async () => {
    const anna = await joined('Anna');
    anna.send({ type: 'vote', value: '3' });
    anna.send({ type: 'reveal', round: 1 });
    await stateWhere(anna, (s) => s.revealed);
    anna.send({ type: 'vote', value: '5' });
    const error = await anna.next('error');
    assert.equal(error.code, 'locked');
    assert.equal(server.hub.sessionFor(room.id).participants.get(anna.id).vote, '3');
  });

  it('setzt alle Schätzungen zurück und startet die nächste Runde', async () => {
    const anna = await joined('Anna');
    const ben = await joined('Ben');
    anna.send({ type: 'vote', value: '3' });
    ben.send({ type: 'vote', value: '5' });
    ben.send({ type: 'reveal', round: 1 });
    await stateWhere(anna, (s) => s.revealed);

    anna.send({ type: 'reset', round: 1 });
    const state = await stateWhere(ben, (s) => s.round === 2);
    assert.equal(state.revealed, false);
    assert.equal(state.result, null);
    assert.equal(state.yourVote, null);
    assert.ok(state.participants.every((p) => !p.voted));
    assert.equal(state.participants.length, 2, 'Teilnehmer bleiben im Raum');
  });

  it('wertet gleichzeitige Klicks nur einmal', async () => {
    const anna = await joined('Anna');
    const ben = await joined('Ben');
    anna.send({ type: 'vote', value: '8' });
    anna.send({ type: 'reveal', round: 1 });
    ben.send({ type: 'reveal', round: 1 });
    await stateWhere(anna, (s) => s.revealed);

    anna.send({ type: 'reset', round: 1 });
    ben.send({ type: 'reset', round: 1 });
    await stateWhere(anna, (s) => s.round === 2);
    // Eine Runde weiter, nicht zwei – und Bens veralteter Reset wurde ignoriert.
    anna.send({ type: 'vote', value: '5' });
    const state = await stateWhere(anna, (s) => s.yourVote === '5');
    assert.equal(state.round, 2);
    assert.equal(server.hub.sessionFor(room.id).round, 2);
  });

  it('ignoriert Aufdecken einer veralteten Runde', async () => {
    const anna = await joined('Anna');
    anna.send({ type: 'reset', round: 1 });
    await stateWhere(anna, (s) => s.round === 2);
    anna.send({ type: 'reveal', round: 1 });
    anna.send({ type: 'vote', value: '1' });
    const state = await stateWhere(anna, (s) => s.yourVote === '1');
    assert.equal(state.revealed, false);
  });

  it('behält die Karte nach Neuladen', async () => {
    const anna = await joined('Anna');
    anna.send({ type: 'vote', value: '20' });
    await stateWhere(anna, (s) => s.yourVote === '20');
    await anna.close();

    const again = await connectClient(server.wsUrl);
    clients.push(again);
    await again.join(room.code, 'Anna', anna.token);
    const state = await again.next('state');
    assert.equal(state.yourVote, '20');
  });

  it('lässt Nachzügler nach dem Aufdecken bis zum Zurücksetzen warten', async () => {
    const anna = await joined('Anna');
    anna.send({ type: 'vote', value: '2' });
    anna.send({ type: 'reveal', round: 1 });
    await stateWhere(anna, (s) => s.revealed);

    const ben = await joined('Ben');
    const state = await ben.next('state');
    assert.equal(state.revealed, true);
    assert.equal(state.participants.find((p) => p.name === 'Ben').vote, null);
    ben.send({ type: 'vote', value: '3' });
    assert.equal((await ben.next('error')).code, 'locked');
  });

  it('entfernt die Karte, wenn jemand den Raum verlässt', async () => {
    const anna = await joined('Anna');
    const ben = await joined('Ben');
    ben.send({ type: 'vote', value: '40' });
    await stateWhere(anna, (s) => s.participants.some((p) => p.voted));
    ben.send({ type: 'leave' });
    anna.send({ type: 'vote', value: '5' });
    anna.send({ type: 'reveal', round: 1 });
    const state = await stateWhere(anna, (s) => s.revealed);
    assert.equal(state.result.count, 1);
    assert.equal(state.result.average, 5);
  });
});
