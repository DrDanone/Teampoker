import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import { loadConfig } from '../server/config.js';

describe('Konfiguration', () => {
  it('nutzt Standardwerte', () => {
    const config = loadConfig({});
    assert.equal(config.port, 3000);
    assert.equal(config.dataDir, path.resolve('./data'));
    assert.equal(config.adminPassword, '');
  });

  it('übernimmt Werte aus der Umgebung', () => {
    const config = loadConfig({ PORT: '8080', DATA_DIR: '/data', ADMIN_PASSWORD: 'geheim' });
    assert.equal(config.port, 8080);
    assert.equal(config.dataDir, '/data');
    assert.equal(config.adminPassword, 'geheim');
  });

  for (const port of ['abc', '-1', '70000', '1.5']) {
    it(`lehnt ungültigen PORT ab: ${port}`, () => {
      assert.throws(() => loadConfig({ PORT: port }), /Ungültiger PORT/);
    });
  }
});
