import assert from 'node:assert/strict';
import http from 'node:http';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { isAdminPath } from '../server/app.js';
import { loadConfig } from '../server/config.js';
import { inNetworks, normalizeIp, parseNetworks, resolveClientIp } from '../server/network.js';
import { FailureLimiter } from '../server/ratelimit.js';
import { TEST_PASSWORD, startTestServer } from './helpers.js';
import { connectClient } from './ws-client.js';

/** Rohe Anfrage, damit Pfade nicht normalisiert und Header frei gesetzt werden. */
function rawRequest(baseUrl, path, { method = 'GET', headers = {}, body } = {}) {
  const { hostname, port } = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname, port, path, method, headers }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end(body);
  });
}

/** Wie rawRequest, liefert aber Status und Inhalt. */
function rawFetch(baseUrl, path, headers = {}) {
  const { hostname, port } = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname, port, path, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () =>
        resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }),
      );
    });
    req.on('error', reject);
    req.end();
  });
}

/** Erkennungszeichen der Verwaltungs-Dateien (HTML, Skript, Stylesheet). */
const ADMIN_MARKERS = /admin\.js|logo-form|x-csrf-token|\.create-form/;

const fakeReq = (remoteAddress, headers = {}) => ({ socket: { remoteAddress }, headers });

describe('Netze', () => {
  it('erkennt private Netze und IPv4-in-IPv6', () => {
    const networks = parseNetworks('192.168.0.0/16, 10.0.0.0/8, fd00::/8', 'TEST');
    assert.equal(inNetworks(networks, '192.168.178.20'), true);
    assert.equal(inNetworks(networks, '::ffff:192.168.178.20'), true);
    assert.equal(inNetworks(networks, '10.1.2.3'), true);
    assert.equal(inNetworks(networks, 'fd12::1'), true);
    assert.equal(inNetworks(networks, '8.8.8.8'), false);
    assert.equal(inNetworks(networks, 'kaputt'), false);
    assert.equal(normalizeIp('::ffff:10.0.0.1'), '10.0.0.1');
  });

  it('akzeptiert einzelne Adressen und * für überall', () => {
    assert.equal(inNetworks(parseNetworks('192.168.1.10', 'TEST'), '192.168.1.10'), true);
    assert.equal(inNetworks(parseNetworks('192.168.1.10', 'TEST'), '192.168.1.11'), false);
    assert.equal(parseNetworks('*', 'TEST'), null);
    assert.equal(inNetworks(null, '8.8.8.8'), true);
  });

  for (const value of ['192.168.0.0/33', 'heimnetz', '10.0.0.0/x', '::1/129']) {
    it(`lehnt ungültige Angabe ab: ${value}`, () => {
      assert.throws(() => parseNetworks(value, 'ADMIN_NETWORKS'), /ADMIN_NETWORKS/);
    });
  }

  it('nutzt standardmäßig die privaten Netze', () => {
    const config = loadConfig({ ADMIN_PASSWORD: TEST_PASSWORD });
    assert.equal(inNetworks(config.adminNetworks, '192.168.178.20'), true);
    assert.equal(inNetworks(config.adminNetworks, '172.17.0.1'), true);
    assert.equal(inNetworks(config.adminNetworks, '93.184.216.34'), false);
  });

  it('übernimmt die Client-Adresse nur von vertrauenswürdigen Proxys', () => {
    const trusted = parseNetworks('172.16.0.0/12', 'TEST');
    const viaTunnel = fakeReq('172.18.0.5', { 'cf-connecting-ip': '93.184.216.34' });
    assert.equal(resolveClientIp(viaTunnel, trusted), '93.184.216.34');

    const xff = fakeReq('172.18.0.5', { 'x-forwarded-for': '1.1.1.1, 93.184.216.34' });
    assert.equal(resolveClientIp(xff, trusted), '93.184.216.34');

    const spoofed = fakeReq('8.8.8.8', { 'cf-connecting-ip': '1.2.3.4' });
    assert.equal(resolveClientIp(spoofed, trusted), '8.8.8.8');

    const garbage = fakeReq('172.18.0.5', { 'cf-connecting-ip': 'kein-ip' });
    assert.equal(resolveClientIp(garbage, trusted), '172.18.0.5');
  });

  for (const path of [
    '/admin',
    '/admin/',
    '/admin/admin.js',
    '/%61dmin/',
    '/ADMIN/',
    '/api/admin/login',
    '/api/%61dmin/rooms',
    '/%2fadmin/',
    '/.%2fadmin/',
    '/x/..%2fadmin/admin.js',
    '/%2e/admin/',
    '/x/%2e%2e/admin/admin.css',
    '//admin/',
    '/api/x/..%2fadmin/session',
  ]) {
    it(`erkennt Verwaltungspfad ${path}`, () => {
      assert.equal(isAdminPath(path), true);
    });
  }

  for (const path of [
    '/',
    '/join/ABCD2345',
    '/app.js',
    '/administration-ist-das-nicht',
    '/api/branding',
  ]) {
    it(`lässt anderen Pfad durch: ${path}`, () => {
      assert.equal(isAdminPath(path), false);
    });
  }
});

describe('Verwaltung nur im Heimnetz', () => {
  let server;
  afterEach(() => server.close());

  describe('Standard (private Netze)', () => {
    beforeEach(async () => {
      server = await startTestServer();
    });

    it('ist direkt aus dem Heimnetz erreichbar', async () => {
      assert.equal(await rawRequest(server.baseUrl, '/admin/'), 200);
      assert.equal(await rawRequest(server.baseUrl, '/api/admin/session'), 200);
    });

    for (const header of ['cf-connecting-ip', 'x-forwarded-for', 'x-real-ip', 'forwarded']) {
      it(`ist über Tunnel/Proxy nicht erreichbar (${header})`, async () => {
        const headers = {
          [header]: header === 'forwarded' ? 'for=93.184.216.34' : '93.184.216.34',
        };
        for (const path of [
          '/admin',
          '/admin/',
          '/admin/admin.js',
          '/%61dmin/admin.js',
          '/%2fadmin/',
          '/.%2fadmin/',
          '/x/..%2fadmin/admin.js',
          '/x/%2e%2e/admin/admin.css',
          '/api/admin/session',
        ]) {
          assert.equal(await rawRequest(server.baseUrl, path, { headers }), 404, path);
        }
        const login = await rawRequest(server.baseUrl, '/api/admin/login', {
          method: 'POST',
          headers: { ...headers, 'content-type': 'application/json' },
          body: JSON.stringify({ password: TEST_PASSWORD }),
        });
        assert.equal(login, 404);
      });
    }

    it('lässt die Teilnehmerseiten über den Tunnel erreichbar', async () => {
      const headers = { 'cf-connecting-ip': '93.184.216.34' };
      assert.equal(await rawRequest(server.baseUrl, '/', { headers }), 200);
      assert.equal(await rawRequest(server.baseUrl, '/join/ABCD2345', { headers }), 200);
      assert.equal(await rawRequest(server.baseUrl, '/api/branding', { headers }), 200);
    });
  });

  it('sperrt Adressen außerhalb von ADMIN_NETWORKS', async () => {
    server = await startTestServer({ env: { ADMIN_NETWORKS: '10.0.0.0/8' } });
    assert.equal(await rawRequest(server.baseUrl, '/admin/'), 404);
    assert.equal(await rawRequest(server.baseUrl, '/api/admin/session'), 404);
  });

  it('lässt mit ADMIN_NETWORKS=* alles zu', async () => {
    server = await startTestServer({ env: { ADMIN_NETWORKS: '*' } });
    const headers = { 'cf-connecting-ip': '93.184.216.34' };
    assert.equal(await rawRequest(server.baseUrl, '/admin/', { headers }), 200);
  });

  it('sperrt falsche Raum-Codes pro echter Client-Adresse hinter dem Tunnel', async () => {
    server = await startTestServer({
      deps: {
        hubOptions: { autoSweep: false, joinLimiter: new FailureLimiter({ maxFailures: 2 }) },
      },
    });
    const room = await server.rooms.create('Team');
    const connect = (ip) => {
      const host = new URL(server.baseUrl).host;
      return connectClient(server.wsUrl, { 'cf-connecting-ip': ip, origin: `https://${host}` });
    };

    const attacker = await connect('93.184.216.34');
    for (let i = 0; i < 2; i++) await attacker.join('ZZZZ2222', 'X');
    assert.equal((await attacker.join(room.code, 'X')).code, 'locked');

    // Eine andere Person hinter demselben Tunnel ist nicht betroffen.
    const colleague = await connect('203.0.113.7');
    assert.equal((await colleague.join(room.code, 'Anna')).type, 'joined');

    attacker.ws.terminate();
    colleague.ws.terminate();
  });
});

describe('Verwaltungs-Sperre gegen Pfad-Tricks', () => {
  let server;
  beforeEach(async () => {
    server = await startTestServer();
  });
  afterEach(() => server.close());

  it('liefert über den Tunnel keine Datei aus public/admin aus, egal wie der Pfad geschrieben ist', async () => {
    const headers = { 'cf-connecting-ip': '93.184.216.34' };
    const prefixes = ['', '/x/..', '/.', '/x/%2e%2e', '/%2e', '/x/y/../..'];
    const slashes = ['/', '%2f', '%2F', '//'];
    const names = ['admin', '%61dmin', 'ADMIN', 'adm%69n'];
    const files = ['', 'index.html', 'admin.js', 'admin.css'];
    let checked = 0;
    for (const prefix of prefixes) {
      for (const slash of slashes) {
        for (const name of names) {
          for (const file of files) {
            const target = `${prefix}${slash}${name}/${file}`;
            const path = target.startsWith('/') ? target : `/${target}`;
            const { status, body } = await rawFetch(server.baseUrl, path, headers);
            assert.ok(
              status !== 200 || !ADMIN_MARKERS.test(body),
              `${path} lieferte Verwaltung aus`,
            );
            checked += 1;
          }
        }
      }
    }
    assert.equal(checked, 384);
  });

  it('erkennt die Verwaltung an ihren Merkmalen (Gegenprobe im Heimnetz)', async () => {
    for (const path of ['/admin/', '/admin/admin.js', '/admin/admin.css']) {
      const { status, body } = await rawFetch(server.baseUrl, path);
      assert.equal(status, 200, path);
      assert.match(body, ADMIN_MARKERS, path);
    }
  });

  it('lässt normale Seiten über den Tunnel durch', async () => {
    const headers = { 'cf-connecting-ip': '93.184.216.34' };
    for (const path of ['/', '/app.js', '/theme.css', '/join/ABCD2345']) {
      assert.equal(await rawRequest(server.baseUrl, path, { headers }), 200, path);
    }
  });
});

describe('PUBLIC_URL', () => {
  it('übernimmt eine gültige Adresse ohne Schrägstrich am Ende', () => {
    const config = loadConfig({
      ADMIN_PASSWORD: TEST_PASSWORD,
      PUBLIC_URL: 'https://poker.example.de/',
    });
    assert.equal(config.publicUrl, 'https://poker.example.de');
    assert.equal(loadConfig({ ADMIN_PASSWORD: TEST_PASSWORD }).publicUrl, '');
  });

  for (const value of [
    'poker.example.de',
    'ftp://poker.example.de',
    'https://poker.example.de/raum',
    'https://x@poker.example.de',
  ]) {
    it(`lehnt ungültige Angabe ab: ${value}`, () => {
      assert.throws(
        () => loadConfig({ ADMIN_PASSWORD: TEST_PASSWORD, PUBLIC_URL: value }),
        /PUBLIC_URL/,
      );
    });
  }

  it('gibt die Adresse an die Verwaltung weiter', async () => {
    const server = await startTestServer({ env: { PUBLIC_URL: 'https://poker.example.de' } });
    try {
      const res = await fetch(`${server.baseUrl}/api/admin/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: TEST_PASSWORD }),
      });
      assert.equal((await res.json()).publicUrl, 'https://poker.example.de');
      const cookie = res.headers.get('set-cookie').split(';')[0];
      const session = await (
        await fetch(`${server.baseUrl}/api/admin/session`, { headers: { cookie } })
      ).json();
      assert.equal(session.publicUrl, 'https://poker.example.de');
    } finally {
      await server.close();
    }
  });
});
