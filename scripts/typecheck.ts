import { availableParallelism } from 'node:os';
import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

interface TypecheckTarget {
  config: string;
  label: string;
}

interface TypecheckResult {
  label: string;
  output: string;
  passed: boolean;
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packages = readdirSync(path.join(root, 'packages'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
const targets: TypecheckTarget[] = [
  { config: 'tsconfig.json', label: '@flighthq/tool-compiler' },
  ...packages.map((packageName) => ({
    config: `packages/${packageName}/tsconfig.json`,
    label: `@flighthq/${packageName}`,
  })),
];
const concurrency = Math.max(1, Math.min(availableParallelism(), targets.length, 4));
const results = await runTargets(concurrency);
let failed = false;

for (const result of results) {
  process.stdout.write(`\n▶ typecheck: ${result.label}\n`);
  process.stdout.write(result.output);
  if (!result.passed) failed = true;
}

if (failed) process.exit(1);
process.stdout.write(`\n${String(results.length)} typecheck targets passed.\n`);

async function runTarget(target: Readonly<TypecheckTarget>): Promise<TypecheckResult> {
  return await new Promise((resolve) => {
    const executable = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc');
    const child = spawn(executable, ['-p', target.config, '--noEmit'], {
      cwd: root,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks: string[] = [];
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => chunks.push(chunk.toString()));
    child.on('error', (error) => chunks.push(`${error.message}\n`));
    child.on('close', (code) => {
      resolve({ label: target.label, output: chunks.join(''), passed: code === 0 });
    });
  });
}

async function runTargets(limit: number): Promise<TypecheckResult[]> {
  const results: TypecheckResult[] = [];
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
