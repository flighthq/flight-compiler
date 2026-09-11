import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createCheckGateRegistry } from './checkGateRegistry.js';
import type { CheckGate } from './checkGateRegistry.js';

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
  'typecheck',
]);
const pushGateLabels = new Set([...checkGateLabels].filter((label) => label !== 'typecheck'));

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
add('typecheck', process.execPath, compiledScript('workspaceTypecheck'));
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

const failed: string[] = [];
for (const gate of selectedGates) {
  process.stdout.write(`\n▶ ${gate.label}\n`);
  if (runGate(gate) !== 0) failed.push(gate.label);
}

if (failed.length > 0) {
  process.stderr.write(
    `\n${String(failed.length)} of ${String(selectedGates.length)} ${resultLabel} gates failed: ${failed.join(', ')}\n`,
  );
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

function runGate(gate: Readonly<CheckGate>): number {
  const result = spawnSync(gate.command, [...gate.args], { cwd: root, env: process.env, stdio: 'inherit' });
  if (result.error) {
    process.stderr.write(`${gate.label}: ${result.error.message}\n`);
    return 1;
  }
  // A gate killed by a signal reports a null status; treating that as anything but a failure would
  // let an out-of-memory or interrupted stage pass silently.
  return result.status ?? 1;
}
