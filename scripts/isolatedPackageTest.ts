import { spawn } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

interface PackageManifest {
  name: string;
  scripts?: Record<string, string>;
}

interface PackageTestResult {
  name: string;
  output: string;
  passed: boolean;
}

interface PackageTestTarget {
  directory: string;
  manifest: PackageManifest;
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
const concurrency = Math.max(1, Math.min(availableParallelism(), targets.length, 4));
process.stdout.write(
  `Running ${String(targets.length)} isolated package test target(s) with ${String(concurrency)} worker(s).\n`,
);
const results = await runTargets(concurrency);
const failures: string[] = [];
for (const result of results) {
  process.stdout.write(`\n▶ ${result.name}\n`);
  process.stdout.write(result.output);
  if (!result.passed) failures.push(result.name);
}

if (failures.length > 0) {
  process.stderr.write(`\n${String(failures.length)} package test target(s) failed: ${failures.join(', ')}\n`);
  process.exit(1);
}

process.stdout.write(`\n${String(targets.length)} package test targets passed.\n`);

async function runTarget(target: Readonly<PackageTestTarget>): Promise<PackageTestResult> {
  return await new Promise((resolve) => {
    const child = spawn(npm, ['run', 'test', `--workspace=${target.directory}`], {
      cwd: root,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks: string[] = [];
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => chunks.push(chunk.toString()));
    child.on('error', (error) => chunks.push(`${error.message}\n`));
    child.on('close', (code) => {
      resolve({ name: target.manifest.name, output: chunks.join(''), passed: code === 0 });
    });
  });
}

async function runTargets(limit: number): Promise<PackageTestResult[]> {
  const results: PackageTestResult[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: limit }, async () => {
      for (;;) {
        const index = next++;
        const target = targets[index];
        if (!target) return;
        results[index] = await runTarget(target);
      }
    }),
  );
  return results;
}
