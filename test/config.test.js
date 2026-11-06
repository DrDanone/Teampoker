import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import { MIN_ADMIN_PASSWORD_LENGTH, loadConfig } from '../server/config.js';

const PASSWORD = 'ein-sicheres-passwort';

describe('Konfiguration', () => {
  it('nutzt Standardwerte', () => {
    const config = loadConfig({ ADMIN_PASSWORD: PASSWORD });
    assert.equal(config.port, 3000);
    assert.equal(config.dataDir, path.resolve('./data'));
    assert.equal(config.adminPassword, PASSWORD);
  });

  it('übernimmt Werte aus der Umgebung', () => {
    const config = loadConfig({ PORT: '8080', DATA_DIR: '/data', ADMIN_PASSWORD: PASSWORD });
    assert.equal(config.port, 8080);
    assert.equal(config.dataDir, '/data');
  });

  for (const port of ['abc', '-1', '70000', '1.5']) {
    it(`lehnt ungültigen PORT ab: ${port}`, () => {
      assert.throws(() => loadConfig({ PORT: port, ADMIN_PASSWORD: PASSWORD }), /Ungültiger PORT/);
    });
  }

  it('verlangt ein Admin-Passwort', () => {
    assert.throws(() => loadConfig({}), /ADMIN_PASSWORD ist nicht gesetzt/);
    assert.throws(() => loadConfig({ ADMIN_PASSWORD: '' }), /ADMIN_PASSWORD ist nicht gesetzt/);
  });

  it(`verlangt mindestens ${MIN_ADMIN_PASSWORD_LENGTH} Zeichen`, () => {
    const short = 'x'.repeat(MIN_ADMIN_PASSWORD_LENGTH - 1);
    assert.throws(() => loadConfig({ ADMIN_PASSWORD: short }), /mindestens/);
    const exact = 'x'.repeat(MIN_ADMIN_PASSWORD_LENGTH);
    assert.equal(loadConfig({ ADMIN_PASSWORD: exact }).adminPassword, exact);
  });
});
