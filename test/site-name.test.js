import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  DEFAULT_SITE_NAME,
  MAX_SITE_NAME_LENGTH,
  SiteNameError,
  SiteNameStore,
  cleanSiteName,
} from '../server/branding/site-name.js';
import { escapeHtml } from '../server/http.js';
import { TEST_PASSWORD, startTestServer } from './helpers.js';

const ZERO_WIDTH_SPACE = String.fromCharCode(0x200b);

describe('cleanSiteName', () => {
  it('bereinigt Leerraum, Steuer- und unsichtbare Zeichen', () => {
    assert.equal(cleanSiteName('  Team\tESM \n Poker  '), 'Team ESM Poker');
    assert.equal(cleanSiteName(`ESM${ZERO_WIDTH_SPACE}-Poker`), 'ESM-Poker');
    assert.equal(cleanSiteName('Schätzrunde & Co.'), 'Schätzrunde & Co.');
  });

  it(`erlaubt höchstens ${MAX_SITE_NAME_LENGTH} Zeichen`, () => {
    assert.equal(cleanSiteName('ä'.repeat(MAX_SITE_NAME_LENGTH)).length, MAX_SITE_NAME_LENGTH);
    assert.throws(() => cleanSiteName('x'.repeat(MAX_SITE_NAME_LENGTH + 1)), SiteNameError);
  });

  it('lehnt Leeres und Nicht-Text ab', () => {
    for (const value of ['', '   ', ZERO_WIDTH_SPACE, 42, null, undefined, ['Name']]) {
      assert.throws(() => cleanSiteName(value), SiteNameError);
    }
  });
});

describe('escapeHtml', () => {
  it('maskiert alle HTML-Sonderzeichen', () => {
    assert.equal(
      escapeHtml(`<a href="x" title='y'>&</a>`),
      '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;',
    );
  });
});

describe('Seitenname', () => {
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

  function setName(name, headers = { cookie, 'x-csrf-token': csrfToken }) {
    return fetch(`${server.baseUrl}/api/admin/name`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ name }),
    });
  }

  async function page(pathname) {
    return (await fetch(`${server.baseUrl}${pathname}`)).text();
  }

  it('zeigt ohne eigene Angabe den Standardnamen', async () => {
    const branding = await (await fetch(`${server.baseUrl}/api/branding`)).json();
    assert.equal(branding.name, DEFAULT_SITE_NAME);
    for (const pathname of ['/', '/join/ABCD2345', '/admin/']) {
      const html = await page(pathname);
      assert.doesNotMatch(html, /\{\{SITE_NAME\}\}/, pathname);
      assert.match(html, /<p id="site-name" class="brand">Teampoker<\/p>/, pathname);
    }
    assert.match(await page('/'), /<title>Teampoker<\/title>/);
    assert.match(await page('/admin/'), /<title>Verwaltung – Teampoker<\/title>/);
  });

  it('setzt den Namen in Seiten und Schnittstelle ein und übersteht einen Neustart', async () => {
    const res = await setName('  ESM   Schätzrunde ');
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { name: 'ESM Schätzrunde' });

    const branding = await (await fetch(`${server.baseUrl}/api/branding`)).json();
    assert.equal(branding.name, 'ESM Schätzrunde');
    const html = await page('/');
    assert.match(html, /<title>ESM Schätzrunde<\/title>/);
    assert.match(html, /<p id="site-name" class="brand">ESM Schätzrunde<\/p>/);

    // Länge im Header passt zum veränderten Inhalt
    const head = await fetch(`${server.baseUrl}/`, { method: 'HEAD' });
    assert.equal(Number(head.headers.get('content-length')), Buffer.byteLength(html));

    const reloaded = await new SiteNameStore(server.dataDir).load();
    assert.equal(reloaded.get(), 'ESM Schätzrunde');
  });

  it('maskiert HTML im Namen', async () => {
    const evil = `<img src=x onerror="alert('x')">`;
    assert.equal((await setName(evil)).status, 200);
    const html = await page('/');
    assert.ok(!html.includes('<img src=x'));
    assert.ok(html.includes(`<title>${escapeHtml(evil)}</title>`));
    assert.ok(html.includes(`class="brand">${escapeHtml(evil)}</p>`));
  });

  it('stellt mit leerem Namen den Standard wieder her', async () => {
    await setName('Team ESM');
    const res = await setName('   ');
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { name: DEFAULT_SITE_NAME });
    assert.match(await page('/'), /<title>Teampoker<\/title>/);
    await assert.rejects(readFile(path.join(server.dataDir, 'site.json')), { code: 'ENOENT' });
  });

  it('lehnt ungültige Namen verständlich ab und behält den alten', async () => {
    await setName('Team ESM');
    const tooLong = await setName('x'.repeat(MAX_SITE_NAME_LENGTH + 1));
    assert.equal(tooLong.status, 400);
    assert.match((await tooLong.json()).error, /höchstens 40 Zeichen/);
    assert.equal((await setName(123)).status, 400);
    assert.equal((await (await fetch(`${server.baseUrl}/api/branding`)).json()).name, 'Team ESM');
  });

  it('verlangt Anmeldung und CSRF-Token', async () => {
    assert.equal((await setName('Fremd', {})).status, 401);
    assert.equal((await setName('Fremd', { cookie })).status, 403);
    assert.equal((await setName('Fremd', { cookie, 'x-csrf-token': 'falsch' })).status, 403);
    const wrongOrigin = await setName('Fremd', {
      cookie,
      'x-csrf-token': csrfToken,
      origin: 'https://boese.example',
    });
    assert.equal(wrongOrigin.status, 403);
    const getRes = await fetch(`${server.baseUrl}/api/admin/name`, { headers: { cookie } });
    assert.equal(getRes.status, 405);
    assert.equal(
      (await (await fetch(`${server.baseUrl}/api/branding`)).json()).name,
      DEFAULT_SITE_NAME,
    );
  });

  it('ist über Tunnel oder Proxy nicht änderbar', async () => {
    const res = await setName('Fremd', {
      cookie,
      'x-csrf-token': csrfToken,
      'cf-connecting-ip': '203.0.113.7',
    });
    assert.equal(res.status, 404);
  });

  it('startet mit beschädigter Datei mit dem Standardnamen', async () => {
    await writeFile(path.join(server.dataDir, 'site.json'), '{kaputt');
    assert.equal((await new SiteNameStore(server.dataDir).load()).get(), DEFAULT_SITE_NAME);
    await writeFile(
      path.join(server.dataDir, 'site.json'),
      JSON.stringify({ name: 'x'.repeat(100) }),
    );
    assert.equal((await new SiteNameStore(server.dataDir).load()).get(), DEFAULT_SITE_NAME);
  });
});
