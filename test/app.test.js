import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, describe, it } from 'node:test';

import WebSocket from 'ws';

import { MAX_MESSAGE_BYTES } from '../server/ws.js';
import { startTestServer } from './helpers.js';

/** Rohe HTTP-Anfrage, damit Pfade nicht vom Client normalisiert werden. */
function rawGet(baseUrl, rawPath) {
  const { hostname, port } = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname, port, path: rawPath, method: 'GET' }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end();
  });
}

function openSocket(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function nextMessage(ws) {
  return new Promise((resolve) => ws.once('message', (data) => resolve(JSON.parse(data))));
}

describe('HTTP-Server', () => {
  let server;
  before(async () => {
    server = await startTestServer();
  });
  after(() => server.close());

  it('liefert die Startseite aus', async () => {
    const res = await fetch(`${server.baseUrl}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    assert.match(await res.text(), /Teampoker/);
  });

  it('meldet den Gesundheitszustand', async () => {
    const res = await fetch(`${server.baseUrl}/healthz`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'ok');
  });

  it('antwortet mit 404 auf unbekannte Pfade', async () => {
    const res = await fetch(`${server.baseUrl}/gibt-es-nicht.html`);
    assert.equal(res.status, 404);
  });

  it('lehnt andere Methoden als GET und HEAD ab', async () => {
    const res = await fetch(`${server.baseUrl}/`, { method: 'POST' });
    assert.equal(res.status, 405);
    assert.equal(res.headers.get('allow'), 'GET, HEAD');
  });

  for (const rawPath of [
    '/../package.json',
    '/%2e%2e/package.json',
    '/..%2fpackage.json',
    '/%2e%2e%2fserver%2fapp.js',
    '/..%5cpackage.json',
    '/index.html%00.txt',
    '/%E0%A4%A',
  ]) {
    it(`verhindert Zugriff außerhalb von public: ${rawPath}`, async () => {
      assert.equal(await rawGet(server.baseUrl, rawPath), 404);
    });
  }
});

describe('WebSocket', () => {
  let server;
  before(async () => {
    server = await startTestServer();
  });
  after(() => server.close());

  it('beantwortet ping mit pong', async () => {
    const ws = await openSocket(server.wsUrl);
    const reply = nextMessage(ws);
    ws.send(JSON.stringify({ type: 'ping' }));
    assert.deepEqual(await reply, { type: 'pong' });
    ws.close();
  });

  it('meldet ungültige Nachrichten als Fehler', async () => {
    const ws = await openSocket(server.wsUrl);
    const reply = nextMessage(ws);
    ws.send('kein json');
    assert.equal((await reply).type, 'error');
    ws.close();
  });

  it('trennt Verbindungen mit übergroßen Nachrichten', async () => {
    const ws = await openSocket(server.wsUrl);
    const closed = new Promise((resolve) => ws.once('close', (code) => resolve(code)));
    ws.on('error', () => {});
    ws.send('x'.repeat(MAX_MESSAGE_BYTES + 1));
    assert.equal(await closed, 1009);
  });

  it('akzeptiert WebSocket nur unter /ws', async () => {
    const url = server.wsUrl.replace(/\/ws$/, '/anderswo');
    await assert.rejects(openSocket(url));
  });
});
