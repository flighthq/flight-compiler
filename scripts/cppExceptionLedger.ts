import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseReadinessRefusalRule } from './readinessRuleGrouping.js';

interface CppConformanceException {
  readonly fixture: string;
  readonly owner: 'compiler-analysis' | 'compiler-emission' | 'compiler-ir' | 'compiler-lowering' | 'runtime-contract';
  readonly phase: 'emission';
  readonly reason: string;
  readonly rule: string;
}

interface CppConformanceExceptionLedger {
  readonly exceptions: readonly CppConformanceException[];
  readonly profile: 'flight-portable-typescript/1';
  readonly schema: 'flight-cpp-conformance-exceptions/1';
  readonly target: 'cpp';
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const goldenDirectory = path.join(root, 'golden');
const ledgerFile = path.join(root, 'flight-cpp', 'conformance', 'known-exceptions.json');
const ledger = JSON.parse(readFileSync(ledgerFile, 'utf8')) as CppConformanceExceptionLedger;
const failures: string[] = [];

if (ledger.schema !== 'flight-cpp-conformance-exceptions/1') failures.push(`unsupported schema ${ledger.schema}`);
if (ledger.profile !== 'flight-portable-typescript/1') failures.push(`unsupported profile ${ledger.profile}`);
if (ledger.target !== 'cpp') failures.push(`ledger target is ${ledger.target}, expected cpp`);

const expected = new Map<string, CppConformanceException>();
let previous = '';
for (const exception of ledger.exceptions) {
  if (exception.fixture.localeCompare(previous) < 0) failures.push('exceptions must be sorted by fixture');
  previous = exception.fixture;
  if (expected.has(exception.fixture)) failures.push(`duplicate exception ${exception.fixture}`);
  expected.set(exception.fixture, exception);
  if (exception.phase !== 'emission') failures.push(`${exception.fixture} uses unsupported phase ${exception.phase}`);
  if (!exception.reason.trim() || !exception.rule.trim()) failures.push(`${exception.fixture} needs a rule and reason`);
  if (!existsSync(path.join(goldenDirectory, exception.fixture, 'input.ts'))) {
    failures.push(`${exception.fixture} does not name a golden fixture`);
  }
}

const actual = new Map<string, string>();
for (const entry of readdirSync(goldenDirectory, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const errorFile = path.join(goldenDirectory, entry.name, 'cpp.error.txt');
  if (!existsSync(errorFile)) continue;
  actual.set(entry.name, parseReadinessRefusalRule(readFileSync(errorFile, 'utf8').trimEnd()));
}

for (const [fixture, exception] of expected) {
  const rule = actual.get(fixture);
  if (!rule) failures.push(`${fixture} is listed but now emits; remove the stale exception`);
  else if (rule !== exception.rule)
    failures.push(`${fixture} rule drifted: expected "${exception.rule}", received "${rule}"`);
}
for (const fixture of actual.keys()) {
  if (!expected.has(fixture)) failures.push(`${fixture} refuses C++ emission without a declared exception`);
}

if (failures.length > 0) {
  process.stderr.write(`C++ exception ledger failed with ${String(failures.length)} error(s):\n`);
  for (const failure of failures) process.stderr.write(`- ${failure}\n`);
  process.exit(1);
}

const owners = new Map<string, number>();
for (const exception of ledger.exceptions) owners.set(exception.owner, (owners.get(exception.owner) ?? 0) + 1);
process.stdout.write(
  `C++ exception ledger matches ${String(actual.size)} structured refusal(s): ${[...owners]
    .map(([owner, count]) => `${owner} ${String(count)}`)
    .join(', ')}.\n`,
);
