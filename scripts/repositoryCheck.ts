import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createCheckGateRegistry } from './checkGateRegistry.js';
import type { CheckGate } from './checkGateRegistry.js';

// The non-fixing quality sweep.
//
// EVERY GATE RUNS, whatever the ones before it did. These gates are independent — a typecheck error
// says nothing about whether package boundaries hold or documentation links resolve — so stopping at
// the first failure hides the rest and makes one red gate look like the only problem. Failures are
// collected and reported together, and the process exits nonzero at the end.
//
// A gate whose inputs depend on an earlier step still short-circuits inside its own script:
// `pack:check` builds before it inspects the tarball, so it can never report health for a stale
// `dist/`. Gates do not gate each other; a step guards its own inputs.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binary = (name: string): string =>
  path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? `${name}.cmd` : name);
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const compiledScript = (name: string): readonly string[] => [path.join(root, '.script-build', `${name}.js`)];

const { add, gates } = createCheckGateRegistry();

add('packages:check', process.execPath, compiledScript('packageHealth'));
add('exports:check', process.execPath, compiledScript('exportTestHealth'));
add('docs:check', process.execPath, compiledScript('documentationHealth'));
add('format:check', binary('oxfmt'), ['--check', '.']);
add('lint', binary('oxlint'), ['--max-warnings=0']);
add('order:check', process.execPath, compiledScript('sourceOrderHealth'));
add('license:check', process.execPath, compiledScript('licenseProvenanceHealth'));
add('api:check', process.execPath, [...compiledScript('publicApiReport'), '--check']);
add('typecheck', process.execPath, compiledScript('workspaceTypecheck'));
add('test:packages', process.execPath, compiledScript('isolatedPackageTest'));
add('test:coverage', binary('vitest'), ['run', '--coverage']);
add('compile:check', process.execPath, compiledScript('emittedSourceCompile'));
add('oracle:check', process.execPath, compiledScript('behavioralOracle'));
add('pack:check', npm, ['run', 'pack:check', '--silent']);

// A sweep with no gates would walk nothing and report the same success a complete run does. That
// green is worse than a red, because it is passed onward in good faith.
if (gates.length === 0) {
  process.stderr.write('Repository check registered no gates; there is nothing to verify.\n');
  process.exit(1);
}

const failed: string[] = [];
for (const gate of gates) {
  process.stdout.write(`\n▶ ${gate.label}\n`);
  if (runGate(gate) !== 0) failed.push(gate.label);
}

if (failed.length > 0) {
  process.stderr.write(
    `\n${String(failed.length)} of ${String(gates.length)} check gates failed: ${failed.join(', ')}\n`,
  );
  process.exit(1);
}

process.stdout.write(`\n${String(gates.length)} check gates passed.\n`);

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
