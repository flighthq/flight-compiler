import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import { createCheckGateRegistry } from './checkGateRegistry.js';
import type { CheckGate } from './checkGateRegistry.js';

interface CheckGateRunResult {
  readonly durationMilliseconds: number;
  readonly gate: Readonly<CheckGate>;
  readonly status: number;
}

// The non-fixing quality sweep.
//
// EVERY SELECTED GATE RUNS, whatever the ones before it did. These gates are independent — a
// typecheck error says nothing about whether package boundaries hold or documentation links resolve
// — so stopping at the first failure hides the rest and makes one red gate look like the only
// problem. Failures are collected and reported together, and the process exits nonzero at the end.
//
// A gate whose inputs depend on an earlier step still short-circuits inside its own script:
// `pack:check` builds before it inspects the tarball, so it can never report health for a stale
// `dist/`. Gates do not gate each other; a step guards its own inputs.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binary = (name: string): string =>
  path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? `${name}.cmd` : name);
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const compiledScript = (name: string): readonly string[] => [path.join(root, '.script-build', `${name}.js`)];
const checkGateLabels = new Set([
  'api:check',
  'docs:check',
  'exports:check',
  'format:check',
  'license:check',
  'lint',
  'order:check',
  'packages:check',
  'typecheck:root',
]);
const pushGateLabels = new Set([...checkGateLabels].filter((label) => label !== 'typecheck:root'));

const profile = readProfile(process.argv.slice(2));

const { add, gates } = createCheckGateRegistry();

add('packages:check', process.execPath, compiledScript('packageHealth'));
add('exports:check', process.execPath, compiledScript('exportTestHealth'));
add('docs:check', process.execPath, compiledScript('documentationHealth'));
add('format:check', binary('oxfmt'), ['--check', '.']);
add('lint', binary('oxlint'), ['--max-warnings=0']);
add('order:check', process.execPath, compiledScript('sourceOrderHealth'));
add('license:check', process.execPath, compiledScript('licenseProvenanceHealth'));
add('api:check', process.execPath, [...compiledScript('publicApiReport'), '--check']);
add('cpp:exceptions:check', process.execPath, compiledScript('cppExceptionLedger'));
add('typecheck:root', process.execPath, [...compiledScript('workspaceTypecheck'), '--root']);
add('typecheck:packages', process.execPath, [...compiledScript('workspaceTypecheck'), '--packages']);
add('test:packages', process.execPath, compiledScript('isolatedPackageTest'));
add('test:coverage', binary('vitest'), ['run', '--coverage']);
add('compile:check', process.execPath, compiledScript('emittedSourceCompile'));
add('oracle:check', process.execPath, compiledScript('behavioralOracle'));
add('pack:check', npm, ['run', 'pack:check', '--silent']);

const registeredGateLabels = new Set(gates.map((gate) => gate.label));
const missingProfileGateLabels = [...checkGateLabels].filter((label) => !registeredGateLabels.has(label));
if (missingProfileGateLabels.length > 0) {
  process.stderr.write(`Check profiles reference unregistered gates: ${missingProfileGateLabels.join(', ')}\n`);
  process.exit(1);
}

const selectedGates =
  profile === 'verify'
    ? gates
    : gates.filter((gate) => (profile === 'push' ? pushGateLabels : checkGateLabels).has(gate.label));
const resultLabel = profile === 'verify' ? 'verification' : profile === 'push' ? 'push check' : 'check';

if (profile !== 'verify') {
  process.stdout.write(
    `Static ${profile} profile: ${String(selectedGates.length)} of ${String(gates.length)} gates. Run npm run verify for the complete sweep.\n`,
  );
}

// A sweep with no gates would walk nothing and report the same success a complete run does. That
// green is worse than a red, because it is passed onward in good faith.
if (selectedGates.length === 0) {
  process.stderr.write('Repository check registered no gates; there is nothing to verify.\n');
  process.exit(1);
}

const results: CheckGateRunResult[] = [];
for (const gate of selectedGates) {
  process.stdout.write(`\n▶ ${gate.label}\n`);
  results.push(runGate(gate));
}
const failed = results.filter((result) => result.status !== 0);
const labelWidth = Math.max(...results.map((result) => result.gate.label.length));
process.stdout.write('\nGate timings:\n');
for (const result of results) {
  process.stdout.write(`  ${result.gate.label.padEnd(labelWidth)}  ${formatDuration(result.durationMilliseconds)}\n`);
}

if (failed.length > 0) {
  process.stderr.write(
    `\n${String(failed.length)} of ${String(selectedGates.length)} ${resultLabel} gates failed: ${failed.map((result) => result.gate.label).join(', ')}\n`,
  );
  process.stderr.write('Rerun failed gates:\n');
  for (const result of failed) process.stderr.write(`  npm run ${result.gate.label}\n`);
  process.exit(1);
}

process.stdout.write(`\n${String(selectedGates.length)} ${resultLabel} gates passed.\n`);

function readProfile(args: readonly string[]): 'check' | 'push' | 'verify' {
  if (args.length === 0) return 'check';
  if (args.length === 1 && args[0] === '--push') return 'push';
  if (args.length === 1 && args[0] === '--verify') return 'verify';
  process.stderr.write('Usage: npm run check, npm run check:push, or npm run verify\n');
  process.exit(2);
}

function formatDuration(milliseconds: number): string {
  if (milliseconds < 1_000) return `${String(Math.round(milliseconds))}ms`;
  const seconds = milliseconds / 1_000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  return `${String(Math.floor(seconds / 60))}m ${String(Math.round(seconds % 60))}s`;
}

function runGate(gate: Readonly<CheckGate>): CheckGateRunResult {
  const startedAt = performance.now();
  const result = spawnSync(gate.command, [...gate.args], { cwd: root, env: process.env, stdio: 'inherit' });
  let status = result.status ?? 1;
  if (result.error) {
    process.stderr.write(`${gate.label}: ${result.error.message}\n`);
    status = 1;
  }
  // A gate killed by a signal reports a null status; treating that as anything but a failure would
  // let an out-of-memory or interrupted stage pass silently.
  return { durationMilliseconds: performance.now() - startedAt, gate, status };
}
