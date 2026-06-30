#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..', '..');
const flatpakDir = path.join(repoRoot, 'packaging', 'flatpak');

function readJson(relative) {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, relative), 'utf8'));
}
function fail(message) {
  console.error(message);
  process.exitCode = 1;
}
function assertEqual(actual, expected, label) {
  if (actual !== expected) fail(`${label}: expected ${expected}, got ${actual}`);
}
function assertFile(relative) {
  if (!fs.existsSync(path.join(repoRoot, relative))) fail(`Missing ${relative}`);
}
function assertNonEmptyArray(relative) {
  const value = readJson(relative);
  if (!Array.isArray(value) || value.length === 0) fail(`${relative} must be a non-empty array`);
}

function manifestSources(manifest) {
  return manifest.modules?.find((module) => module.name === 'codex-desktop-linux')?.sources ?? [];
}
function sourceDestFilenames(sources) {
  return sources
    .filter((source) => source?.type === 'file' && source.dest === '.flatpak-sources')
    .map((source) => source['dest-filename'])
    .sort();
}
function countSource(sources, filename) {
  return sourceDestFilenames(sources).filter((value) => value === filename).length;
}
function assertSourcePresence(sources, filename, expectedPresent, label) {
  const actualCount = countSource(sources, filename);
  if (expectedPresent && actualCount === 0) fail(`${label}: expected ${filename} source to be present`);
  if (!expectedPresent && actualCount !== 0) fail(`${label}: expected ${filename} source to be omitted, found ${actualCount}`);
}
function flatpakRuntimePythonStrategy(toolStrategy) {
  return toolStrategy.runtimePython?.strategy ?? toolStrategy.runtimePython ?? 'bundled';
}
function validateRuntimePythonStrategy(upstreamValue, label) {
  const toolStrategy = upstreamValue.flatpakToolStrategy ?? {};
  const strategy = flatpakRuntimePythonStrategy(toolStrategy);
  if (strategy === 'sdk' && toolStrategy.runtimePython?.probe?.available !== true) {
    fail(`${label}: runtimePython="sdk" is invalid unless the final runtime /usr/bin/python3 probe passed`);
  }
}
function selectedStrategies(upstreamValue) {
  const toolStrategy = upstreamValue.flatpakToolStrategy ?? {};
  return {
    sevenZip: upstreamValue.sevenZip?.strategy ?? toolStrategy.buildSevenZip ?? 'bundled',
    python: upstreamValue.python?.runtimeStrategy ?? upstreamValue.python?.strategy ?? upstreamValue.pythonStandalone?.strategy ?? flatpakRuntimePythonStrategy(toolStrategy),
    electron: upstreamValue.electronRuntime?.strategy ?? 'bundled',
    electronHeaders: upstreamValue.electronRuntime?.headersStrategy ?? 'source',
    nodeBuild: upstreamValue.node?.buildStrategy ?? upstreamValue.flatpakToolStrategy?.buildNode?.strategy ?? 'bundled-managed-node',
    nodeRuntime: upstreamValue.node?.runtimeStrategy ?? 'bundled-managed-node',
  };
}
function assertManifestSourcesForStrategies(manifest, upstreamValue, label) {
  const sources = manifestSources(manifest);
  const strategies = selectedStrategies(upstreamValue);
  assertSourcePresence(sources, '7zip.tar.xz', strategies.sevenZip === 'bundled', `${label} sevenZip.strategy=${strategies.sevenZip}`);
  assertSourcePresence(sources, 'python.tar.gz', strategies.python === 'bundled', `${label} python.strategy=${strategies.python}`);
  assertSourcePresence(sources, 'electron.zip', strategies.electron === 'bundled', `${label} electronRuntime.strategy=${strategies.electron}`);
  assertSourcePresence(sources, 'electron-headers.tar.gz', strategies.electronHeaders === 'source', `${label} electronRuntime.headersStrategy=${strategies.electronHeaders}`);
  assertSourcePresence(
    sources,
    'node.tar.xz',
    strategies.nodeBuild === 'bundled-managed-node' || strategies.nodeRuntime === 'bundled-managed-node',
    `${label} node.buildStrategy=${strategies.nodeBuild} node.runtimeStrategy=${strategies.nodeRuntime}`,
  );
}
function renderManifestWithUpstream(upstreamValue, outputPath) {
  const upstreamPath = `${outputPath}.upstream.json`;
  fs.writeFileSync(upstreamPath, `${JSON.stringify(upstreamValue, null, 2)}\n`);
  try {
    const result = spawnSync('node', ['packaging/flatpak/render-manifest.mjs', '--output', outputPath], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, CODEX_FLATPAK_RESOLVED_UPSTREAM_JSON: upstreamPath, CODEX_FLATPAK_DEPS_LOCK_JSON: '' },
    });
    if (result.status !== 0) {
      fail(`render-manifest failed for generated strategy check: ${result.stderr}`);
      return null;
    }
    return readJsonFile(outputPath);
  } finally {
    fs.rmSync(upstreamPath, { force: true });
  }
}
function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

const upstream = readJson('packaging/flatpak/upstream.json');
validateRuntimePythonStrategy(upstream, 'packaging/flatpak/upstream.json');
const asarPkg = readJson('packaging/flatpak/asar/package.json');
const cliPkg = readJson('packaging/flatpak/codex-cli/package.json');
const nativePkg = readJson('packaging/flatpak/native-modules/package.json');
const nativePolicy = readJson('packaging/flatpak/native-modules-policy.json');

assertEqual(asarPkg.dependencies.asar, upstream.asarVersion, 'Flatpak asar version');
assertEqual(cliPkg.dependencies['@openai/codex'], upstream.codexCliVersion, 'Flatpak Codex CLI version');
assertEqual(nativePkg.dependencies.electron, upstream.electronVersion, 'Flatpak native module Electron version');
assertEqual(nativePkg.dependencies['@electron/rebuild'], nativePolicy.nativeModuleBuildTools['@electron/rebuild'], 'Flatpak @electron/rebuild policy version');
assertEqual(nativePkg.dependencies['node-abi'], nativePolicy.nativeModuleBuildTools['node-abi'], 'Flatpak node-abi policy version');
for (const packageName of ['@electron/rebuild', 'node-abi']) {
  if (/^[~^]/.test(nativePkg.dependencies[packageName] ?? '')) fail(`Flatpak ${packageName} must use an exact policy version`);
}

for (const relative of [
  'packaging/flatpak/asar/package-lock.json',
  'packaging/flatpak/codex-cli/package-lock.json',
  'packaging/flatpak/native-modules/package-lock.json',
  'packaging/flatpak/tools/package-lock.json',
]) {
  assertFile(relative);
}
for (const relative of [
  'packaging/flatpak/asar-sources.json',
  'packaging/flatpak/codex-cli-sources.json',
  'packaging/flatpak/native-modules-sources.json',
  'packaging/flatpak/tools-sources.json',
  'packaging/flatpak/dugite-native-sources.json',
]) {
  assertNonEmptyArray(relative);
}

const tempManifest = path.join(flatpakDir, '.io.github.ilysenko.codex_desktop_linux.check.json');
try {
  const result = spawnSync('node', ['packaging/flatpak/render-manifest.mjs', '--output', tempManifest], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    fail(`render-manifest failed: ${result.stderr}`);
  } else {
    const expected = fs.readFileSync(tempManifest, 'utf8');
    const actualPath = path.join(flatpakDir, 'io.github.ilysenko.codex_desktop_linux.json');
    const actual = fs.readFileSync(actualPath, 'utf8');
    if (expected !== actual) fail('Checked-in Flatpak manifest is stale; run bash scripts/flatpak/refresh-generated-sources.sh');
    assertManifestSourcesForStrategies(JSON.parse(actual), upstream, 'checked-in manifest');

    const omittedSourcesUpstream = structuredClone(upstream);
    omittedSourcesUpstream.sevenZip = { ...omittedSourcesUpstream.sevenZip, strategy: 'sdk' };
    omittedSourcesUpstream.flatpakToolStrategy = { ...omittedSourcesUpstream.flatpakToolStrategy, runtimePython: { strategy: 'runtime', probe: { ref: `org.electronjs.Electron2.BaseApp//${omittedSourcesUpstream.runtimeVersion}`, tool: 'python3', available: true, source: 'test' } } };
    delete omittedSourcesUpstream.pythonStandalone.strategy;
    omittedSourcesUpstream.electronRuntime = { ...omittedSourcesUpstream.electronRuntime, strategy: 'baseapp', headersStrategy: 'source' };
    omittedSourcesUpstream.node = { buildStrategy: 'sdk', runtimeStrategy: 'runtime-node-contract' };
    omittedSourcesUpstream.flatpakToolStrategy = { ...omittedSourcesUpstream.flatpakToolStrategy, buildNode: { strategy: 'sdk', probe: { ref: `org.freedesktop.Sdk//${omittedSourcesUpstream.runtimeVersion}`, tool: 'node+npm', available: true, source: 'test' } } };
    const omittedSourcesManifest = renderManifestWithUpstream(omittedSourcesUpstream, `${tempManifest}.omitted`);
    if (omittedSourcesManifest) {
      assertManifestSourcesForStrategies(omittedSourcesManifest, omittedSourcesUpstream, 'generated omitted-source manifest');
    }
  }
} finally {
  fs.rmSync(tempManifest, { force: true });
  fs.rmSync(`${tempManifest}.omitted`, { force: true });
}

if (process.exitCode) process.exit(process.exitCode);
console.log('Flatpak dependency pins are consistent');
