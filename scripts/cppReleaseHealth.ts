import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cmake = readFileSync(path.join(root, 'flight-cpp', 'CMakeLists.txt'), 'utf8');
const versionHeader = readFileSync(path.join(root, 'flight-cpp', 'include', 'flight', 'version.hpp'), 'utf8');
const profile = JSON.parse(
  readFileSync(path.join(root, 'flight-cpp', 'conformance', 'portable-typescript-v1.json'), 'utf8'),
) as {
  profile?: string;
  requiredProof?: readonly string[];
  restrictions?: readonly { id?: string }[];
  runtime?: { contract?: string; cppAbi?: number; cxxStandard?: number; profile?: string };
  schema?: string;
  supportStatus?: string;
  target?: string;
};
const exceptions = JSON.parse(
  readFileSync(path.join(root, 'flight-cpp', 'conformance', 'known-exceptions.json'), 'utf8'),
) as { profile?: string; schema?: string; target?: string };
const failures: string[] = [];

const cmakeVersion = match(cmake, /project\([\s\S]*?VERSION (?<value>\d+\.\d+\.\d+)/u, 'CMake project version');
const headerVersion = match(versionHeader, /version = "(?<value>\d+\.\d+\.\d+)"/u, 'header version');
const macroVersion = ['MAJOR', 'MINOR', 'PATCH']
  .map((part) =>
    match(versionHeader, new RegExp(`#define FLIGHT_CPP_VERSION_${part} (?<value>\\d+)`, 'u'), `${part} version`),
  )
  .join('.');
const abi = Number(match(versionHeader, /#define FLIGHT_CPP_ABI_VERSION (?<value>\d+)/u, 'header ABI'));
const cmakeAbi = Number(match(cmake, /set\(FLIGHT_CPP_ABI_VERSION (?<value>\d+)\)/u, 'CMake ABI'));
const standard = Number(
  match(cmake, /target_compile_features\(flight_cpp INTERFACE cxx_std_(?<value>\d+)\)/u, 'C++ standard'),
);

if (cmakeVersion !== headerVersion) failures.push(`CMake version ${cmakeVersion} differs from header ${headerVersion}`);
if (macroVersion !== headerVersion) failures.push(`version macros ${macroVersion} differ from header ${headerVersion}`);
if (cmakeAbi !== abi) failures.push(`CMake ABI ${String(cmakeAbi)} differs from header ABI ${String(abi)}`);
if (profile.schema !== 'flight-portable-typescript-profile/1' || profile.target !== 'cpp') {
  failures.push('portable profile identity is not the released C++ schema');
}
if (profile.supportStatus !== 'incubating') failures.push(`unexpected support status ${String(profile.supportStatus)}`);
if (profile.profile !== exceptions.profile)
  failures.push('portable profile and exception ledger name different profiles');
if (profile.runtime?.contract !== 'flight-runtime-contract/2')
  failures.push('portable profile has wrong runtime contract');
if (profile.runtime?.cppAbi !== abi)
  failures.push(`portable profile ABI ${String(profile.runtime?.cppAbi)} differs from ${String(abi)}`);
if (profile.runtime?.cxxStandard !== standard) {
  failures.push(
    `portable profile C++${String(profile.runtime?.cxxStandard)} differs from CMake C++${String(standard)}`,
  );
}
if (profile.runtime?.profile !== 'flight-cpp')
  failures.push('portable profile does not elect flight-cpp runtime bindings');
if (exceptions.schema !== 'flight-cpp-conformance-exceptions/1' || exceptions.target !== 'cpp') {
  failures.push('exception ledger identity is not the released C++ schema');
}
if (!cmake.includes('COMPATIBILITY SameMinorVersion')) {
  failures.push('pre-1.0 CMake compatibility must remain within one minor release');
}

const requiredProof = [
  'abi-snapshot',
  'deterministic-emission',
  'gcc-clang-appleclang-msvc',
  'installed-package-consumer',
  'native-compile',
  'performance-smoke',
  'runtime-unit-tests',
  'source-differential-behavior',
];
if ([...(profile.requiredProof ?? [])].sort().join('\n') !== requiredProof.join('\n')) {
  failures.push('portable profile proof requirements drifted from the release gate');
}
const restrictionIds = (profile.restrictions ?? []).map((restriction) => restriction.id ?? '');
if (restrictionIds.some((id) => id.length === 0) || new Set(restrictionIds).size !== restrictionIds.length) {
  failures.push('portable profile restriction identifiers must be present and unique');
}

if (failures.length > 0) {
  process.stderr.write(`C++ release metadata failed with ${String(failures.length)} error(s):\n`);
  for (const failure of failures) process.stderr.write(`- ${failure}\n`);
  process.exit(1);
}

process.stdout.write(
  `C++ release metadata agrees: version ${headerVersion}, ABI ${String(abi)}, C++${String(standard)}, ${profile.profile}.\n`,
);

function match(contents: string, pattern: RegExp, label: string): string {
  const value = pattern.exec(contents)?.groups?.value;
  if (value) return value;
  failures.push(`could not read ${label}`);
  return '<missing>';
}
