import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

interface PackageManifest {
  name: string;
  scripts?: Record<string, string>;
}

// Isolated runs prove workspace boundaries; the later aggregate coverage run proves repository-wide instrumentation.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packagesDirectory = path.join(root, 'packages');
const targets = readdirSync(packagesDirectory, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => {
    const directory = path.join(packagesDirectory, entry.name);
    const manifest = JSON.parse(readFileSync(path.join(directory, 'package.json'), 'utf8')) as PackageManifest;
    return { directory, manifest };
  })
  .filter((target) => target.manifest.scripts?.test !== undefined)
  .sort((left, right) => left.manifest.name.localeCompare(right.manifest.name));

if (targets.length === 0) {
  process.stderr.write('No compiler package tests were selected.\n');
  process.exit(1);
}

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const failures: string[] = [];
for (const target of targets) {
  process.stdout.write(`\n▶ ${target.manifest.name}\n`);
  const result = spawnSync(npm, ['run', 'test', `--workspace=${target.directory}`], {
    cwd: root,
    stdio: 'inherit',
  });
  if (result.status !== 0) failures.push(target.manifest.name);
}

if (failures.length > 0) {
  process.stderr.write(`\n${String(failures.length)} package test target(s) failed: ${failures.join(', ')}\n`);
  process.exit(1);
}

process.stdout.write(`\n${String(targets.length)} package test targets passed.\n`);
