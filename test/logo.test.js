import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { LogoError, LogoStore, MAX_LOGO_BYTES, validateLogo } from '../server/branding/logo.js';
import { TEST_PASSWORD, startTestServer } from './helpers.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46]);
const WEBP = Buffer.concat([
  Buffer.from('RIFF'),
  Buffer.from([0, 0, 0, 0]),
  Buffer.from('WEBPVP8 '),
]);
const SVG = Buffer.from(
  '<?xml version="1.0" encoding="UTF-8"?>\n<!-- Generator: Test -->\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><defs><linearGradient id="g"/></defs><rect width="10" height="10" fill="url(#g)" style="fill:#951b81"/><use href="#g"/></svg>',
);

describe('Logo-Prüfung', () => {
  for (const [label, data, type] of [
    ['PNG', PNG, 'image/png'],
    ['JPEG', JPEG, 'image/jpeg'],
    ['JPEG als image/jpg', JPEG, 'image/jpg'],
    ['WebP', WEBP, 'image/webp'],
    ['SVG', SVG, 'image/svg+xml'],
    [
      'SVG mit eingebettetem PNG',
      Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg"><image href="data:image/png;base64,iVBORw0KGgo="/></svg>',
      ),
      'image/svg+xml',
    ],
  ]) {
    it(`akzeptiert ${label}`, () => {
      assert.ok(validateLogo(data, type));
    });
  }

  for (const [label, svg] of [
    ['Skript', '<svg><script>alert(1)</script></svg>'],
    ['Skript mit Leerzeichen', '<svg>< script>alert(1)</script></svg>'],
    ['Event-Handler', '<svg onload="alert(1)"></svg>'],
    ['Event-Handler in Element', '<svg><rect ONCLICK = "x()"/></svg>'],
    ['javascript-Link', '<svg><a href="javascript:alert(1)"><text>x</text></a></svg>'],
    ['externer Link', '<svg><image href="https://boese.example/x.png"/></svg>'],
    ['xlink extern', '<svg><use xlink:href="other.svg#a"/></svg>'],
    ['SVG in data-URL', '<svg><image href="data:image/svg+xml;base64,PHN2Zz4="/></svg>'],
    ['foreignObject', '<svg><foreignObject><div>x</div></foreignObject></svg>'],
    ['Animation', '<svg><set attributeName="href" to="javascript:alert(1)"/></svg>'],
    ['DOCTYPE', '<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY x "y">]><svg>&x;</svg>'],
    ['kodierte Zeichen', '<svg><a href="&#106;avascript:alert(1)"/></svg>'],
    ['CSS-Import', '<svg><style>@import "https://boese.example/x.css";</style></svg>'],
    ['CSS-URL extern', '<svg><rect style="fill:url(https://boese.example/x)"/></svg>'],
  ]) {
    it(`lehnt SVG ab: ${label}`, () => {
      assert.throws(() => validateLogo(Buffer.from(svg), 'image/svg+xml'), LogoError);
    });
  }

  it('lehnt ungültiges UTF-8 in SVG ab', () => {
    const data = Buffer.concat([
      Buffer.from('<svg>'),
      Buffer.from([0xff, 0xfe]),
      Buffer.from('</svg>'),
    ]);
    assert.throws(() => validateLogo(data, 'image/svg+xml'), /UTF-8/);
  });

  it('lehnt Dateien ab, deren Inhalt nicht zum Typ passt', () => {
    assert.throws(() => validateLogo(PNG, 'image/svg+xml'), /passen nicht/);
    assert.throws(() => validateLogo(SVG, 'image/png'), /passen nicht/);
  });

  it('lehnt unbekannte Formate ab, auch wenn sie sich als Bild ausgeben', () => {
    assert.throws(
      () => validateLogo(Buffer.from('<html><script>x</script>'), 'image/png'),
      /Unbekannt/,
    );
    assert.throws(() => validateLogo(Buffer.from('GIF89a'), 'image/gif'), /Unbekannt/);
  });

  it('begrenzt die Größe', () => {
    const big = Buffer.concat([PNG, Buffer.alloc(MAX_LOGO_BYTES)]);
    assert.throws(() => validateLogo(big, 'image/png'), /1 MB/);
    assert.throws(() => validateLogo(Buffer.alloc(0), 'image/png'), /leer/);
  });
});

describe('Logo-API', () => {
  let server;
  let cookie;
  let csrfToken;

  beforeEach(async () => {
    server = await startTestServer();
    const res = await fetch(`${server.baseUrl}/api/admin/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: TEST_PASSWORD }),
    });
    cookie = res.headers.get('set-cookie').split(';')[0];
    csrfToken = (await res.json()).csrfToken;
  });
  afterEach(() => server.close());

  function upload(data, type, headers = { cookie, 'x-csrf-token': csrfToken }) {
    return fetch(`${server.baseUrl}/api/admin/logo`, {
      method: 'PUT',
      headers: { 'content-type': type, ...headers },
      body: data,
    });
  }

  it('hat anfangs kein Logo', async () => {
    assert.deepEqual(await (await fetch(`${server.baseUrl}/api/branding`)).json(), {
      logo: null,
      name: 'Teampoker',
    });
    assert.equal((await fetch(`${server.baseUrl}/logo`)).status, 404);
  });

  it('lädt hoch, liefert sicher aus und übersteht einen Neustart', async () => {
    const res = await upload(SVG, 'image/svg+xml');
    assert.equal(res.status, 200);
    const { logo } = await res.json();
    assert.match(logo.url, /^\/logo\?v=[\w-]+$/);

    const branding = await (await fetch(`${server.baseUrl}/api/branding`)).json();
    assert.deepEqual(branding.logo, logo);

    const served = await fetch(`${server.baseUrl}${logo.url}`);
    assert.equal(served.status, 200);
    assert.equal(served.headers.get('content-type'), 'image/svg+xml');
    assert.equal(served.headers.get('x-content-type-options'), 'nosniff');
    assert.match(served.headers.get('content-security-policy'), /sandbox/);
    assert.match(served.headers.get('content-security-policy'), /default-src 'none'/);
    assert.deepEqual(Buffer.from(await served.arrayBuffer()), SVG);

    const etag = served.headers.get('etag');
    const cached = await fetch(`${server.baseUrl}/logo`, { headers: { 'if-none-match': etag } });
    assert.equal(cached.status, 304);

    const reloaded = await new LogoStore(server.dataDir).load();
    assert.deepEqual(reloaded.get().data, SVG);
    assert.equal(reloaded.get().type, 'image/svg+xml');
  });

  it('ersetzt und entfernt das Logo', async () => {
    await upload(SVG, 'image/svg+xml');
    await upload(PNG, 'image/png');
    assert.equal((await fetch(`${server.baseUrl}/logo`)).headers.get('content-type'), 'image/png');

    const res = await fetch(`${server.baseUrl}/api/admin/logo`, {
      method: 'DELETE',
      headers: { cookie, 'x-csrf-token': csrfToken },
    });
    assert.equal(res.status, 200);
    assert.equal((await fetch(`${server.baseUrl}/logo`)).status, 404);
    assert.equal((await new LogoStore(server.dataDir).load()).get(), null);
  });

  it('meldet abgelehnte Dateien verständlich und behält das alte Logo', async () => {
    await upload(PNG, 'image/png');
    const res = await upload(Buffer.from('<svg onload="x()"></svg>'), 'image/svg+xml');
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /Event-Handler/);
    assert.equal((await fetch(`${server.baseUrl}/logo`)).headers.get('content-type'), 'image/png');
  });

  it('lehnt zu große Dateien ab', async () => {
    const res = await upload(Buffer.concat([PNG, Buffer.alloc(MAX_LOGO_BYTES)]), 'image/png');
    assert.equal(res.status, 413);
  });

  it('verlangt Anmeldung und CSRF-Token', async () => {
    assert.equal((await upload(PNG, 'image/png', {})).status, 401);
    assert.equal((await upload(PNG, 'image/png', { cookie })).status, 403);
    assert.equal((await fetch(`${server.baseUrl}/logo`)).status, 404);
  });
});

describe('LogoStore', () => {
  it('startet ohne Logo, wenn die gespeicherte Datei manipuliert wurde', async () => {
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'teampoker-'));
    try {
      await writeFile(path.join(dir, 'logo.json'), JSON.stringify({ type: 'image/svg+xml' }));
      await writeFile(path.join(dir, 'logo.bin'), '<svg><script>x</script></svg>');
      const store = await new LogoStore(dir).load();
      assert.equal(store.get(), null);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
