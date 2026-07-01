#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const scriptDir = path.resolve(path.dirname(new URL(import.meta.url).pathname));
const repoRoot = path.resolve(scriptDir, '..', '..');
const defaultOutput = path.join(scriptDir, 'io.github.ilysenko.codex_desktop_linux.json');

function usage() {
  console.error('Usage: render-manifest.mjs [--output path]');
  process.exit(1);
}

let outputPath = defaultOutput;
for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  if (arg === '--output') {
    outputPath = process.argv[++i];
    if (!outputPath) usage();
    continue;
  }
  usage();
}

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, relativePath), 'utf8'));
}
function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

const resolvedUpstreamPath = process.env.CODEX_FLATPAK_RESOLVED_UPSTREAM_JSON?.trim()
  ? path.resolve(process.env.CODEX_FLATPAK_RESOLVED_UPSTREAM_JSON)
  : null;
const resolvedRoot = resolvedUpstreamPath ? path.dirname(resolvedUpstreamPath) : null;
function resolvedPath(relativePath) {
  return resolvedRoot ? path.join(resolvedRoot, relativePath) : path.join(repoRoot, 'packaging', 'flatpak', relativePath);
}
function readFlatpakJson(relativePath) {
  return readJsonFile(resolvedPath(relativePath));
}
function lockPath() {
  const explicit = process.env.CODEX_FLATPAK_DEPS_LOCK_JSON?.trim();
  if (explicit) return path.resolve(explicit);
  if (resolvedRoot) {
    const candidate = path.join(resolvedRoot, 'flatpak-deps.lock.json');
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}
function upstreamFromLock(lock) {
  return {
    appId: lock.app?.appId,
    displayName: lock.app?.displayName,
    codexVersion: lock.app?.generatedPackageVersion,
    runtimeVersion: lock.flatpakRefs?.platform?.split('//').pop(),
    codexDmg: lock.upstreamDmg,
    electronVersion: lock.electron?.detectedVersion,
    electronRuntime: {
      strategy: lock.electron?.strategy ?? 'bundled',
      headersStrategy: lock.electron?.headersStrategy ?? 'source',
    },
    electronHeaders: lock.electron?.headersSource,
    electronZip: lock.electron?.runtimeSource ?? lock.electron?.bundledRuntimeSource,
    node: {
      buildStrategy: lock.node?.buildStrategy ?? lock.node?.buildTimeStrategy ?? 'bundled-managed-node',
      runtimeStrategy: lock.node?.runtimeStrategy ?? 'bundled-managed-node',
      sourceIfBundled: lock.node?.sourceIfBundled,
    },
    managedNode: lock.node?.sourceIfBundled,
    pythonStandalone: lock.python?.sourceIfBundled,
    sevenZip: lock.sevenZip?.sourceIfBundled,
    codexCliVersion: lock.codexCli?.npmPackageVersion,
    flatpakToolStrategy: {
      buildPython: lock.python?.buildStrategy,
      runtimePython: lock.python?.runtimeStrategy,
      buildSevenZip: lock.sevenZip?.buildStrategy,
    },
  };
}
const activeLockPath = lockPath();
const depsLock = activeLockPath ? readJsonFile(activeLockPath) : null;
const upstream = depsLock ? upstreamFromLock(depsLock) : (resolvedUpstreamPath ? readJsonFile(resolvedUpstreamPath) : readJson('packaging/flatpak/upstream.json'));
function sourceListFromLock(lock, key, fallbackRelativePath) {
  const value = key.split('.').reduce((cursor, part) => cursor?.[part], lock);
  if (Array.isArray(value)) return value;
  return readFlatpakJson(fallbackRelativePath);
}

const asarSources = sourceListFromLock(depsLock, 'asar.sourceList', 'asar-sources.json');
const cliSources = sourceListFromLock(depsLock, 'codexCli.sourceList', 'codex-cli-sources.json');
const nativeSources = sourceListFromLock(depsLock, 'nativeModules.sourceList', 'native-modules-sources.json');
const toolsSources = sourceListFromLock(depsLock, 'tools.sourceList', 'tools-sources.json');
const gitStrategyFromLock = depsLock?.tools?.gitStrategy;
const ripgrepStrategyFromLock = depsLock?.tools?.ripgrepStrategy;
const dugiteNativeSources = gitStrategyFromLock === 'runtime' ? [] : sourceListFromLock(depsLock, 'tools.dugiteNativeSourceIfBundled', 'dugite-native-sources.json');
const toolStrategy = upstream.flatpakToolStrategy ?? {};
const sevenZipStrategy = upstream.sevenZip?.strategy ?? toolStrategy.buildSevenZip ?? 'bundled';
const runtimePythonStrategy = upstream.python?.runtimeStrategy ?? upstream.python?.strategy ?? upstream.pythonStandalone?.strategy ?? toolStrategy.runtimePython?.strategy ?? toolStrategy.runtimePython ?? 'bundled';
const electronRuntime = upstream.electronRuntime ?? { strategy: 'bundled', headersStrategy: 'source' };
const electronRuntimeStrategy = electronRuntime.strategy ?? 'bundled';
const electronHeadersStrategy = electronRuntime.headersStrategy ?? 'source';
const nodeStrategy = upstream.node ?? {};
const nodeBuildStrategy = nodeStrategy.buildStrategy ?? upstream.flatpakToolStrategy?.buildNode?.strategy ?? 'bundled-managed-node';
const nodeRuntimeStrategy = nodeStrategy.runtimeStrategy ?? 'bundled-managed-node';
const nodeSourceNeeded = nodeBuildStrategy === 'bundled-managed-node' || nodeRuntimeStrategy === 'bundled-managed-node';
const managedNodeSource = nodeStrategy.sourceIfBundled ?? upstream.managedNode;
const gitStrategy = gitStrategyFromLock ?? upstream.flatpakToolStrategy?.git?.strategy ?? 'bundled-dugite-native';
const ripgrepStrategy = ripgrepStrategyFromLock ?? upstream.flatpakToolStrategy?.ripgrep?.strategy ?? 'bundled-vscode-ripgrep';

function localArchivePath() {
  const value = process.env.CODEX_FLATPAK_SOURCE_ARCHIVE_PATH?.trim();
  return value ? path.resolve(value) : null;
}

function isTruthy(value) {
  return value && !['0', 'false', 'False', 'FALSE', 'no', 'No', 'NO', 'off', 'Off', 'OFF'].includes(value);
}

function assertRemotePinnedSource(source) {
  if (!isTruthy(process.env.FLATPAK_FLATHUB_MODE)) return source;
  if (source.type === 'dir' || source.path) {
    throw new Error('FLATPAK_FLATHUB_MODE=1 requires a remote pinned source; local dir/archive paths are not allowed');
  }
  if (source.type === 'git' && (!source.url || !source.commit)) {
    throw new Error('FLATPAK_FLATHUB_MODE=1 git source requires CODEX_FLATPAK_SOURCE_URL and CODEX_FLATPAK_SOURCE_COMMIT');
  }
  if (source.type === 'archive' && (!source.url || !source.sha256)) {
    throw new Error('FLATPAK_FLATHUB_MODE=1 archive source requires CODEX_FLATPAK_SOURCE_URL and CODEX_FLATPAK_SOURCE_SHA256');
  }
  return source;
}

function sourceSpec() {
  const kind = process.env.CODEX_FLATPAK_SOURCE_KIND?.trim() || '';
  const archivePath = localArchivePath();
  const dirPath = process.env.CODEX_FLATPAK_SOURCE_DIR?.trim();
  const sourceUrl = process.env.CODEX_FLATPAK_SOURCE_URL?.trim();
  const sourceSha256 = process.env.CODEX_FLATPAK_SOURCE_SHA256?.trim();
  const sourceCommit = process.env.CODEX_FLATPAK_SOURCE_COMMIT?.trim();

  if (kind && !['git', 'archive', 'dir'].includes(kind)) {
    throw new Error(`Unsupported CODEX_FLATPAK_SOURCE_KIND: ${kind}`);
  }

  if (kind === 'git' || sourceCommit) {
    if (!sourceUrl || !sourceCommit) {
      throw new Error('Git source mode requires CODEX_FLATPAK_SOURCE_URL and CODEX_FLATPAK_SOURCE_COMMIT');
    }
    return assertRemotePinnedSource({ type: 'git', url: sourceUrl, commit: sourceCommit });
  }

  if (kind === 'archive' || archivePath || sourceSha256) {
    if (archivePath) {
      return assertRemotePinnedSource({ type: 'archive', path: archivePath });
    }
    if (!sourceUrl || !sourceSha256) {
      throw new Error('Archive source mode requires either CODEX_FLATPAK_SOURCE_ARCHIVE_PATH or CODEX_FLATPAK_SOURCE_URL + CODEX_FLATPAK_SOURCE_SHA256');
    }
    return assertRemotePinnedSource({ type: 'archive', url: sourceUrl, sha256: sourceSha256 });
  }

  const resolvedDir = path.resolve(dirPath || repoRoot);
  const relativeDir = path.relative(path.dirname(outputPath), resolvedDir) || '.';
  return assertRemotePinnedSource({
    type: 'dir',
    path: relativeDir,
  });
}

function maybeFileSource(source, dest, destFilename, onlyArches) {
  if (!source) return null;
  return fileSource(source, dest, destFilename, onlyArches);
}
function fileSource({ url, sha256 }, dest, destFilename, onlyArches) {
  const source = { type: 'file', url, sha256, dest, 'dest-filename': destFilename };
  if (onlyArches?.length) {
    source['only-arches'] = onlyArches;
  }
  return source;
}

function localFileSource(filePath, dest, destFilename, onlyArches) {
  const resolvedPath = path.resolve(filePath);
  const relativePath = path.relative(path.dirname(outputPath), resolvedPath) || '.';
  const source = { type: 'file', path: relativePath, dest, 'dest-filename': destFilename };
  if (onlyArches?.length) {
    source['only-arches'] = onlyArches;
  }
  return source;
}

function codexDmgSource() {
  const localPath = process.env.CODEX_FLATPAK_LOCAL_DMG_PATH?.trim();
  if (localPath && fs.existsSync(localPath)) {
    return localFileSource(localPath, '.', 'Codex.dmg');
  }
  return fileSource(upstream.codexDmg, '.', 'Codex.dmg');
}


function generatedMetadataSources() {
  if (!resolvedRoot) return [];
  return [
    ['upstream.json', 'packaging/flatpak', 'upstream.json'],
    ['flatpak-deps.lock.json', 'packaging/flatpak', 'flatpak-deps.lock.json'],
    ['asar/package.json', 'packaging/flatpak/asar', 'package.json'],
    ['asar/package-lock.json', 'packaging/flatpak/asar', 'package-lock.json'],
    ['codex-cli/package.json', 'packaging/flatpak/codex-cli', 'package.json'],
    ['codex-cli/package-lock.json', 'packaging/flatpak/codex-cli', 'package-lock.json'],
    ['native-modules/package.json', 'packaging/flatpak/native-modules', 'package.json'],
    ['native-modules/package-lock.json', 'packaging/flatpak/native-modules', 'package-lock.json'],
    ['native-modules-policy.json', 'packaging/flatpak', 'native-modules-policy.json'],
    ['tools/package.json', 'packaging/flatpak/tools', 'package.json'],
    ['tools/package-lock.json', 'packaging/flatpak/tools', 'package-lock.json'],
  ].filter(([relative]) => fs.existsSync(path.join(resolvedRoot, relative)))
    .map(([relative, dest, destFilename]) => localFileSource(path.join(resolvedRoot, relative), dest, destFilename));
}

function mergeSources(...sourceGroups) {
  const merged = [];
  const seen = new Set();
  for (const group of sourceGroups) {
    for (const source of group) {
      const key = JSON.stringify(source);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(source);
    }
  }
  return merged;
}

const manifest = {
  'app-id': upstream.appId,
  runtime: 'org.freedesktop.Platform',
  'runtime-version': upstream.runtimeVersion,
  sdk: 'org.freedesktop.Sdk',
  base: 'org.electronjs.Electron2.BaseApp',
  'base-version': upstream.runtimeVersion,
  command: 'codex-desktop-flatpak',
  'separate-locales': false,
  tags: ['proprietary'],
  'finish-args': [
    '--share=network',
    '--share=ipc',
    '--socket=wayland',
    '--socket=fallback-x11',
    '--socket=pulseaudio',
    '--socket=ssh-auth',
    '--device=dri',
    '--talk-name=org.freedesktop.secrets',
    '--env=ELECTRON_TRASH=gio',
  ],
  modules: [
    {
      name: 'codex-desktop-linux',
      buildsystem: 'simple',
      'build-options': {
        env: {
          XDG_CACHE_HOME: '/run/build/codex-desktop-linux/cache',
          npm_config_loglevel: 'warn',
          CODEX_FLATPAK_FINAL_RUNTIME_PYTHON_STRATEGY: runtimePythonStrategy,
          CODEX_FLATPAK_BUILD_SEVEN_ZIP_STRATEGY: sevenZipStrategy,
          CODEX_FLATPAK_ELECTRON_STRATEGY: electronRuntimeStrategy,
          CODEX_FLATPAK_BUILD_NODE_STRATEGY: nodeBuildStrategy,
          CODEX_FLATPAK_RUNTIME_NODE_STRATEGY: nodeRuntimeStrategy,
          CODEX_FLATPAK_GIT_STRATEGY: gitStrategy,
          CODEX_FLATPAK_RIPGREP_STRATEGY: ripgrepStrategy,
        },
      },
      'build-commands': [
        'bash packaging/flatpak/build-flatpak-app.sh',
      ],
      sources: mergeSources(
        [sourceSpec()],
        generatedMetadataSources(),
        [
          codexDmgSource(),
          electronHeadersStrategy === 'source' ? fileSource(upstream.electronHeaders, '.flatpak-sources', 'electron-headers.tar.gz') : null,
          nodeSourceNeeded ? maybeFileSource(managedNodeSource?.x86_64, '.flatpak-sources', 'node.tar.xz', ['x86_64']) : null,
          nodeSourceNeeded ? maybeFileSource(managedNodeSource?.aarch64, '.flatpak-sources', 'node.tar.xz', ['aarch64']) : null,
          runtimePythonStrategy === 'bundled' ? maybeFileSource(upstream.pythonStandalone?.x86_64, '.flatpak-sources', 'python.tar.gz', ['x86_64']) : null,
          runtimePythonStrategy === 'bundled' ? maybeFileSource(upstream.pythonStandalone?.aarch64, '.flatpak-sources', 'python.tar.gz', ['aarch64']) : null,
          sevenZipStrategy === 'bundled' ? maybeFileSource(upstream.sevenZip?.x86_64, '.flatpak-sources', '7zip.tar.xz', ['x86_64']) : null,
          sevenZipStrategy === 'bundled' ? maybeFileSource(upstream.sevenZip?.aarch64, '.flatpak-sources', '7zip.tar.xz', ['aarch64']) : null,
          electronRuntimeStrategy === 'bundled' ? fileSource(upstream.electronZip.x86_64, '.flatpak-sources', 'electron.zip', ['x86_64']) : null,
          electronRuntimeStrategy === 'bundled' ? fileSource(upstream.electronZip.aarch64, '.flatpak-sources', 'electron.zip', ['aarch64']) : null,
        ].filter(Boolean),
        asarSources,
        cliSources,
        nativeSources,
        (gitStrategy === 'runtime' && ripgrepStrategy === 'runtime') ? [] : toolsSources,
        gitStrategy === 'runtime' ? [] : dugiteNativeSources,
      ),
    },
  ],
};

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`);
