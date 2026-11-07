import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  ABSOLUTE_TIMEOUT_MS,
  IDLE_TIMEOUT_MS,
  SESSION_COOKIE,
  SessionStore,
  safeEqual,
} from '../server/admin/sessions.js';
import { FailureLimiter } from '../server/ratelimit.js';
import { TEST_PASSWORD, startTestServer } from './helpers.js';

/** Kleiner Client, der das Session-Cookie und das CSRF-Token mitführt. */
function createClient(baseUrl) {
  let cookie = '';
  let csrfToken = '';

  async function request(method, path, { json, headers = {}, csrf = true } = {}) {
    const init = { method, headers: { ...headers }, redirect: 'manual' };
    if (cookie) init.headers.cookie = cookie;
    if (csrf && csrfToken && method !== 'GET') init.headers['x-csrf-token'] = csrfToken;
    if (json !== undefined) {
      init.headers['content-type'] = 'application/json';
      init.body = JSON.stringify(json);
    }
    const res = await fetch(`${baseUrl}${path}`, init);
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0].endsWith('=') ? '' : setCookie.split(';')[0];
    const body = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
    if (body?.csrfToken) csrfToken = body.csrfToken;
    return { res, body, setCookie };
  }

  return {
    request,
    login: (password = TEST_PASSWORD, headers) =>
      request('POST', '/api/admin/login', { json: { password }, headers }),
    get cookie() {
      return cookie;
    },
    set cookie(value) {
      cookie = value;
    },
    get csrfToken() {
      return csrfToken;
    },
  };
}

describe('Admin-API', () => {
  let server;
  let client;
  beforeEach(async () => {
    server = await startTestServer();
    client = createClient(server.baseUrl);
  });
  afterEach(() => server.close());

  describe('Anmeldung', () => {
    it('lehnt ein falsches Passwort ab', async () => {
      const { res, body } = await client.login('falsch');
      assert.equal(res.status, 401);
      assert.equal(body.error, 'Passwort falsch');
      assert.equal(client.cookie, '');
    });

    it('lehnt fehlende oder falsche Typen ab', async () => {
      for (const password of [undefined, 42, null, ['x']]) {
        const { res } = await client.request('POST', '/api/admin/login', { json: { password } });
        assert.equal(res.status, 401);
      }
    });

    it('meldet mit richtigem Passwort an und setzt ein sicheres Cookie', async () => {
      const { res, body, setCookie } = await client.login();
      assert.equal(res.status, 200);
      assert.equal(body.authenticated, true);
      assert.ok(body.csrfToken.length >= 32);
      assert.match(setCookie, new RegExp(`^${SESSION_COOKIE}=[A-Za-z0-9_-]{40,};`));
      assert.match(setCookie, /HttpOnly/);
      assert.match(setCookie, /SameSite=Strict/);
      assert.match(setCookie, /Path=\//);
      assert.doesNotMatch(setCookie, /Secure/);
    });

    it('setzt Secure, wenn die Anfrage über HTTPS kam', async () => {
      const { setCookie } = await client.login(TEST_PASSWORD, { 'x-forwarded-proto': 'https' });
      assert.match(setCookie, /Secure/);
    });

    it('sperrt nach fünf Fehlversuchen', async () => {
      for (let i = 0; i < 4; i++) assert.equal((await client.login('falsch')).res.status, 401);
      const fifth = await client.login('falsch');
      assert.equal(fifth.res.status, 429);
      assert.ok(Number(fifth.res.headers.get('retry-after')) > 0);
      // Auch das richtige Passwort hilft während der Sperre nicht.
      assert.equal((await client.login()).res.status, 429);
    });

    it('verlangt JSON', async () => {
      const res = await fetch(`${server.baseUrl}/api/admin/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: `password=${TEST_PASSWORD}`,
      });
      assert.equal(res.status, 415);
    });

    it('lehnt zu große Anfragen ab', async () => {
      const { res } = await client.request('POST', '/api/admin/login', {
        json: { password: 'x'.repeat(20_000) },
      });
      assert.equal(res.status, 413);
    });

    it('lehnt ungültiges JSON ab', async () => {
      const res = await fetch(`${server.baseUrl}/api/admin/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{ kaputt',
      });
      assert.equal(res.status, 400);
    });

    it('lehnt fremde Herkunft ab', async () => {
      const { res } = await client.login(TEST_PASSWORD, { origin: 'https://boese.example' });
      assert.equal(res.status, 403);
    });

    it('meldet den Sitzungsstatus', async () => {
      assert.deepEqual((await client.request('GET', '/api/admin/session')).body, {
        authenticated: false,
      });
      await client.login();
      const { body } = await client.request('GET', '/api/admin/session');
      assert.equal(body.authenticated, true);
      assert.equal(body.csrfToken, client.csrfToken);
    });

    it('meldet ab und macht die Sitzung ungültig', async () => {
      await client.login();
      const oldCookie = client.cookie;
      const { res, setCookie } = await client.request('POST', '/api/admin/logout');
      assert.equal(res.status, 200);
      assert.match(setCookie, /Max-Age=0/);

      client.cookie = oldCookie;
      assert.equal((await client.request('GET', '/api/admin/rooms')).res.status, 401);
    });

    it('ersetzt beim erneuten Anmelden die alte Sitzung', async () => {
      await client.login();
      const oldCookie = client.cookie;
      await client.login();
      assert.notEqual(client.cookie, oldCookie);
      const newCookie = client.cookie;

      client.cookie = oldCookie;
      assert.equal((await client.request('GET', '/api/admin/rooms')).res.status, 401);
      client.cookie = newCookie;
      assert.equal((await client.request('GET', '/api/admin/rooms')).res.status, 200);
    });
  });

  describe('ohne Anmeldung', () => {
    for (const [method, path] of [
      ['GET', '/api/admin/rooms'],
      ['POST', '/api/admin/rooms'],
      ['PATCH', '/api/admin/rooms/abc'],
      ['DELETE', '/api/admin/rooms/abc'],
      ['POST', '/api/admin/rooms/abc/code'],
      ['POST', '/api/admin/logout'],
    ]) {
      it(`sperrt ${method} ${path}`, async () => {
        const json = method === 'GET' ? undefined : { name: 'x' };
        const { res } = await client.request(method, path, { json });
        assert.equal(res.status, 401);
      });
    }

    it('lehnt gefälschte Cookies ab', async () => {
      client.cookie = `${SESSION_COOKIE}=erfunden`;
      assert.equal((await client.request('GET', '/api/admin/rooms')).res.status, 401);
    });
  });

  describe('Raumverwaltung', () => {
    beforeEach(() => client.login());

    it('legt Räume an, listet, benennt um und löscht', async () => {
      const created = await client.request('POST', '/api/admin/rooms', {
        json: { name: 'Team ESM' },
      });
      assert.equal(created.res.status, 201);
      const { room } = created.body;
      assert.equal(room.name, 'Team ESM');
      assert.match(room.code, /^[A-Z2-9]{8}$/);

      const list = await client.request('GET', '/api/admin/rooms');
      assert.deepEqual(list.body.rooms, [room]);

      const renamed = await client.request('PATCH', `/api/admin/rooms/${room.id}`, {
        json: { name: 'Team Abrechnung' },
      });
      assert.equal(renamed.body.room.name, 'Team Abrechnung');
      assert.equal(server.rooms.get(room.id).name, 'Team Abrechnung');

      const deleted = await client.request('DELETE', `/api/admin/rooms/${room.id}`);
      assert.equal(deleted.res.status, 200);
      assert.deepEqual(server.rooms.list(), []);
    });

    it('erzeugt einen neuen Code', async () => {
      const { room } = (await client.request('POST', '/api/admin/rooms', { json: { name: 'T' } }))
        .body;
      const { body } = await client.request('POST', `/api/admin/rooms/${room.id}/code`);
      assert.notEqual(body.room.code, room.code);
      assert.equal(server.rooms.findByCode(room.code), null);
    });

    it('meldet ungültige Namen', async () => {
      const { res, body } = await client.request('POST', '/api/admin/rooms', {
        json: { name: ' ' },
      });
      assert.equal(res.status, 400);
      assert.equal(body.error, 'Name fehlt');
    });

    it('meldet unbekannte Räume', async () => {
      const { res } = await client.request('DELETE', '/api/admin/rooms/gibt-es-nicht');
      assert.equal(res.status, 404);
    });

    it('verlangt das CSRF-Token', async () => {
      const { res } = await client.request('POST', '/api/admin/rooms', {
        json: { name: 'Team' },
        csrf: false,
      });
      assert.equal(res.status, 403);
      const wrong = await client.request('POST', '/api/admin/rooms', {
        json: { name: 'Team' },
        csrf: false,
        headers: { 'x-csrf-token': 'falsch' },
      });
      assert.equal(wrong.res.status, 403);
      assert.deepEqual(server.rooms.list(), []);
    });

    it('lehnt fremde Herkunft trotz gültigem Token ab', async () => {
      const { res } = await client.request('POST', '/api/admin/rooms', {
        json: { name: 'Team' },
        headers: { origin: 'https://boese.example' },
      });
      assert.equal(res.status, 403);
    });

    it('meldet falsche Methoden', async () => {
      const { res } = await client.request('PUT', '/api/admin/rooms');
      assert.equal(res.status, 405);
      assert.equal(res.headers.get('allow'), 'GET, POST');
    });

    it('antwortet nicht cachebar', async () => {
      const { res } = await client.request('GET', '/api/admin/rooms');
      assert.equal(res.headers.get('cache-control'), 'no-store');
    });
  });
});

describe('Admin-Seite', () => {
  let server;
  beforeEach(async () => {
    server = await startTestServer();
  });
  afterEach(() => server.close());

  it('leitet /admin auf /admin/ um', async () => {
    const res = await fetch(`${server.baseUrl}/admin`, { redirect: 'manual' });
    assert.equal(res.status, 301);
    assert.equal(res.headers.get('location'), '/admin/');
  });

  it('liefert die Admin-Seite ohne Inline-Skripte aus', async () => {
    const res = await fetch(`${server.baseUrl}/admin/`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /<script src="\/admin\/admin\.js" type="module"><\/script>/);
    assert.doesNotMatch(html, /<script>(?!<\/script>)/);
    assert.doesNotMatch(html, /\son[a-z]+=/i);
  });
});

describe('SessionStore', () => {
  it('läuft nach Inaktivität ab', () => {
    let now = 0;
    const sessions = new SessionStore({ now: () => now });
    const { id } = sessions.create();
    now = IDLE_TIMEOUT_MS - 1;
    assert.ok(sessions.get(id));
    now += IDLE_TIMEOUT_MS - 1;
    assert.ok(sessions.get(id), 'Zugriff verlängert die Sitzung');
    now += IDLE_TIMEOUT_MS + 1;
    assert.equal(sessions.get(id), null);
  });

  it('läuft spätestens nach der Höchstdauer ab', () => {
    let now = 0;
    const sessions = new SessionStore({ now: () => now });
    const { id } = sessions.create();
    while (now < ABSOLUTE_TIMEOUT_MS) {
      now += IDLE_TIMEOUT_MS / 2;
      sessions.get(id);
    }
    now += 1;
    assert.equal(sessions.get(id), null);
  });

  it('erzeugt unterschiedliche Sitzungen und Tokens', () => {
    const sessions = new SessionStore();
    const a = sessions.create();
    const b = sessions.create();
    assert.notEqual(a.id, b.id);
    assert.notEqual(a.csrfToken, b.csrfToken);
  });
});

describe('safeEqual', () => {
  it('vergleicht korrekt', () => {
    assert.equal(safeEqual('abc', 'abc'), true);
    assert.equal(safeEqual('abc', 'abd'), false);
    assert.equal(safeEqual('abc', 'abcd'), false);
    assert.equal(safeEqual('', ''), true);
    assert.equal(safeEqual(undefined, 'abc'), false);
    assert.equal(safeEqual(42, '42'), false);
  });
});

describe('FailureLimiter', () => {
  it('sperrt nach der Höchstzahl und gibt nach Ablauf wieder frei', () => {
    let now = 0;
    const limiter = new FailureLimiter({
      maxFailures: 3,
      windowMs: 1000,
      lockMs: 5000,
      now: () => now,
    });
    limiter.recordFailure('ip');
    limiter.recordFailure('ip');
    assert.equal(limiter.lockedFor('ip'), 0);
    limiter.recordFailure('ip');
    assert.equal(limiter.lockedFor('ip'), 5000);
    assert.equal(limiter.lockedFor('andere-ip'), 0);
    now = 5001;
    assert.equal(limiter.lockedFor('ip'), 0);
    limiter.recordFailure('ip');
    assert.equal(limiter.lockedFor('ip'), 0, 'Zähler beginnt neu');
  });

  it('vergisst Fehlversuche außerhalb des Zeitfensters', () => {
    let now = 0;
    const limiter = new FailureLimiter({ maxFailures: 2, windowMs: 1000, now: () => now });
    limiter.recordFailure('ip');
    now = 1500;
    limiter.recordFailure('ip');
    assert.equal(limiter.lockedFor('ip'), 0);
  });

  it('setzt nach Erfolg zurück', () => {
    const limiter = new FailureLimiter({ maxFailures: 2 });
    limiter.recordFailure('ip');
    limiter.reset('ip');
    limiter.recordFailure('ip');
    assert.equal(limiter.lockedFor('ip'), 0);
  });

  it('begrenzt den Speicherbedarf', () => {
    const limiter = new FailureLimiter({ maxEntries: 10 });
    for (let i = 0; i < 100; i++) limiter.recordFailure(`ip-${i}`);
    assert.ok(limiter.size <= 11, `size ${limiter.size}`);
  });
});
