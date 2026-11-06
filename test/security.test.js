import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import WebSocket from 'ws';

import { detectType } from '../server/branding/logo.js';
import { CONTENT_SECURITY_POLICY } from '../server/security.js';
import { CLOSE_POLICY_VIOLATION } from '../server/ws.js';
import { startTestServer } from './helpers.js';
import { connectClient } from './ws-client.js';

function tryOpen(url, headers = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers });
    ws.once('open', () => resolve({ ok: true, ws }));
    ws.once('unexpected-response', (_req, res) => resolve({ ok: false, status: res.statusCode }));
    ws.once('error', () => resolve({ ok: false, status: null }));
  });
}

describe('Sicherheits-Header', () => {
  let server;
  beforeEach(async () => {
    server = await startTestServer();
  });
  afterEach(() => server.close());

  for (const path of [
    '/',
    '/admin/',
    '/join/ABCD2345',
    '/api/branding',
    '/healthz',
    '/gibt-es-nicht',
  ]) {
    it(`setzt die Header für ${path}`, async () => {
      const res = await fetch(`${server.baseUrl}${path}`);
      assert.equal(res.headers.get('content-security-policy'), CONTENT_SECURITY_POLICY);
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(res.headers.get('x-frame-options'), 'DENY');
      assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
      assert.equal(res.headers.get('cross-origin-opener-policy'), 'same-origin');
      assert.match(res.headers.get('permissions-policy'), /camera=\(\)/);
      assert.equal(res.headers.get('strict-transport-security'), null, 'nicht ohne HTTPS');
    });
  }

  it('verbietet Inline-Skripte und Einbetten in Frames', () => {
    assert.match(CONTENT_SECURITY_POLICY, /script-src 'self'(;|$)/);
    assert.doesNotMatch(CONTENT_SECURITY_POLICY, /unsafe-inline|unsafe-eval/);
    assert.match(CONTENT_SECURITY_POLICY, /frame-ancestors 'none'/);
  });

  it('setzt HSTS hinter HTTPS', async () => {
    const res = await fetch(`${server.baseUrl}/`, { headers: { 'x-forwarded-proto': 'https' } });
    assert.match(res.headers.get('strict-transport-security'), /max-age=\d+/);
  });

  it('enthält keine Inline-Skripte, Inline-Styles oder Event-Handler in den Seiten', async () => {
    for (const path of ['/', '/admin/']) {
      const html = await (await fetch(`${server.baseUrl}${path}`)).text();
      assert.doesNotMatch(html, /<script(?![^>]*\ssrc=)[^>]*>/i, path);
      assert.doesNotMatch(html, /<style/i, path);
      assert.doesNotMatch(html, /\sstyle=/i, path);
      assert.doesNotMatch(html, /\son[a-z]+=/i, path);
      assert.doesNotMatch(html, /https?:\/\//i, `${path} lädt nichts von fremden Servern`);
    }
  });
});

describe('WebSocket-Schutz', () => {
  let server;
  const sockets = [];
  beforeEach(async () => {
    server = await startTestServer({
      deps: {
        hubOptions: { autoSweep: false },
        wsOptions: { limits: { maxConnectionsPerIp: 3, messagesPerSecond: 1, messageBurst: 5 } },
      },
    });
  });
  afterEach(async () => {
    for (const ws of sockets.splice(0)) ws.terminate();
    await server.close();
  });

  it('lehnt Verbindungen von fremden Seiten ab', async () => {
    const result = await tryOpen(server.wsUrl, { origin: 'https://boese.example' });
    assert.equal(result.ok, false);
    assert.equal(result.status, 403);
  });

  it('erlaubt Verbindungen von der eigenen Seite', async () => {
    const host = new URL(server.baseUrl).host;
    const result = await tryOpen(server.wsUrl, { origin: `http://${host}` });
    assert.equal(result.ok, true);
    sockets.push(result.ws);
  });

  it('begrenzt Verbindungen pro IP', async () => {
    for (let i = 0; i < 3; i++) {
      const result = await tryOpen(server.wsUrl);
      assert.equal(result.ok, true);
      sockets.push(result.ws);
    }
    const fourth = await tryOpen(server.wsUrl);
    assert.equal(fourth.status, 429);

    // Nach dem Schließen ist wieder Platz.
    const closed = sockets.pop();
    await new Promise((resolve) => {
      closed.once('close', resolve);
      closed.close();
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const again = await tryOpen(server.wsUrl);
    assert.equal(again.ok, true);
    sockets.push(again.ws);
  });

  it('trennt Verbindungen, die zu viele Nachrichten schicken', async () => {
    const client = await connectClient(server.wsUrl);
    sockets.push(client.ws);
    for (let i = 0; i < 20; i++) client.send({ type: 'ping' });
    assert.equal((await client.closed()).code, CLOSE_POLICY_VIOLATION);
  });
});

describe('Logo-Erkennung ohne ReDoS', () => {
  for (const [label, text] of [
    ['viele Kommentare', '<!-- -->'.repeat(600) + 'x'],
    ['offene Kommentare', '<!--'.repeat(1100)],
    ['lange XML-Deklaration', `<?xml ${'?'.repeat(5000)}`],
  ]) {
    it(`bleibt schnell bei ${label}`, { timeout: 1000 }, () => {
      const start = Date.now();
      assert.equal(detectType(Buffer.from(text)), null);
      assert.ok(Date.now() - start < 200);
    });
  }

  it('erkennt SVG nach Kommentaren und XML-Deklaration', () => {
    const text = '\uFEFF<?xml version="1.0"?>\n<!-- a -->\n<!-- b --><svg xmlns="x"></svg>';
    assert.equal(detectType(Buffer.from(text)), 'image/svg+xml');
  });
});
