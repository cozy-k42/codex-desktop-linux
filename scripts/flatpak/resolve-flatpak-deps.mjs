#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..', '..');
const flatpakDir = path.join(repoRoot, 'packaging', 'flatpak');
const pinnedUpstreamPath = path.join(flatpakDir, 'upstream.json');
const nativeModulesPolicyPath = path.join(flatpakDir, 'native-modules-policy.json');
const generatedFlatpakDir = process.env.CODEX_FLATPAK_GENERATED_DIR?.trim()
  ? path.resolve(process.env.CODEX_FLATPAK_GENERATED_DIR)
  : path.join(repoRoot, 'dist', 'flatpak', 'generated');
let flatpakWriteDir = generatedFlatpakDir;
let upstreamPath = path.join(flatpakWriteDir, 'upstream.json');
let resolvedDmgForLock = null;

function usage() {
  console.error(`Usage: resolve-flatpak-deps.mjs [--write-pins] [--check] [--download-dmg|--no-download-dmg] [--download-binaries|--no-download-binaries] [--probe-flatpak|--no-probe-flatpak] [--offline]\n\nResolves Flatpak packaging inputs before flatpak-builder runs. The resolver may use\nnetwork and host/Flatpak tooling outside the flatpak-builder sandbox, then writes\nresolved files. By default it downloads the mutable upstream Codex.dmg and any\nbinary sources whose URLs change so generated Flatpak inputs contain current\npayload checksums; pass --no-download-dmg for a headers-only refresh. By default\noutputs are written under dist/flatpak/generated/;\n--write-pins updates the checked-in packaging/flatpak pins.`);
  process.exit(1);
}

function envFlag(name, defaultValue) {
  const value = process.env[name];
  if (value == null || value === '') return defaultValue;
  return !/^(0|false|no|off)$/iu.test(value);
}

const options = {
  writePins: false,
  check: false,
  downloadDmg: envFlag('FLATPAK_RESOLVE_DOWNLOAD_DMG', true),
  probeFlatpak: process.env.FLATPAK_RESOLVE_PROBE_FLATPAK !== '0',
  downloadBinaries: envFlag('FLATPAK_RESOLVE_DOWNLOAD_BINARIES', true),
  network: process.env.FLATPAK_RESOLVE_NETWORK !== '0',
};
for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  if (arg === '--write-pins') options.writePins = true;
  else if (arg === '--write') options.writePins = true;
  else if (arg === '--check') options.check = true;
  else if (arg === '--download-dmg') options.downloadDmg = true;
  else if (arg === '--no-download-dmg') options.downloadDmg = false;
  else if (arg === '--probe-flatpak') options.probeFlatpak = true;
  else if (arg === '--no-probe-flatpak') options.probeFlatpak = false;
  else if (arg === '--download-binaries') options.downloadBinaries = true;
  else if (arg === '--no-download-binaries') options.downloadBinaries = false;
  else if (arg === '--offline') options.network = false;
  else usage();
}
if (options.check) options.writePins = false;
flatpakWriteDir = (options.writePins || options.check) ? flatpakDir : generatedFlatpakDir;
upstreamPath = path.join(flatpakWriteDir, 'upstream.json');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function policyNativeModuleBuildTools() {
  return readJson(nativeModulesPolicyPath).nativeModuleBuildTools ?? {};
}
function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}
function writeIfChanged(file, text) {
  const oldText = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  if (oldText === text) return false;
  if (options.check) {
    console.error(`Flatpak dependency file is stale: ${path.relative(repoRoot, file)}`);
    return true;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return true;
}

function copyIfExists(from, to) {
  if (!fs.existsSync(from)) return;
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}
function prepareGeneratedInputs() {
  fs.rmSync(generatedFlatpakDir, { recursive: true, force: true });
  for (const relative of [
    'upstream.json',
    'io.github.ilysenko.codex_desktop_linux.json',
    'asar-sources.json',
    'codex-cli-sources.json',
    'native-modules-sources.json',
    'tools-sources.json',
    'dugite-native-sources.json',
    'asar/package.json',
    'asar/package-lock.json',
    'codex-cli/package.json',
    'codex-cli/package-lock.json',
    'native-modules/package.json',
    'native-modules/package-lock.json',
    'native-modules-policy.json',
    'tools/package.json',
    'tools/package-lock.json',
  ]) {
    copyIfExists(path.join(flatpakDir, relative), path.join(generatedFlatpakDir, relative));
  }
}


function sourceList(relativePath) {
  return readJson(path.join(flatpakWriteDir, relativePath));
}
function sourceFile(relativePath) {
  return path.relative(repoRoot, path.join(flatpakWriteDir, relativePath));
}
function dependencyVersion(relativePath, packageName) {
  return readJson(path.join(flatpakWriteDir, relativePath)).dependencies?.[packageName] ?? null;
}
function packageLockSource(relativePath) {
  const file = path.join(flatpakWriteDir, relativePath);
  if (!fs.existsSync(file)) return null;
  const lock = readJson(file);
  return {
    path: sourceFile(relativePath),
    lockfileVersion: lock.lockfileVersion ?? null,
    packages: Object.keys(lock.packages ?? {}).length,
  };
}
function lockSourceRef(relativePath) {
  const file = path.join(flatpakWriteDir, relativePath);
  return {
    path: sourceFile(relativePath),
    sha256: fs.existsSync(file) ? sha256File(file) : null,
  };
}
function buildFlatpakDepsLock(upstream) {
  const toolStrategy = upstream.flatpakToolStrategy ?? {};
  const baseappRef = `org.electronjs.Electron2.BaseApp//${upstream.runtimeVersion}`;
  const baseappProbe = probeFlatpakRef(baseappRef);
  const lock = {
    app: {
      appId: upstream.appId,
      displayName: upstream.displayName,
      generatedPackageVersion: upstream.codexVersion,
    },
    upstreamDmg: {
      url: upstream.codexDmg?.url ?? null,
      sha256: upstream.codexDmg?.sha256 ?? null,
      size: upstream.codexDmg?.size ?? null,
      etag: upstream.codexDmg?.etag ?? null,
      lastModified: upstream.codexDmg?.lastModified ?? null,
      contentLength: upstream.codexDmg?.contentLength ?? null,
      cachePath: resolvedDmgForLock?.cachePath ?? null,
      sourceMode: resolvedDmgForLock?.sourceMode ?? (process.env.CODEX_FLATPAK_LOCAL_DMG_PATH ? 'local' : (options.downloadDmg ? 'downloaded' : 'pinned-or-head')),
    },
    electron: {
      detectedVersion: upstream.electronVersion,
      strategy: upstream.electronRuntime?.strategy ?? 'bundled',
      requestedStrategy: upstream.electronRuntime?.requestedStrategy ?? 'bundled',
      headersStrategy: upstream.electronRuntime?.headersStrategy ?? 'source',
      headersSource: upstream.electronHeaders ?? null,
      runtimeSource: (upstream.electronRuntime?.strategy ?? 'bundled') === 'bundled' ? (upstream.electronZip ?? null) : null,
      bundledRuntimeSource: upstream.electronZip ?? null,
      baseappCompatibilityResult: upstream.electronRuntime?.baseapp ?? {
        ref: baseappRef,
        compatible: baseappProbe,
        source: baseappProbe == null ? 'not-probed' : 'flatpak-info',
      },
      compatible: upstream.electronRuntime?.compatible ?? false,
      compatibility: upstream.electronRuntime?.compatibility ?? 'not-evaluated',
    },
    node: {
      buildStrategy: toolStrategy.buildNode?.strategy ?? upstream.node?.buildStrategy ?? 'bundled-managed-node',
      buildProbe: toolStrategy.buildNode?.probe ?? upstream.node?.buildProbe ?? null,
      runtimeStrategy: upstream.node?.runtimeStrategy ?? 'bundled-managed-node',
      runtimeProbe: upstream.node?.runtimeProbe ?? null,
      sourceIfBundled: (toolStrategy.buildNode?.strategy ?? upstream.node?.buildStrategy ?? 'bundled-managed-node') === 'bundled-managed-node'
        || (upstream.node?.runtimeStrategy ?? 'bundled-managed-node') === 'bundled-managed-node'
        ? upstream.managedNode ?? null
        : null,
    },
    python: {
      buildStrategy: toolStrategy.buildPython?.strategy ?? (toolStrategy.buildPython === 'sdk' ? 'sdk' : 'unavailable'),
      buildProbe: toolStrategy.buildPython?.probe ?? null,
      runtimeStrategy: toolStrategy.runtimePython?.strategy ?? toolStrategy.runtimePython ?? 'bundled',
      runtimeProbe: toolStrategy.runtimePython?.probe ?? null,
      sourceIfBundled: (toolStrategy.runtimePython?.strategy ?? toolStrategy.runtimePython ?? 'bundled') === 'bundled' ? upstream.pythonStandalone ?? null : null,
    },
    sevenZip: {
      buildStrategy: toolStrategy.buildSevenZip ?? 'bundled',
      sourceIfBundled: (toolStrategy.buildSevenZip ?? 'bundled') === 'bundled' ? upstream.sevenZip ?? null : null,
    },
    asar: {
      lockfilePath: sourceFile('asar/package-lock.json'),
      sourceList: sourceList('asar-sources.json'),
    },
    codexCli: {
      npmPackageVersion: upstream.codexCliVersion,
      lockfilePath: sourceFile('codex-cli/package-lock.json'),
      sourceList: sourceList('codex-cli-sources.json'),
    },
    nativeModules: {
      electronAbi: `electron-v${upstream.electronVersion}`,
      betterSqlite3Version: dependencyVersion('native-modules/package.json', 'better-sqlite3'),
      nodePtyVersion: dependencyVersion('native-modules/package.json', 'node-pty'),
      sourceList: sourceList('native-modules-sources.json'),
    },
    tools: {
      gitStrategy: toolStrategy.git?.strategy ?? 'bundled-dugite-native',
      ripgrepStrategy: toolStrategy.ripgrep?.strategy ?? 'bundled-vscode-ripgrep',
      gitProbe: toolStrategy.git?.probe ?? null,
      ripgrepProbe: toolStrategy.ripgrep?.probe ?? null,
      dugiteNativeSourceIfBundled: (toolStrategy.git?.strategy ?? 'bundled-dugite-native') === 'bundled-dugite-native' ? sourceList('dugite-native-sources.json') : [],
      sourceList: sourceList('tools-sources.json'),
    },
    flatpakRefs: {
      platform: `org.freedesktop.Platform//${upstream.runtimeVersion}`,
      sdk: `org.freedesktop.Sdk//${upstream.runtimeVersion}`,
      baseapp: `org.electronjs.Electron2.BaseApp//${upstream.runtimeVersion}`,
    },
    manifestSources: {
      upstream: lockSourceRef('upstream.json'),
      asarSources: lockSourceRef('asar-sources.json'),
      codexCliSources: lockSourceRef('codex-cli-sources.json'),
      nativeModulesSources: lockSourceRef('native-modules-sources.json'),
      toolsSources: lockSourceRef('tools-sources.json'),
      dugiteNativeSources: lockSourceRef('dugite-native-sources.json'),
      packageLocks: [
        packageLockSource('asar/package-lock.json'),
        packageLockSource('codex-cli/package-lock.json'),
        packageLockSource('native-modules/package-lock.json'),
        packageLockSource('tools/package-lock.json'),
      ].filter(Boolean),
    },
  };
  return lock;
}

function run(command, args, runOptions = {}) {
  const result = spawnSync(command, args, {
    cwd: runOptions.cwd ?? repoRoot,
    encoding: 'utf8',
    stdio: runOptions.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    env: { ...process.env, ...(runOptions.env ?? {}) },
  });
  if (result.status !== 0) {
    if (runOptions.optional) return null;
    const stderr = result.stderr ? `\n${result.stderr}` : '';
    throw new Error(`Command failed: ${command} ${args.join(' ')}${stderr}`);
  }
  return result;
}
function sha256File(file) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}
function cacheKey(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}
function generatedAppVersion(value) {
  const v = String(value ?? '').trim().replace(/^[vV]/, '');
  if (!/^[0-9][0-9A-Za-z.+~-]*$/.test(v) || !/[1-9A-Za-z]/.test(v)) return null;
  if (/^0+(?:\.0+)*(?:[-+]0+)?$/.test(v)) return null;
  return v;
}
export function resolveCodexVersion({ appVersion, packageVersion, flatpakAppVersion } = {}) {
  const flatpakOverride = String(flatpakAppVersion ?? '').trim();
  if (flatpakOverride) return flatpakOverride;
  const packageOverride = generatedAppVersion(packageVersion);
  if (packageOverride) return packageOverride;
  const app = generatedAppVersion(appVersion);
  if (app) return app;
  throw new Error('Flatpak app version must be resolved from upstream app metadata or FLATPAK_APP_VERSION/PACKAGE_VERSION.');
}
async function fetchHeaders(url) {
  const response = await fetch(url, { method: 'HEAD' });
  if (!response.ok) throw new Error(`HEAD ${url} returned ${response.status}`);
  return {
    etag: response.headers.get('etag') ?? '',
    lastModified: response.headers.get('last-modified') ?? '',
    contentLength: response.headers.get('content-length') ?? '',
  };
}
async function downloadFile(url, dest) {
  const response = await fetch(url);
  if (!response.ok || !response.body) throw new Error(`GET ${url} returned ${response.status}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.part`;
  const file = fs.createWriteStream(tmp);
  await new Promise((resolve, reject) => {
    response.body.pipeTo(new WritableStream({
      write(chunk) { file.write(Buffer.from(chunk)); },
      close() { file.end(resolve); },
      abort(error) { file.destroy(error); reject(error); },
    })).catch(reject);
  });
  fs.renameSync(tmp, dest);
}


function metadataTextForUrl(url, headers) {
  return [`url_sha256=${cacheKey(url)}`, `etag=${headers.etag ?? ''}`, `last_modified=${headers.lastModified ?? ''}`, `content_length=${headers.contentLength ?? ''}`].join('\n');
}
function parseMetadataText(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const idx = line.indexOf('=');
    if (idx > 0) out[line.slice(0, idx)] = line.slice(idx + 1);
  }
  return out;
}
async function fetchDmgRemoteFingerprint(url) {
  const headers = await fetchHeaders(url);
  if (!headers.etag && !headers.lastModified && !headers.contentLength) throw new Error('HEAD response did not include cache validators');
  return { headers, text: metadataTextForUrl(url, headers) };
}
function cachedMetadataMatchesUrl(metadataPath, url) {
  if (!fs.existsSync(metadataPath) || fs.statSync(metadataPath).size === 0) return false;
  return parseMetadataText(fs.readFileSync(metadataPath, 'utf8')).url_sha256 === cacheKey(url);
}
async function cachedDmgIsFresh(dmgPath, metadataPath, url) {
  try {
    const remote = await fetchDmgRemoteFingerprint(url);
    if (!fs.existsSync(metadataPath) || fs.statSync(metadataPath).size === 0) return { fresh: false, remote, reason: 'missing-metadata' };
    const current = fs.readFileSync(metadataPath, 'utf8').trimEnd();
    return { fresh: current === remote.text, remote, reason: current === remote.text ? 'fresh' : 'metadata-differs' };
  } catch (error) {
    if (cachedMetadataMatchesUrl(metadataPath, url)) return { fresh: true, remote: null, reason: 'head-failed-matching-url' };
    return { fresh: false, remote: null, reason: 'head-failed-url-mismatch' };
  }
}
function writeDmgMetadata(metadataPath, remote) {
  if (!remote?.text) {
    fs.rmSync(metadataPath, { force: true });
    return;
  }
  fs.mkdirSync(path.dirname(metadataPath), { recursive: true });
  fs.writeFileSync(metadataPath, `${remote.text}\n`);
}
async function resolveCachedDmg(url, { download }) {
  const cacheDir = process.env.CODEX_FLATPAK_DEPS_CACHE || path.join(repoRoot, '.flatpak-deps-cache');
  const cachedDmg = path.join(cacheDir, `${cacheKey(url)}.dmg`);
  const metadataPath = `${cachedDmg}.metadata`;
  let remote = null;
  if (fs.existsSync(cachedDmg) && fs.statSync(cachedDmg).size > 0) {
    const freshness = options.network ? await cachedDmgIsFresh(cachedDmg, metadataPath, url) : { fresh: cachedMetadataMatchesUrl(metadataPath, url), remote: null, reason: 'offline' };
    remote = freshness.remote;
    if (freshness.fresh) return { path: cachedDmg, remote, sourceMode: 'cached', freshness: freshness.reason };
    if (!download) return { path: '', remote, sourceMode: 'pinned-or-head', freshness: freshness.reason };
  }
  if (!download) {
    if (options.network) remote = (await fetchDmgRemoteFingerprint(url).catch(() => null));
    return { path: '', remote, sourceMode: 'pinned-or-head', freshness: remote ? 'headers-only' : 'headers-unavailable' };
  }
  if (!remote && options.network) remote = (await fetchDmgRemoteFingerprint(url).catch(() => null));
  await downloadFile(url, cachedDmg);
  writeDmgMetadata(metadataPath, remote);
  return { path: cachedDmg, remote, sourceMode: 'downloaded', freshness: remote ? 'downloaded-with-metadata' : 'downloaded-no-metadata' };
}
function sanitizeElectronVersion(value) {
  const v = String(value ?? '').replace(/^[v^~]/, '');
  return /^[0-9]+(\.[0-9]+){2}([.-][0-9A-Za-z]+)*$/.test(v) ? v : null;
}
function versionMajor(value) {
  const version = sanitizeElectronVersion(value);
  if (!version) return null;
  return Number(version.split('.')[0]);
}
function electronVersionsAbiCompatible(upstreamVersion, baseappVersion) {
  const upstreamMajor = versionMajor(upstreamVersion);
  const baseappMajor = versionMajor(baseappVersion);
  return upstreamMajor != null && baseappMajor != null && upstreamMajor === baseappMajor;
}
function requestedElectronStrategy() {
  const value = (process.env.FLATPAK_ELECTRON_STRATEGY || 'auto').trim().toLowerCase();
  if (!['bundled', 'baseapp', 'auto'].includes(value)) {
    throw new Error(`Unsupported FLATPAK_ELECTRON_STRATEGY=${value}; expected bundled, baseapp, or auto`);
  }
  return value;
}
function findFirstAppDir(root) {
  const stack = [{ dir: root, depth: 0 }];
  while (stack.length) {
    const { dir, depth } = stack.shift();
    if (depth > 3) continue;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.endsWith('.app')) return full;
        stack.push({ dir: full, depth: depth + 1 });
      }
    }
  }
  return null;
}
function readPlistElectronVersion(appDir) {
  const plist = path.join(appDir, 'Contents', 'Frameworks', 'Electron Framework.framework', 'Versions', 'A', 'Resources', 'Info.plist');
  if (!fs.existsSync(plist)) return null;
  const py = run('python3', ['-c', 'import plistlib,sys; print(plistlib.load(open(sys.argv[1],"rb")).get("CFBundleVersion", ""))', plist], { capture: true, optional: true });
  return sanitizeElectronVersion(py?.stdout?.trim());
}
function extractAsarFile(appDir, tmp, asarRelativePath) {
  const asarPath = path.join(appDir, 'Contents', 'Resources', 'app.asar');
  if (!fs.existsSync(asarPath)) return null;
  const out = path.join(tmp, asarRelativePath.replaceAll('/', '__'));
  fs.rmSync(out, { force: true });
  for (const cmd of [['asar', ['extract-file', asarPath, asarRelativePath]], ['npx', ['--yes', 'asar', 'extract-file', asarPath, asarRelativePath]]]) {
    const res = run(cmd[0], cmd[1], { cwd: tmp, capture: true, optional: true });
    if (res?.stdout?.trim()) { fs.writeFileSync(out, res.stdout); return out; }
    const extracted = path.join(tmp, asarRelativePath);
    if (res && fs.existsSync(extracted)) { fs.renameSync(extracted, out); return out; }
  }
  return null;
}
function extractAsarPackageJson(appDir, tmp) {
  return extractAsarFile(appDir, tmp, 'package.json');
}
function readPlistAppVersion(appDir) {
  const plist = path.join(appDir, 'Contents', 'Info.plist');
  if (!fs.existsSync(plist)) return null;
  const py = run('python3', ['-c', 'import plistlib,sys; p=plistlib.load(open(sys.argv[1],"rb")); print(p.get("CFBundleShortVersionString") or p.get("CFBundleVersion") or "")', plist], { capture: true, optional: true });
  return generatedAppVersion(py?.stdout?.trim());
}
function maybeDetectAppVersionFromDmg(localDmg) {
  if (!localDmg || !fs.existsSync(localDmg)) return null;
  if (!run('sh', ['-c', 'command -v 7z >/dev/null 2>&1'], { optional: true, capture: true })) return null;
  const tmp = fs.mkdtempSync(path.join('/tmp', 'codex-flatpak-version-dmg-'));
  try {
    const result = run('7z', ['x', '-y', '-snl', `-o${tmp}`, localDmg], { capture: true, optional: true });
    if (!result) return null;
    const appDir = findFirstAppDir(tmp);
    if (!appDir) return null;
    const asarPackage = extractAsarPackageJson(appDir, tmp);
    const packageVersion = asarPackage ? generatedAppVersion(readJson(asarPackage).version) : null;
    return packageVersion ?? readPlistAppVersion(appDir);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
function readModuleVersionFromExtractedApp(appDir, tmp, moduleName) {
  const candidates = [
    path.join(appDir, 'Contents', 'Resources', 'app', 'node_modules', moduleName, 'package.json'),
    path.join(appDir, 'Contents', 'Resources', 'app.asar.unpacked', 'node_modules', moduleName, 'package.json'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return readJson(candidate).version ?? null;
  }
  const asarPackage = extractAsarFile(appDir, tmp, `node_modules/${moduleName}/package.json`);
  return asarPackage ? (readJson(asarPackage).version ?? null) : null;
}
function versionLt(a, b) {
  const pa = String(a).split(/[.-]/).map((v) => /^\d+$/.test(v) ? Number(v) : v);
  const pb = String(b).split(/[.-]/).map((v) => /^\d+$/.test(v) ? Number(v) : v);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const av = pa[i] ?? 0;
    const bv = pb[i] ?? 0;
    if (typeof av === 'number' && typeof bv === 'number' && av !== bv) return av < bv;
    const cmp = String(av).localeCompare(String(bv), undefined, { numeric: true });
    if (cmp !== 0) return cmp < 0;
  }
  return false;
}
function betterSqlite3BuildVersion(detectedVersion, _electronVersion) {
  return detectedVersion;
}
function maybeDetectNativeModuleVersionsFromDmg(localDmg, electronVersion) {
  if (!localDmg || !fs.existsSync(localDmg)) return null;
  if (!run('sh', ['-c', 'command -v 7z >/dev/null 2>&1'], { optional: true, capture: true })) return null;
  const tmp = fs.mkdtempSync(path.join('/tmp', 'codex-flatpak-native-dmg-'));
  try {
    const result = run('7z', ['x', '-y', '-snl', `-o${tmp}`, localDmg], { capture: true, optional: true });
    const appDir = findFirstAppDir(tmp);
    if (!result && !appDir) return null;
    if (!appDir) return null;
    const betterSqlite3Detected = readModuleVersionFromExtractedApp(appDir, tmp, 'better-sqlite3');
    const nodePtyVersion = readModuleVersionFromExtractedApp(appDir, tmp, 'node-pty');
    if (!betterSqlite3Detected || !nodePtyVersion) return null;
    return {
      betterSqlite3Detected,
      betterSqlite3Version: betterSqlite3BuildVersion(betterSqlite3Detected, electronVersion),
      nodePtyVersion,
    };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}


async function fetchJson(url) {
  if (!options.network) return null;
  const response = await fetch(url, { headers: { 'user-agent': 'codex-desktop-linux-flatpak-deps' } });
  if (!response.ok) throw new Error(`GET ${url} returned ${response.status}`);
  return response.json();
}
async function fetchText(url) {
  if (!options.network) return null;
  const response = await fetch(url, { headers: { 'user-agent': 'codex-desktop-linux-flatpak-deps' } });
  if (!response.ok) throw new Error(`GET ${url} returned ${response.status}`);
  return response.text();
}
function nodeAssetName(version, arch) {
  return `node-v${version}-linux-${arch}.tar.xz`;
}
function unresolvedDynamicSource(label, reason) {
  throw new Error(`${label} must be resolved from upstream metadata during this run; refusing pinned checksum fallback (${reason}).`);
}
async function resolveLatestManagedNode(previous) {
  const forced = process.env.CODEX_FLATPAK_MANAGED_NODE_VERSION?.trim();
  const index = await fetchJson('https://nodejs.org/dist/index.json').catch(() => null);
  if (!index) unresolvedDynamicSource('Node.js managed runtime', options.network ? 'network-unavailable' : 'offline');
  const minimum = [22, 22, 0];
  const versionOk = (version) => {
    const parts = String(version).replace(/^v/, '').split('.').map((v) => Number(v));
    for (let i = 0; i < minimum.length; i += 1) {
      if ((parts[i] ?? 0) > minimum[i]) return true;
      if ((parts[i] ?? 0) < minimum[i]) return false;
    }
    return true;
  };
  const selected = forced
    ? index.find((entry) => entry.version === `v${forced.replace(/^v/, '')}`)
    : index.find((entry) => entry.lts && versionOk(entry.version));
  if (!selected) unresolvedDynamicSource('Node.js managed runtime', forced ? 'forced-version-unavailable' : 'no-compatible-lts');
  const version = selected.version.replace(/^v/, '');
  const shasums = await fetchText(`https://nodejs.org/dist/v${version}/SHASUMS256.txt`).catch(() => null);
  if (!shasums) unresolvedDynamicSource('Node.js managed runtime', 'shasums-unavailable');
  const shaFor = (asset) => shasums.split(/\r?\n/).map((line) => line.trim().split(/\s+/)).find(([, name]) => name === asset)?.[0] ?? '';
  const next = {
    version,
    x86_64: { url: `https://nodejs.org/dist/v${version}/${nodeAssetName(version, 'x64')}`, sha256: shaFor(nodeAssetName(version, 'x64')) },
    aarch64: { url: `https://nodejs.org/dist/v${version}/${nodeAssetName(version, 'arm64')}`, sha256: shaFor(nodeAssetName(version, 'arm64')) },
  };
  if (!next.x86_64.sha256 || !next.aarch64.sha256) unresolvedDynamicSource('Node.js managed runtime', 'missing-arch-shasum');
  return { value: next, changed: JSON.stringify(next) !== JSON.stringify(previous), source: forced ? 'env-nodejs-index' : 'nodejs-index-latest-lts' };
}
function githubAssetUrl(release, pattern) {
  return release?.assets?.find((asset) => pattern.test(asset.name))?.browser_download_url ?? null;
}

async function resolveLatestSevenZip(previous) {
  const release = await fetchJson('https://api.github.com/repos/ip7z/7zip/releases/latest').catch(() => null);
  const version = release?.tag_name?.replace(/^v/i, '') ?? '';
  const x64 = githubAssetUrl(release, /linux-x64\.tar\.xz$/u);
  const arm64 = githubAssetUrl(release, /linux-arm64\.tar\.xz$/u);
  if (!version) unresolvedDynamicSource('7-Zip', options.network ? 'network-unavailable' : 'offline');
  if (!x64 || !arm64) unresolvedDynamicSource('7-Zip', 'missing-assets');
  const next = { version, x86_64: { url: x64, sha256: '' }, aarch64: { url: arm64, sha256: '' } };
  return { value: next, changed: JSON.stringify({ ...next, x86_64: { url: x64 }, aarch64: { url: arm64 } }) !== JSON.stringify({ version: previous?.version, x86_64: { url: previous?.x86_64?.url }, aarch64: { url: previous?.aarch64?.url } }), source: 'github-latest-release-api' };
}
async function resolveLatestPythonStandalone(previous) {
  const x64Pattern = /cpython-3\.10\.[^/]+x86_64-unknown-linux-gnu-install_only_stripped\.tar\.gz$/u;
  const arm64Pattern = /cpython-3\.10\.[^/]+aarch64-unknown-linux-gnu-install_only_stripped\.tar\.gz$/u;
  const releases = await fetchJson('https://api.github.com/repos/astral-sh/python-build-standalone/releases?per_page=20').catch(() => null);
  if (Array.isArray(releases)) {
    for (const release of releases) {
      const x64 = githubAssetUrl(release, x64Pattern);
      const arm64 = githubAssetUrl(release, arm64Pattern);
      if (!x64 || !arm64) continue;
      const decoded = decodeURIComponent(new URL(x64).pathname.split('/').pop() ?? '');
      const version = decoded.replace(/^cpython-/u, '').replace(/-x86_64-unknown-linux-gnu-install_only_stripped\.tar\.gz$/u, '');
      const next = { version, x86_64: { url: x64, sha256: '' }, aarch64: { url: arm64, sha256: '' } };
      return { value: next, changed: JSON.stringify({ ...next, x86_64: { url: x64 }, aarch64: { url: arm64 } }) !== JSON.stringify({ version: previous?.version, x86_64: { url: previous?.x86_64?.url }, aarch64: { url: previous?.aarch64?.url } }), source: 'github-latest-cpython-3.10-release-api' };
    }
  }
  unresolvedDynamicSource('Python standalone', options.network ? 'no-compatible-assets-or-network-unavailable' : 'offline');
}
async function refreshBinaryFallbacks(upstream, previousUpstream, needs) {
  const skipped = (source) => ({ value: null, changed: false, source });
  const node = needs.node ? await resolveLatestManagedNode(upstream.managedNode) : skipped('not-needed-runtime-or-sdk');
  if (needs.node) {
    upstream.managedNode = node.value;
    await refreshPinnedFileSource(upstream.managedNode?.x86_64, 'Node.js x86_64 runtime', previousUpstream.managedNode?.x86_64?.url);
    await refreshPinnedFileSource(upstream.managedNode?.aarch64, 'Node.js aarch64 runtime', previousUpstream.managedNode?.aarch64?.url);
  }

  const python = needs.python ? await resolveLatestPythonStandalone(upstream.pythonStandalone) : skipped('not-needed-runtime');
  if (needs.python) {
    upstream.pythonStandalone = python.value;
    await refreshPinnedFileSource(upstream.pythonStandalone?.x86_64, 'Python standalone x86_64 runtime', previousUpstream.pythonStandalone?.x86_64?.url);
    await refreshPinnedFileSource(upstream.pythonStandalone?.aarch64, 'Python standalone aarch64 runtime', previousUpstream.pythonStandalone?.aarch64?.url);
  }

  const sevenZip = needs.sevenZip ? await resolveLatestSevenZip(upstream.sevenZip) : skipped('not-needed-sdk');
  if (needs.sevenZip) {
    upstream.sevenZip = sevenZip.value;
    await refreshPinnedFileSource(upstream.sevenZip?.x86_64, '7-Zip x86_64 build tool', previousUpstream.sevenZip?.x86_64?.url);
    await refreshPinnedFileSource(upstream.sevenZip?.aarch64, '7-Zip aarch64 build tool', previousUpstream.sevenZip?.aarch64?.url);
  }
  return { node, python, sevenZip };
}
async function refreshPinnedFileSource(source, label, previousUrl) {
  if (!source?.url) return;
  if (!options.downloadBinaries) {
    if (source.sha256 && previousUrl !== source.url) return;
    throw new Error(`${label} checksum must be produced by this resolver run; refusing to reuse pinned checksum. Enable binary downloads or provide upstream metadata with sha256.`);
  }
  const cacheDir = process.env.CODEX_FLATPAK_DEPS_CACHE || path.join(repoRoot, '.flatpak-deps-cache');
  const extension = path.extname(new URL(source.url).pathname) || '.bin';
  const cached = path.join(cacheDir, `${cacheKey(source.url)}${extension}`);
  if (!fs.existsSync(cached)) await downloadFile(source.url, cached);
  source.sha256 = sha256File(cached);
}

function npmLatest(packageName) {
  const overrideName = packageName.replace(/[^A-Za-z0-9]/g, '_').toUpperCase();
  const override = process.env[`CODEX_FLATPAK_${overrideName}_VERSION`];
  if (override) return override;
  const result = run('npm', ['view', `${packageName}@latest`, 'version', '--json'], { capture: true, optional: true });
  if (!result) return null;
  return JSON.parse(result.stdout.trim());
}
function probeFlatpakRef(ref) {
  if (!options.probeFlatpak) return null;
  const result = run('flatpak', ['info', ref], { capture: true, optional: true });
  return Boolean(result);
}
function detectBaseappElectronVersion(upstream) {
  const configured = sanitizeElectronVersion(process.env.FLATPAK_BASEAPP_ELECTRON_VERSION);
  if (configured) return { version: configured, source: 'env' };
  if (!options.probeFlatpak) return { version: null, source: 'not-probed' };
  const ref = `org.electronjs.Electron2.BaseApp//${upstream.runtimeVersion}`;
  for (const command of ['electron', '/app/bin/electron']) {
    const result = run('flatpak', ['run', '--command=sh', ref, '-c', `${command} --version 2>/dev/null | head -n 1`], {
      capture: true,
      optional: true,
    });
    const version = sanitizeElectronVersion(result?.stdout?.trim());
    if (version) return { version, source: `flatpak-run:${command}` };
  }
  return { version: null, source: 'unavailable' };
}
function resolveElectronRuntime(upstream) {
  const requested = requestedElectronStrategy();
  const baseappRef = `org.electronjs.Electron2.BaseApp//${upstream.runtimeVersion}`;
  const installed = probeFlatpakRef(baseappRef);
  const detected = detectBaseappElectronVersion(upstream);
  const compatible = electronVersionsAbiCompatible(upstream.electronVersion, detected.version);
  const allowMismatch = process.env.FLATPAK_ELECTRON_ALLOW_ABI_MISMATCH === '1';
  const strategy = requested === 'bundled' ? 'bundled' : ((compatible || (requested === 'baseapp' && allowMismatch)) ? 'baseapp' : 'bundled');
  return {
    strategy,
    requestedStrategy: requested,
    upstreamVersion: upstream.electronVersion,
    baseapp: { ref: baseappRef, installed, electronVersion: detected.version, versionSource: detected.source },
    compatible,
    compatibility: compatible ? 'matching-electron-major' : 'not-compatible-or-unknown',
    headersStrategy: 'source',
  };
}

function probeFlatpakRuntimeCommand(ref, name, script) {
  if (!options.probeFlatpak) return { ref, tool: name, available: null, compatible: null, source: 'not-probed' };
  const result = run('flatpak', ['run', '--command=sh', ref, '-c', script], {
    capture: true,
    optional: true,
    env: { GIT_CONFIG_NOSYSTEM: '1' },
  });
  return {
    ref,
    tool: name,
    available: Boolean(result),
    compatible: Boolean(result),
    source: 'flatpak-run',
    stdout: result?.stdout?.trim() || null,
    stderr: result?.stderr?.trim() || null,
  };
}
function resolveRuntimeToolStrategies(upstream) {
  const ref = `org.electronjs.Electron2.BaseApp//${upstream.runtimeVersion}`;
  const gitProbe = probeFlatpakRuntimeCommand(ref, 'git', [
    'set -eu',
    'command -v git >/dev/null 2>&1',
    'git --version >/dev/null',
    'tmp=$(mktemp -d)',
    'trap "rm -rf \"$tmp\"" EXIT',
    'cd "$tmp"',
    'git init >/dev/null',
    'git status --short >/dev/null',
  ].join('\n'));
  const rgProbe = probeFlatpakRuntimeCommand(ref, 'rg', [
    'set -eu',
    'command -v rg >/dev/null 2>&1',
    'rg --version >/dev/null',
    'tmp=$(mktemp -d)',
    'trap "rm -rf \"$tmp\"" EXIT',
    'printf %s needle > "$tmp/file.txt"',
    'rg needle "$tmp" >/dev/null',
  ].join('\n'));
  return {
    git: { strategy: gitProbe.compatible === true ? 'runtime' : 'bundled-dugite-native', probe: gitProbe },
    ripgrep: { strategy: rgProbe.compatible === true ? 'runtime' : 'bundled-vscode-ripgrep', probe: rgProbe },
  };
}
function dugiteNativeSource(url, sha256, arch) {
  return { type: 'file', url, sha256, dest: '.flatpak-sources', 'dest-filename': 'dugite-native.tar.gz', 'only-arches': [arch] };
}
async function refreshDugiteNativeSourcesIfBundled(strategy) {
  if (strategy !== 'bundled-dugite-native') return false;
  const file = path.join(flatpakWriteDir, 'dugite-native-sources.json');
  let sources = fs.existsSync(file) ? readJson(file) : [];
  const version = process.env.CODEX_FLATPAK_DUGITE_NATIVE_VERSION?.trim();
  const revision = process.env.CODEX_FLATPAK_DUGITE_NATIVE_REVISION?.trim();
  const tag = process.env.CODEX_FLATPAK_DUGITE_NATIVE_TAG?.trim() || (version ? `v${version}` : '');
  const commit = process.env.CODEX_FLATPAK_DUGITE_NATIVE_COMMIT?.trim();
  if (version && revision && commit) {
    const base = `https://github.com/desktop/dugite-native/releases/download/${tag}/dugite-native-v${version}-${commit}-ubuntu`;
    sources = [dugiteNativeSource(`${base}-x64.tar.gz`, '', 'x86_64'), dugiteNativeSource(`${base}-arm64.tar.gz`, '', 'aarch64')];
  } else {
    const release = await fetchJson('https://api.github.com/repos/desktop/dugite-native/releases/latest').catch(() => null);
    let x64 = githubAssetUrl(release, /ubuntu-x64\.tar\.gz$/u);
    let arm64 = githubAssetUrl(release, /ubuntu-arm64\.tar\.gz$/u);
    if (!x64 || !arm64) unresolvedDynamicSource('dugite-native', options.network ? 'missing-assets-or-network-unavailable' : 'offline');
    sources = [dugiteNativeSource(x64, '', 'x86_64'), dugiteNativeSource(arm64, '', 'aarch64')];
  }
  const previous = fs.existsSync(path.join(flatpakDir, 'dugite-native-sources.json')) ? readJson(path.join(flatpakDir, 'dugite-native-sources.json')) : [];
  for (const source of sources) {
    const prev = previous.find((candidate) => candidate['only-arches']?.[0] === source['only-arches']?.[0]);
    await refreshPinnedFileSource(source, `dugite-native ${source['only-arches']?.[0] ?? ''}`.trim(), prev?.url);
  }
  return writeIfChanged(file, stableJson(sources));
}

function probeFlatpakToolRef(ref, tool) {
  if (!options.probeFlatpak) return { ref, tool, available: null, source: 'not-probed' };
  const result = run('flatpak', ['run', '--command=sh', ref, '-c', `test -x /usr/bin/${tool} || command -v ${tool} >/dev/null 2>&1`], {
    capture: true,
    optional: true,
  });
  return { ref, tool, available: Boolean(result), source: 'flatpak-run' };
}
function probeFlatpakNodeRef(ref) {
  if (!options.probeFlatpak) return { ref, tool: 'node+npm', available: null, source: 'not-probed' };
  const result = run('flatpak', ['run', '--command=sh', ref, '-c', 'command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1'], {
    capture: true,
    optional: true,
  });
  return { ref, tool: 'node+npm', available: Boolean(result), source: 'flatpak-run' };
}
function probeFlatpakRuntimeNodeRef(ref) {
  if (!options.probeFlatpak) return { ref, tool: 'node', available: null, source: 'not-probed' };
  const result = run('flatpak', ['run', '--command=sh', ref, '-c', 'test -x /usr/bin/node || command -v node >/dev/null 2>&1'], {
    capture: true,
    optional: true,
  });
  return { ref, tool: 'node', available: Boolean(result), source: 'flatpak-run' };
}
function resolveNodeStrategies(upstream) {
  const sdkRef = `org.freedesktop.Sdk//${upstream.runtimeVersion}`;
  const extensionRefs = [
    `org.freedesktop.Sdk.Extension.node22//${upstream.runtimeVersion}`,
    `org.freedesktop.Sdk.Extension.node20//${upstream.runtimeVersion}`,
    `org.freedesktop.Sdk.Extension.node18//${upstream.runtimeVersion}`,
  ];
  const probes = [probeFlatpakNodeRef(sdkRef), ...extensionRefs.map((ref) => probeFlatpakNodeRef(ref))];
  const availableProbe = probes.find((probe) => probe.available === true) ?? probes[0];
  const runtimeProbe = probeFlatpakRuntimeNodeRef(`org.electronjs.Electron2.BaseApp//${upstream.runtimeVersion}`);
  return {
    buildNode: {
      strategy: availableProbe?.available === true ? 'sdk' : 'bundled-managed-node',
      probe: availableProbe ? { ...availableProbe, candidates: probes } : null,
    },
    runtimeNode: {
      strategy: runtimeProbe.available === true ? 'runtime-node-contract' : 'bundled-managed-node',
      probe: runtimeProbe,
    },
  };
}
function resolvePythonStrategies(upstream) {
  const buildProbe = probeFlatpakToolRef(`org.freedesktop.Sdk//${upstream.runtimeVersion}`, 'python3');
  const runtimeProbe = probeFlatpakToolRef(`org.electronjs.Electron2.BaseApp//${upstream.runtimeVersion}`, 'python3');
  const runtimeAvailable = runtimeProbe.available === true;
  return {
    buildPython: {
      strategy: buildProbe.available === true ? 'sdk' : 'unavailable',
      probe: buildProbe,
    },
    runtimePython: {
      strategy: runtimeAvailable ? 'runtime' : 'bundled',
      probe: runtimeProbe,
    },
  };
}
function probeFlatpakTool(upstream, tool) {
  return probeFlatpakToolRef(`org.freedesktop.Sdk//${upstream.runtimeVersion}`, tool).available === true;
}
function maybeDetectElectronFromDmg(localDmg) {
  if (!localDmg || !fs.existsSync(localDmg)) return null;
  if (!run('sh', ['-c', 'command -v 7z >/dev/null 2>&1'], { optional: true, capture: true })) return null;
  const tmp = fs.mkdtempSync(path.join('/tmp', 'codex-flatpak-dmg-'));
  try {
    const result = run('7z', ['x', '-y', '-snl', `-o${tmp}`, localDmg], { capture: true, optional: true });
    const appDir = findFirstAppDir(tmp);
    if (!result && !appDir) return null;
    if (!appDir) return null;
    const fromPlist = readPlistElectronVersion(appDir);
    if (fromPlist) return fromPlist;
    const packageJson = extractAsarPackageJson(appDir, tmp);
    if (packageJson) {
      const pkg = readJson(packageJson);
      return sanitizeElectronVersion(pkg.devDependencies?.electron ?? pkg.dependencies?.electron);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return null;
}
async function resolve() {
  if (!options.writePins && !options.check) prepareGeneratedInputs();
  const upstream = readJson(upstreamPath);
  upstream.electronZip ??= { x86_64: {}, aarch64: {} };
  upstream.electronZip.x86_64 ??= {};
  upstream.electronZip.aarch64 ??= {};
  upstream.electronHeaders ??= {};
  const report = [];

  const dmgUrl = process.env.CODEX_UPSTREAM_DMG_URL || upstream.codexDmg.url;
  upstream.codexDmg.url = dmgUrl;
  const explicitLocalDmg = process.env.CODEX_FLATPAK_LOCAL_DMG_PATH || '';
  let resolvedDmg = { path: '', remote: null, sourceMode: 'pinned-or-head', freshness: 'not-resolved' };
  if (explicitLocalDmg) {
    resolvedDmg = { path: explicitLocalDmg, remote: null, sourceMode: 'local', freshness: 'explicit-local' };
  } else {
    resolvedDmg = await resolveCachedDmg(dmgUrl, { download: options.downloadDmg });
  }

  const headers = resolvedDmg.remote?.headers ?? null;
  if (headers) {
    upstream.codexDmg.etag = headers.etag || null;
    upstream.codexDmg.lastModified = headers.lastModified || null;
    upstream.codexDmg.contentLength = headers.contentLength ? Number(headers.contentLength) : null;
    if (headers.contentLength) upstream.codexDmg.size = Number(headers.contentLength);
  }
  resolvedDmgForLock = {
    cachePath: resolvedDmg.path ? path.relative(repoRoot, resolvedDmg.path) : null,
    sourceMode: resolvedDmg.sourceMode,
  };

  if (resolvedDmg.path && fs.existsSync(resolvedDmg.path)) {
    const stat = fs.statSync(resolvedDmg.path);
    const sha = sha256File(resolvedDmg.path);
    upstream.codexDmg.sha256 = sha;
    upstream.codexDmg.size = stat.size;
    const detectedAppVersion = maybeDetectAppVersionFromDmg(resolvedDmg.path);
    upstream.codexVersion = resolveCodexVersion({
      appVersion: detectedAppVersion,
      packageVersion: process.env.PACKAGE_VERSION,
      flatpakAppVersion: process.env.FLATPAK_APP_VERSION,
    });
    report.push(`resolved Codex version ${upstream.codexVersion} from upstream app metadata`);
    const detectedElectron = maybeDetectElectronFromDmg(resolvedDmg.path);
    if (detectedElectron) {
      upstream.electronVersion = detectedElectron;
      report.push(`detected Electron ${detectedElectron} from DMG`);
    }
    report.push(`${resolvedDmg.sourceMode === 'local' ? 'using local' : resolvedDmg.sourceMode} DMG ${path.relative(repoRoot, resolvedDmg.path)} (${resolvedDmg.freshness})`);
  } else {
    upstream.codexVersion = resolveCodexVersion({
      appVersion: null,
      packageVersion: process.env.PACKAGE_VERSION,
      flatpakAppVersion: process.env.FLATPAK_APP_VERSION,
    });
  }

  if (!resolvedDmg.path || !fs.existsSync(resolvedDmg.path)) {
    if (headers) {
      report.push('checked upstream DMG headers; no DMG downloaded');
    } else if (!options.network) {
      report.push('offline mode; no DMG metadata was resolved');
    } else {
      report.push('could not check upstream DMG headers; no DMG metadata was resolved');
    }
  }

  if (!upstream.electronVersion) {
    throw new Error('Electron version must be detected from the upstream DMG during dependency resolution; refusing hardcoded Flatpak Electron version fallback.');
  }

  const previousUpstream = readJson(pinnedUpstreamPath);
  previousUpstream.electronZip ??= { x86_64: {}, aarch64: {} };
  previousUpstream.electronZip.x86_64 ??= {};
  previousUpstream.electronZip.aarch64 ??= {};
  previousUpstream.electronHeaders ??= {};
  upstream.electronZip.x86_64.url = `https://github.com/electron/electron/releases/download/v${upstream.electronVersion}/electron-v${upstream.electronVersion}-linux-x64.zip`;
  upstream.electronZip.aarch64.url = `https://github.com/electron/electron/releases/download/v${upstream.electronVersion}/electron-v${upstream.electronVersion}-linux-arm64.zip`;
  upstream.electronHeaders.url = `https://artifacts.electronjs.org/headers/dist/v${upstream.electronVersion}/node-v${upstream.electronVersion}-headers.tar.gz`;
  await refreshPinnedFileSource(upstream.electronHeaders, 'Electron headers', previousUpstream.electronHeaders?.url);

  upstream.electronRuntime = resolveElectronRuntime(upstream);
  report.push(`Electron runtime strategy=${upstream.electronRuntime.strategy} requested=${upstream.electronRuntime.requestedStrategy} upstream=${upstream.electronVersion} baseapp=${upstream.electronRuntime.baseapp.electronVersion ?? 'unknown'} (${upstream.electronRuntime.compatibility})`);
  if (upstream.electronRuntime.strategy === 'bundled') {
    await refreshPinnedFileSource(upstream.electronZip.x86_64, 'Electron x86_64 runtime', previousUpstream.electronZip?.x86_64?.url);
    await refreshPinnedFileSource(upstream.electronZip.aarch64, 'Electron aarch64 runtime', previousUpstream.electronZip?.aarch64?.url);
  }

  const asarLatest = process.env.FLATPAK_RESOLVE_NPM_LATEST === '0' ? null : npmLatest('asar');
  if (asarLatest) upstream.asarVersion = asarLatest;
  if (!upstream.asarVersion) {
    throw new Error('asar version must be resolved from npm metadata during dependency resolution; refusing hardcoded Flatpak asar version fallback.');
  }
  const cliLatest = process.env.FLATPAK_RESOLVE_NPM_LATEST === '0' ? null : npmLatest('@openai/codex');
  if (cliLatest) upstream.codexCliVersion = cliLatest;
  if (!upstream.codexCliVersion) {
    throw new Error('Codex CLI version must be resolved from npm metadata during dependency resolution; refusing hardcoded Flatpak CLI version fallback.');
  }

  upstream.flatpakToolStrategy = {
    ...resolvePythonStrategies(upstream),
    ...resolveNodeStrategies(upstream),
    buildSevenZip: probeFlatpakTool(upstream, '7z') ? 'sdk' : 'bundled',
    ...resolveRuntimeToolStrategies(upstream),
  };
  upstream.node = {
    buildStrategy: upstream.flatpakToolStrategy.buildNode.strategy,
    buildProbe: upstream.flatpakToolStrategy.buildNode.probe,
    runtimeStrategy: upstream.flatpakToolStrategy.runtimeNode?.strategy ?? upstream.node?.runtimeStrategy ?? 'bundled-managed-node',
    runtimeProbe: upstream.flatpakToolStrategy.runtimeNode?.probe ?? upstream.node?.runtimeProbe ?? null,
  };
  report.push(`Node build strategy=${upstream.node.buildStrategy} runtime strategy=${upstream.node.runtimeStrategy}`);
  const runtimePythonStrategy = upstream.flatpakToolStrategy.runtimePython?.strategy ?? upstream.flatpakToolStrategy.runtimePython ?? 'bundled';
  const fallbackResolution = await refreshBinaryFallbacks(upstream, previousUpstream, {
    node: upstream.node.buildStrategy === 'bundled-managed-node' || upstream.node.runtimeStrategy === 'bundled-managed-node',
    python: runtimePythonStrategy === 'bundled',
    sevenZip: (upstream.flatpakToolStrategy.buildSevenZip ?? 'bundled') === 'bundled',
  });
  report.push(`managed Node fallback ${upstream.managedNode?.version ?? 'not needed'} source=${fallbackResolution.node.source}`);
  report.push(`Python fallback ${upstream.pythonStandalone?.version ?? 'not needed'} source=${fallbackResolution.python.source}`);
  report.push(`7-Zip fallback ${upstream.sevenZip?.version ?? 'not needed'} source=${fallbackResolution.sevenZip.source}`);
  report.push(`Git strategy=${upstream.flatpakToolStrategy.git.strategy} ripgrep strategy=${upstream.flatpakToolStrategy.ripgrep.strategy}`);

  if ((upstream.flatpakToolStrategy.runtimePython?.strategy ?? upstream.flatpakToolStrategy.runtimePython) === 'sdk' && upstream.flatpakToolStrategy.runtimePython?.probe?.available !== true) {
    throw new Error('Invalid Flatpak Python strategy: runtimePython="sdk" is not allowed unless the final runtime Python probe passed');
  }

  const detectedNativeModules = maybeDetectNativeModuleVersionsFromDmg(resolvedDmg.path, upstream.electronVersion);
  if (!detectedNativeModules) {
    throw new Error('Native module versions must be detected from the upstream DMG; refusing npm latest fallback for better-sqlite3/node-pty.');
  }
  const nativeBuildTools = { ...policyNativeModuleBuildTools() };
  nativeBuildTools['@electron/rebuild'] ??= npmLatest('@electron/rebuild');
  nativeBuildTools['node-abi'] ??= npmLatest('node-abi');
  if (!nativeBuildTools['@electron/rebuild'] || !nativeBuildTools['node-abi']) {
    throw new Error('Native module build tool versions must be resolved from npm metadata during dependency resolution.');
  }
  const betterSqlite3Version = detectedNativeModules.betterSqlite3Version;
  const nodePtyVersion = detectedNativeModules.nodePtyVersion;
  report.push(`detected native modules better-sqlite3@${detectedNativeModules.betterSqlite3Detected}, node-pty@${nodePtyVersion} from DMG`);
  if (betterSqlite3Version !== detectedNativeModules.betterSqlite3Detected) {
    report.push(`using better-sqlite3@${betterSqlite3Version} for Electron v${upstream.electronVersion} compatibility`);
  }

  const toolDeps = {};
  if (upstream.flatpakToolStrategy.ripgrep.strategy === 'bundled-vscode-ripgrep') toolDeps['@vscode/ripgrep'] = npmLatest('@vscode/ripgrep');
  if (upstream.flatpakToolStrategy.git.strategy === 'bundled-dugite-native') toolDeps.dugite = npmLatest('dugite');
  for (const [name, version] of Object.entries(toolDeps)) {
    if (!version) throw new Error(`${name} version must be resolved from npm metadata during dependency resolution.`);
  }
  const dugiteNativeChanged = await refreshDugiteNativeSourcesIfBundled(upstream.flatpakToolStrategy.git.strategy);

  const packageUpdates = [
    ['asar/package.json', { asar: upstream.asarVersion }],
    ['codex-cli/package.json', { '@openai/codex': upstream.codexCliVersion }],
    ['native-modules/package.json', {
      '@electron/rebuild': nativeBuildTools['@electron/rebuild'],
      'better-sqlite3': betterSqlite3Version,
      electron: upstream.electronVersion,
      'node-abi': nativeBuildTools['node-abi'],
      'node-pty': nodePtyVersion,
    }],
    ['tools/package.json', toolDeps],
  ];
  let packageChanged = false;
  for (const [relative, deps] of packageUpdates) {
    const file = path.join(flatpakWriteDir, relative);
    const pkg = readJson(file);
    pkg.dependencies = deps;
    packageChanged = writeIfChanged(file, stableJson(pkg)) || packageChanged;
  }

  const upstreamChanged = writeIfChanged(upstreamPath, stableJson(upstream));
  if (!options.check) {
    const lockPath = path.join(flatpakWriteDir, 'flatpak-deps.lock.json');
    const manifestPath = path.join(flatpakWriteDir, 'io.github.ilysenko.codex_desktop_linux.json');
    if (packageChanged || upstreamChanged || dugiteNativeChanged || !fs.existsSync(manifestPath)) {
      run('bash', ['scripts/flatpak/refresh-generated-sources.sh'], {
        cwd: repoRoot,
        env: { CODEX_FLATPAK_WRITE_ROOT: flatpakWriteDir, CODEX_FLATPAK_SKIP_CHECK: '1' },
      });
    }
    writeIfChanged(lockPath, stableJson(buildFlatpakDepsLock(upstream)));
    run('node', ['packaging/flatpak/render-manifest.mjs', '--output', manifestPath], {
      cwd: repoRoot,
      env: { CODEX_FLATPAK_RESOLVED_UPSTREAM_JSON: upstreamPath },
    });
    if (options.writePins) {
      run('node', ['scripts/flatpak/check-flatpak-deps.mjs'], { cwd: repoRoot });
    }
    console.error(`[flatpak-deps] wrote resolved metadata to ${path.relative(repoRoot, flatpakWriteDir)}`);
  }

  for (const line of report) console.error(`[flatpak-deps] ${line}`);

  if (options.check && (upstreamChanged || packageChanged)) process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  resolve().catch((error) => {
    console.error(error.stack || String(error));
    process.exit(1);
  });
}
