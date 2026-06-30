#!/usr/bin/env node
import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveCodexVersion } from './resolve-flatpak-deps.mjs';

const shaA = 'a'.repeat(64);
const shaB = 'b'.repeat(64);

test('same DMG hash produces same fallback version', () => {
  const first = resolveCodexVersion({ dmgSha256: shaA, dmgLastModified: 'Tue, 30 Jun 2026 12:34:56 GMT' });
  const second = resolveCodexVersion({ dmgSha256: shaA, dmgLastModified: 'Tue, 30 Jun 2026 12:34:56 GMT' });
  assert.equal(first, second);
  assert.equal(first, '2026.06.30.1234+dmg.aaaaaaaa');
});

test('changed DMG hash changes fallback version', () => {
  const first = resolveCodexVersion({ dmgSha256: shaA, dmgSize: 525052314 });
  const second = resolveCodexVersion({ dmgSha256: shaB, dmgSize: 525052314 });
  assert.notEqual(first, second);
  assert.equal(second, '525052314+dmg.bbbbbbbb');
});

test('explicit PACKAGE_VERSION or FLATPAK_APP_VERSION override wins', () => {
  assert.equal(
    resolveCodexVersion({ appVersion: '1.2.3', dmgSha256: shaA, packageVersion: '9.8.7+package' }),
    '9.8.7+package',
  );
  assert.equal(
    resolveCodexVersion({ appVersion: '1.2.3', dmgSha256: shaA, packageVersion: '9.8.7+package', flatpakAppVersion: '7.8.9+flatpak' }),
    '7.8.9+flatpak',
  );
});

test('upstream app metadata is used without a DMG hash suffix', () => {
  assert.equal(resolveCodexVersion({ appVersion: '1.2.3', dmgSha256: shaA }), '1.2.3');
  assert.equal(resolveCodexVersion({ appVersion: '26.616.81150', dmgSha256: shaA }), '26.616.81150');
});

test('placeholder 0.0.0 app metadata falls back to pinned version plus DMG hash', () => {
  assert.equal(
    resolveCodexVersion({ appVersion: '0.0.0', dmgSha256: shaA, pinnedVersion: '26.616.81150' }),
    '26.616.81150+dmg.aaaaaaaa',
  );
});
