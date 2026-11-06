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
