import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const header = readFileSync(path.join(root, 'flight-cpp', 'include', 'flight', 'c', 'runtime.h'), 'utf8');
const implementation = readFileSync(path.join(root, 'flight-cpp', 'src', 'c_runtime.cpp'), 'utf8');
const abi = /#define FLIGHT_CPP_ABI_VERSION (?<value>\d+)/u.exec(
  readFileSync(path.join(root, 'flight-cpp', 'include', 'flight', 'version.hpp'), 'utf8'),
)?.groups?.value;
if (!abi) throw new Error('flight/version.hpp does not declare FLIGHT_CPP_ABI_VERSION');
const snapshotPath = path.join(root, 'flight-cpp', 'abi', `c-api-v${abi}.txt`);
const snapshot = readFileSync(snapshotPath, 'utf8').split(/\r?\n/u).filter(Boolean);
const declarations = [
  ...header.matchAll(/^FLIGHT_CPP_C_API\s+(?<signature>(?:const char\*|flight_cpp_status|uint32_t|void)\s+[^;]+);/gmsu),
]
  .map((match) => normalize(match.groups?.signature ?? ''))
  .sort();
const statuses = [...header.matchAll(/(?<status>FLIGHT_CPP_STATUS_[A-Z0-9_]+\s*=\s*\d+)/gu)]
  .map((match) => normalize(match.groups?.status ?? ''))
  .sort();
const typedefs = [...header.matchAll(/^typedef\s+(?<definition>[^;]+);/gmu)]
  .map((match) => normalize(`typedef ${match.groups?.definition ?? ''}`))
  .sort();
const contract = [...declarations, ...statuses, ...typedefs].sort();
const definitions = symbols(
  implementation,
  /^(?:const char\*|flight_cpp_status|uint32_t|void)\s+(flight_cpp_[a-z0-9_]+)(?=\s*\()/gmu,
);
const failures: string[] = [];

if (snapshot.join('\n') !== [...snapshot].sort().join('\n')) {
  failures.push('ABI snapshot is not sorted');
}
if (new Set(snapshot).size !== snapshot.length) failures.push('ABI snapshot contains duplicate symbols');
compare('public C contract', contract, snapshot);
compare('C-linkage definitions', definitions, declarations.map(symbolFromSignature).sort());

if (failures.length > 0) {
  process.stderr.write(`C ABI health failed with ${String(failures.length)} error(s):\n`);
  for (const failure of failures) process.stderr.write(`- ${failure}\n`);
  process.exit(1);
}

process.stdout.write(
  `C ABI v${abi} matches ${String(declarations.length)} functions, ${String(statuses.length)} status values, and ${String(typedefs.length)} fixed typedefs.\n`,
);

function symbols(contents: string, pattern: RegExp): string[] {
  return [...new Set([...contents.matchAll(pattern)].map((match) => match[1] ?? match[0]))].sort();
}

function normalize(value: string): string {
  return value.replaceAll(/\s+/gu, ' ').replaceAll(/\(\s+/gu, '(').trim();
}

function symbolFromSignature(signature: string): string {
  const symbol = /\bflight_cpp_[a-z0-9_]+(?=\s*\()/u.exec(signature)?.[0];
  if (!symbol) throw new Error(`C ABI snapshot has an invalid signature: ${signature}`);
  return symbol;
}

function compare(label: string, actual: readonly string[], expected: readonly string[]): void {
  const missing = expected.filter((symbol) => !actual.includes(symbol));
  const added = actual.filter((symbol) => !expected.includes(symbol));
  if (missing.length > 0) failures.push(`${label} omit ${missing.join(', ')}`);
  if (added.length > 0) failures.push(`${label} add unsnapshotted ${added.join(', ')}`);
}
