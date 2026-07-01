#!/usr/bin/env node
import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveCodexVersion } from './resolve-flatpak-deps.mjs';

test('DMG hash alone is not accepted as an app version source', () => {
  assert.throws(
    () => resolveCodexVersion({}),
    /must be resolved from upstream app metadata/,
  );
});

test('explicit PACKAGE_VERSION or FLATPAK_APP_VERSION override wins', () => {
  assert.equal(
    resolveCodexVersion({ appVersion: '1.2.3', packageVersion: '9.8.7+package' }),
    '9.8.7+package',
  );
  assert.equal(
    resolveCodexVersion({ appVersion: '1.2.3', packageVersion: '9.8.7+package', flatpakAppVersion: '7.8.9+flatpak' }),
    '7.8.9+flatpak',
  );
});

test('upstream app metadata is used without a DMG hash suffix', () => {
  assert.equal(resolveCodexVersion({ appVersion: '1.2.3' }), '1.2.3');
  assert.equal(resolveCodexVersion({ appVersion: '26.616.81150' }), '26.616.81150');
});

test('placeholder app metadata is rejected instead of using a pinned fallback', () => {
  assert.throws(
    () => resolveCodexVersion({ appVersion: '0.0.0' }),
    /must be resolved from upstream app metadata/,
  );
});
