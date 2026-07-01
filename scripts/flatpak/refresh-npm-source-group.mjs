#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));

function usage() {
  console.error('Usage: refresh-npm-source-group.mjs --package-json <path> --lock-output <path> --sources-output <path> [--allow-os=linux]');
  process.exit(1);
}

const options = { allowOs: [] };
for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  if (arg === '--package-json') options.packageJson = process.argv[++i];
  else if (arg === '--lock-output') options.lockOutput = process.argv[++i];
  else if (arg === '--sources-output') options.sourcesOutput = process.argv[++i];
  else if (arg.startsWith('--allow-os=')) options.allowOs.push(arg);
  else usage();
}
if (!options.packageJson || !options.lockOutput || !options.sourcesOutput) usage();

const packageJsonPath = path.resolve(options.packageJson);
const lockOutputPath = path.resolve(options.lockOutput);
const sourcesOutputPath = path.resolve(options.sourcesOutput);
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-flatpak-npm-'));

try {
  fs.copyFileSync(packageJsonPath, path.join(tempDir, 'package.json'));
  const npm = spawnSync('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--fund=false'], {
    cwd: tempDir,
    stdio: 'inherit',
  });
  if (npm.status !== 0) process.exit(npm.status ?? 1);

  fs.mkdirSync(path.dirname(lockOutputPath), { recursive: true });
  fs.copyFileSync(path.join(tempDir, 'package-lock.json'), lockOutputPath);

  const generator = spawnSync('node', [
    path.join(scriptDir, 'generate-npm-cache-sources.mjs'),
    lockOutputPath,
    sourcesOutputPath,
    ...options.allowOs,
  ], { stdio: 'inherit' });
  if (generator.status !== 0) process.exit(generator.status ?? 1);
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
