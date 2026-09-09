import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

import {
  createCppExecutableArguments,
  findCppCompilerToolchain,
  getCppExecutableName,
  type CppCompilerToolchain,
} from './cppToolchain.js';
import { resolveDependency } from './dependencyLock.js';

// Does the emitted source do what the source language does?
//
// `compile:check` proves the output is a program. This proves it is the same program: each fixture's
// own TypeScript is run under Node and its answers become the expected values, then the emitted C++,
// Haxe, and Rust are built and run and compared against them. The source language is the oracle because it
// is the behavioral source of truth; a target that disagrees with it is wrong however well it
// compiles.
//
// The Haxe lane runs on the JavaScript target, so JavaScript-shaped semantics are inherited there
// rather than proven: what this gate establishes for Haxe is that the lowering is right, not that
// every Haxe backend renders a value the same way. Proving that needs hxcpp and a C++ toolchain.
//
// Arguments are scalars, arrays of scalars, tasks, and target-selected Date instants. A record argument
// would have to be rendered as each target spells a record — including its type name in C++ and Rust —
// which is worth doing when a fixture needs it and is not done yet; such a fixture takes compile
// coverage only.
//
// A fixture opts in with `oracle.json`. Values are compared as canonical text rather than by each
// language's own formatting, because `1` and `1.0` and `1.000000` are the same answer — and because
// three languages printing the same double three ways is a difference in the harness, not in the
// compiler. Every side rounds to six decimals and trims, so the comparison is of values.
// A case may name target adapters when another adapter cannot construct its parameter representation;
// that is a harness limitation, not a waiver for a behavioral divergence in a target that runs it.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const goldenDirectory = path.join(root, 'golden');
const supportDirectory = path.join(goldenDirectory, 'support');

type OracleValueKind = 'boolean' | 'number' | 'numbers' | 'string' | 'strings';
type OracleTarget = 'cpp' | 'haxe' | 'rust';

interface OracleCase {
  readonly arguments: readonly unknown[];
  readonly awaits?: boolean;
  readonly call: string;
  readonly construct?: string;
  readonly constructArgs?: readonly unknown[];
  readonly cppCall?: string;
  readonly cppTypes?: readonly (string | null)[];
  readonly returns: OracleValueKind;
  readonly rustRef?: readonly number[];
  readonly targets?: readonly OracleTarget[];
}

// A settled task argument. Async is the machinery with the most moving parts and the least chance of
// being right by inspection, so the oracle has to be able to hand a function something to await.
function isTaskArgument(value: unknown): value is { task: unknown } {
  return typeof value === 'object' && value !== null && 'task' in value;
}

// A task that settles the other way. A handler and a cleanup are only reached by a rejection, so
// without one the whole `catch`/`finally` lowering is untested however many cases succeed.
function isRejectedTaskArgument(value: unknown): value is { rejects: unknown } {
  return typeof value === 'object' && value !== null && 'rejects' in value;
}

function isDateArgument(value: unknown): value is { date: number } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'date' in value &&
    typeof (value as Readonly<{ date?: unknown }>).date === 'number'
  );
}

function isRecordArgument(value: unknown): value is Readonly<Record<string, unknown>> & { $type: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    '$type' in value &&
    !('$stringEnum' in value)
  );
}

function isStringEnumArgument(value: unknown): value is { $stringEnum: string; variant: string; value: string } {
  return (
    typeof value === 'object' && value !== null && '$stringEnum' in value && 'variant' in value && 'value' in value
  );
}

interface OracleDivergence {
  readonly actual: string;
  readonly expected: string;
  readonly fixture: string;
  readonly subject: string;
  readonly target: string;
}

const cppKeywords = new Set([
  'alignas',
  'alignof',
  'and',
  'and_eq',
  'asm',
  'auto',
  'bitand',
  'bitor',
  'bool',
  'break',
  'case',
  'catch',
  'char',
  'char8_t',
  'char16_t',
  'char32_t',
  'class',
  'co_await',
  'co_return',
  'co_yield',
  'compl',
  'concept',
  'const',
  'const_cast',
  'consteval',
  'constexpr',
  'constinit',
  'continue',
  'decltype',
  'default',
  'delete',
  'do',
  'double',
  'dynamic_cast',
  'else',
  'enum',
  'explicit',
  'export',
  'extern',
  'false',
  'float',
  'for',
  'friend',
  'goto',
  'if',
  'inline',
  'int',
  'long',
  'mutable',
  'namespace',
  'new',
  'noexcept',
  'not',
  'not_eq',
  'nullptr',
  'operator',
  'or',
  'or_eq',
  'private',
  'protected',
  'public',
  'register',
  'reinterpret_cast',
  'requires',
  'return',
  'short',
  'signed',
  'sizeof',
  'static',
  'static_assert',
  'static_cast',
  'struct',
  'switch',
  'template',
  'this',
  'thread_local',
  'throw',
  'true',
  'try',
  'typedef',
  'typeid',
  'typename',
  'union',
  'unsigned',
  'using',
  'virtual',
  'void',
  'volatile',
  'wchar_t',
  'while',
  'xor',
  'xor_eq',
]);

const fixtures = readdirSync(goldenDirectory, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(path.join(goldenDirectory, entry.name, 'oracle.json')))
  .map((entry) => entry.name)
  .sort();

const haxeAvailable = hasCommand('haxe');
const rustAvailable = hasCommand('rustc') && hasCommand('cc');
// The runtime lives in its own repository now, so the C++ lane needs a rehydrated checkout as well
// as a toolchain. An absent checkout is reported and skipped, exactly like an absent compiler.
const cppRuntimeInclude = path.join(resolveDependency(root, 'flight-cpp').directory, 'include');
const cppRuntimeAvailable = existsSync(cppRuntimeInclude);
const cppToolchain = cppRuntimeAvailable ? findCppCompilerToolchain() : undefined;
const divergences: OracleDivergence[] = [];
const workspace = mkdtempSync(path.join(tmpdir(), 'flight-oracle-'));
let compared = 0;
let cppExcluded = 0;

try {
  for (const fixture of fixtures) {
    const cases = JSON.parse(
      readFileSync(path.join(goldenDirectory, fixture, 'oracle.json'), 'utf8'),
    ) as readonly OracleCase[];
    const expected = runTypeScriptOracle(fixture, cases);
    const haxeCases = selectOracleCases(cases, expected, 'haxe');
    if (haxeAvailable && haxeCases.cases.length > 0 && existsSync(path.join(goldenDirectory, fixture, 'haxe'))) {
      compare(fixture, 'haxe', haxeCases.expected, runHaxeOracle(fixture, haxeCases.cases));
    }
    const rustCases = selectOracleCases(cases, expected, 'rust');
    if (rustAvailable && rustCases.cases.length > 0 && existsSync(path.join(goldenDirectory, fixture, 'rust'))) {
      compare(fixture, 'rust', rustCases.expected, runRustOracle(fixture, rustCases.cases));
    }
    const cppCases = selectOracleCases(cases, expected, 'cpp');
    if (cppToolchain && cppCases.cases.length > 0 && existsSync(path.join(goldenDirectory, fixture, 'cpp'))) {
      compare(fixture, 'cpp', cppCases.expected, runCppOracle(fixture, cppCases.cases, cppToolchain));
    } else if (cppToolchain && cppCases.cases.length > 0) {
      cppExcluded += 1;
    }
  }
} finally {
  rmSync(workspace, { force: true, recursive: true });
}

if (divergences.length > 0) {
  for (const divergence of divergences) {
    process.stderr.write(
      `\n${divergence.fixture} ${divergence.target} ${divergence.subject}\n  source: ${divergence.expected}\n  target: ${divergence.actual}\n`,
    );
  }
  process.stderr.write(`\n${String(divergences.length)} behavioral divergence(s) from the source language.\n`);
  process.exit(1);
}

const skipped = [
  ...(haxeAvailable ? [] : ['haxe']),
  ...(rustAvailable ? [] : ['rust']),
  ...(cppToolchain ? [] : [cppRuntimeAvailable ? 'cpp' : 'cpp (flight-cpp not rehydrated)']),
];
process.stdout.write(
  `Emitted source agrees with the source language: ${String(compared)} answers across ${String(fixtures.length)} fixtures${
    skipped.length > 0 ? ` (${skipped.join(', ')} not installed, skipped)` : ''
  }${cppExcluded > 0 ? ` (${String(cppExcluded)} C++ fixture(s) excluded by structured emission refusal)` : ''}.\n`,
);

function compare(fixture: string, target: string, expected: readonly string[], actual: readonly string[]): void {
  for (const [index, value] of expected.entries()) {
    compared += 1;
    const observed = actual[index] ?? '<missing>';
    if (observed !== value) {
      divergences.push({ actual: observed, expected: value, fixture, subject: `answer ${String(index + 1)}`, target });
    }
  }
}

function selectOracleCases(
  cases: readonly OracleCase[],
  expected: readonly string[],
  target: OracleTarget,
): Readonly<{ cases: readonly OracleCase[]; expected: readonly string[] }> {
  const selectedCases: OracleCase[] = [];
  const selectedExpected: string[] = [];
  cases.forEach((oracleCase, index) => {
    if (oracleCase.targets && !oracleCase.targets.includes(target)) return;
    selectedCases.push(oracleCase);
    selectedExpected.push(expected[index]!);
  });
  return { cases: selectedCases, expected: selectedExpected };
}

function runTypeScriptOracle(fixture: string, cases: readonly OracleCase[]): readonly string[] {
  const directory = path.join(workspace, fixture, 'source');
  mkdirSync(directory, { recursive: true });
  const source = readFileSync(path.join(goldenDirectory, fixture, 'input.ts'), 'utf8');
  writeFileSync(
    path.join(directory, 'fixture.mjs'),
    ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } })
      .outputText,
  );
  writeFileSync(
    path.join(directory, 'oracle.mjs'),
    [
      "import * as fixture from './fixture.mjs';",
      'const say = (value) =>',
      "  typeof value === 'number'",
      '    ? Object.is(value, -0)',
      "      ? '-0'",
      '      : Number.isInteger(value)',
      '      ? String(value)',
      "      : value.toFixed(6).replace(/0+$/u, '').replace(/\\.$/u, '')",
      '    : Array.isArray(value) || ArrayBuffer.isView(value)',
      "      ? `[${Array.from(value).map(say).join(', ')}]`",
      '      : String(value);',
      ...cases.map((oracleCase) => {
        const methodArgs = oracleCase.arguments.map(renderTypeScriptValue).join(', ');
        const call = oracleCase.construct
          ? `new fixture.${oracleCase.construct}(${(oracleCase.constructArgs ?? []).map(renderTypeScriptValue).join(', ')}).${oracleCase.call}(${methodArgs})`
          : `fixture.${oracleCase.call}(${methodArgs})`;
        return `console.log(say(${oracleCase.awaits ? `await ${call}` : call}));`;
      }),
    ].join('\n'),
  );
  return runLines('node', ['oracle.mjs'], directory, `${fixture} source`);
}

function runHaxeOracle(fixture: string, cases: readonly OracleCase[]): readonly string[] {
  const directory = path.join(workspace, fixture, 'haxe');
  cpSync(path.join(goldenDirectory, fixture, 'haxe'), directory, { recursive: true });
  cpSync(path.join(supportDirectory, 'haxe'), directory, { recursive: true });
  writeFileSync(
    path.join(directory, 'OracleMain.hx'),
    [
      'class OracleMain {',
      '  static function say(value:Dynamic):String {',
      '    if (Std.isOfType(value, Array)) {',
      '      var parts = [];',
      '      for (item in (value : Array<Dynamic>)) parts.push(say(item));',
      '      return "[" + parts.join(", ") + "]";',
      '    }',
      '    if (Std.isOfType(value, Float) || Std.isOfType(value, Int)) {',
      '      var number:Float = value;',
      '      if (number == 0 && 1 / number == Math.NEGATIVE_INFINITY) return "-0";',
      '      if (number == Math.ffloor(number)) return Std.string(Std.int(number));',
      '      return Std.string(Math.round(number * 1000000) / 1000000);',
      '    }',
      '    return Std.string(value);',
      '  }',
      '  static function main() {',
      '    var step:flighthq._internal._Promise<Dynamic> = flighthq._internal._Promise.resolve(null);',
      ...cases.map((oracleCase) =>
        ((): string => {
          const methodArgs = oracleCase.arguments.map(renderHaxeValue).join(', ');
          const call = oracleCase.construct
            ? `(new ${haxeModuleType(fixture)}.${oracleCase.construct}(${(oracleCase.constructArgs ?? []).map(renderHaxeValue).join(', ')})).${oracleCase.call}(${methodArgs})`
            : `${haxeModuleType(fixture)}.${oracleCase.call}(${methodArgs})`;
          // Chained rather than fired together, so the answers arrive in the order they were asked.
          return oracleCase.awaits
            ? `    step = step.then((_) -> ${call}.then((value) -> js.Lib.global.console.log(say(value))));`
            : `    step = step.then((_) -> js.Lib.global.console.log(say(${call})));`;
        })(),
      ),
      '  }',
      '}',
    ].join('\n'),
  );
  const built = spawnSync('haxe', ['-cp', '.', '--js', 'oracle.js', '-main', 'OracleMain'], {
    cwd: directory,
    encoding: 'utf8',
  });
  if (built.status !== 0) throw new Error(`${fixture} haxe oracle build failed:\n${built.stderr ?? ''}`);
  return runLines('node', ['oracle.js'], directory, `${fixture} haxe`);
}

function runRustOracle(fixture: string, cases: readonly OracleCase[]): readonly string[] {
  const directory = path.join(workspace, fixture, 'rust');
  cpSync(path.join(goldenDirectory, fixture, 'rust'), directory, { recursive: true });
  cpSync(path.join(supportDirectory, 'rust'), directory, { recursive: true });
  const modules = readdirSync(directory)
    .filter((entry) => entry.endsWith('.rs') && entry !== 'flight_runtime.rs' && entry !== 'helper.rs')
    .map((entry) => entry.slice(0, -'.rs'.length));
  const runtime = path.join(directory, 'libflight_runtime.rlib');
  const builtRuntime = spawnSync(
    'rustc',
    ['--edition', '2021', '--crate-name', 'flight_runtime', '--crate-type=lib', '-o', runtime, 'flight_runtime.rs'],
    { cwd: directory, encoding: 'utf8' },
  );
  if (builtRuntime.status !== 0) throw new Error(`${fixture} rust runtime build failed:\n${builtRuntime.stderr ?? ''}`);
  writeFileSync(
    path.join(directory, 'main.rs'),
    [
      ...['helper', ...modules].map((module) => `mod ${module};`),
      'fn say_number(value: f64) -> String {',
      '    if value == 0.0 && value.is_sign_negative() {',
      '        "-0".to_owned()',
      '    } else if value == value.trunc() {',
      '        format!("{}", value as i64)',
      '    } else {',
      '        let rendered = format!("{:.6}", value);',
      "        rendered.trim_end_matches('0').trim_end_matches('.').to_owned()",
      '    }',
      '}',
      'fn main() {',
      ...cases.flatMap((oracleCase, caseIndex) => {
        const refPositions = new Set(oracleCase.rustRef ?? []);
        const rustModule = modules[0] ?? 'fixture';
        const bindings: string[] = [];
        const args = oracleCase.arguments.map((arg, argIndex) => {
          if (refPositions.has(argIndex)) {
            const name = `__ref_${String(caseIndex)}_${String(argIndex)}`;
            bindings.push(`    let mut ${name} = ${renderRustValue(arg, rustModule)};`);
            return `&mut ${name}`;
          }
          return renderRustValue(arg, rustModule);
        });
        const rustName = oracleCase.rustCall ?? toSnakeCase(oracleCase.call);
        const invocation = oracleCase.construct
          ? `${rustModule}::${oracleCase.construct}::new(${(oracleCase.constructArgs ?? []).map((arg) => renderRustValue(arg, rustModule)).join(', ')}).${rustName}(${args.join(', ')})`
          : `${rustModule}::${rustName}(${args.join(', ')})`;

        const call = oracleCase.awaits ? `flight_runtime::block_on(${invocation})` : invocation;
        let printLine: string;
        switch (oracleCase.returns) {
          case 'number':
            printLine = `    println!("{}", say_number(${call}));`;
            break;
          case 'numbers':
            printLine = `    println!("[{}]", ${call}.into_iter().map(say_number).collect::<Vec<_>>().join(", "));`;
            break;
          case 'strings':
            printLine = `    println!("[{}]", ${call}.join(", "));`;
            break;
          default:
            printLine = `    println!("{}", ${call});`;
        }
        return [...bindings, printLine];
      }),
      '}',
    ].join('\n'),
  );
  const built = spawnSync(
    'rustc',
    ['--edition', '2021', '--extern', `flight_runtime=${runtime}`, '-o', 'oracle', 'main.rs'],
    { cwd: directory, encoding: 'utf8' },
  );
  if (built.status !== 0) throw new Error(`${fixture} rust oracle build failed:\n${built.stderr ?? ''}`);
  return runLines(path.join(directory, 'oracle'), [], directory, `${fixture} rust`);
}

function runCppOracle(
  fixture: string,
  cases: readonly OracleCase[],
  toolchain: Readonly<CppCompilerToolchain>,
): readonly string[] {
  const directory = path.join(workspace, fixture, 'cpp');
  cpSync(path.join(goldenDirectory, fixture, 'cpp'), directory, { recursive: true });
  cpSync(path.join(supportDirectory, 'cpp'), directory, { recursive: true });
  const headers = readdirSync(directory)
    .filter((entry) => entry.endsWith('.hpp') && entry !== 'helper.hpp')
    .sort();
  if (headers.length === 0) throw new Error(`${fixture} has no emitted C++ header`);
  const arrayHints = collectCppArrayHints(cases);
  writeFileSync(
    path.join(directory, 'main.cpp'),
    [
      ...headers.map((header) => `#include ${JSON.stringify(header)}`),
      '#include <flight/runtime.hpp>',
      '#include <cmath>',
      '#include <iomanip>',
      '#include <iostream>',
      '#include <sstream>',
      '#include <string>',
      '',
      'std::string say(double value) {',
      '  if (std::isnan(value)) return "NaN";',
      '  if (std::isinf(value)) return value < 0.0 ? "-Infinity" : "Infinity";',
      '  if (value == 0.0 && std::signbit(value)) return "-0";',
      '  if (value == 0.0 || value == std::trunc(value)) return flight::String::from_number(value).to_utf8();',
      '  std::ostringstream output;',
      '  output << std::fixed << std::setprecision(6) << value;',
      '  auto rendered = output.str();',
      "  while (rendered.ends_with('0')) rendered.pop_back();",
      "  if (rendered.ends_with('.')) rendered.pop_back();",
      '  return rendered;',
      '}',
      'std::string say(bool value) { return value ? "true" : "false"; }',
      'std::string say(const flight::String& value) { return value.to_utf8(); }',
      'template <typename Value>',
      'std::string say(const flight::Array<Value>& values) {',
      '  std::string rendered = "[";',
      '  bool first = true;',
      '  for (const auto& value : values) {',
      '    if (!first) rendered += ", ";',
      '    rendered += say(value);',
      '    first = false;',
      '  }',
      '  return rendered + "]";',
      '}',
      'template <typename Value>',
      'std::string say(const flight::TypedArray<Value>& values) {',
      '  std::string rendered = "[";',
      '  bool first = true;',
      '  for (const auto& value : values) {',
      '    if (!first) rendered += ", ";',
      '    rendered += say(static_cast<double>(value));',
      '    first = false;',
      '  }',
      '  return rendered + "]";',
      '}',
      '',
      'int main() {',
      ...cases.map((oracleCase) => {
        const arguments_ = oracleCase.arguments.map((argument, index) =>
          renderCppValue(
            argument,
            oracleCase.cppTypes?.[index] ?? arrayHints.get(`${oracleCase.call}:${String(index)}`),
          ),
        );
        const cppName = oracleCase.cppCall ?? toSnakeCase(oracleCase.call);
        const invocation = oracleCase.construct
          ? `flighthq_golden::${oracleCase.construct}(${(oracleCase.constructArgs ?? []).map((arg) => renderCppValue(arg)).join(', ')}).${cppName}(${arguments_.join(', ')})`
          : `flighthq_golden::${cppName}(${arguments_.join(', ')})`;

        const value = oracleCase.awaits ? `${invocation}.get()` : invocation;
        return `  std::cout << say(${value}) << '\\n';`;
      }),
      '}',
    ].join('\n'),
  );
  const executable = getCppExecutableName(toolchain, 'oracle');
  const built = spawnSync(
    toolchain.command,
    createCppExecutableArguments(toolchain, 'main.cpp', executable, [cppRuntimeInclude, directory]),
    { cwd: directory, encoding: 'utf8' },
  );
  if (built.status !== 0) {
    throw new Error(
      `${fixture} C++ oracle build failed with ${toolchain.command} (${toolchain.family}):\n${built.stdout ?? ''}${built.stderr ?? ''}`,
    );
  }
  return runLines(path.join(directory, executable), [], directory, `${fixture} C++`);
}

function collectCppArrayHints(cases: readonly OracleCase[]): ReadonlyMap<string, string> {
  const hints = new Map<string, string>();
  for (const oracleCase of cases) {
    oracleCase.arguments.forEach((argument, index) => {
      if (!Array.isArray(argument) || argument.length === 0) return;
      const type = inferCppValueType(argument);
      if (type) hints.set(`${oracleCase.call}:${String(index)}`, type);
    });
  }
  return hints;
}

function inferCppValueType(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    const element = value.map(inferCppValueType).find((candidate) => candidate !== undefined);
    return element ? `flight::Array<${element}>` : undefined;
  }
  if (typeof value === 'boolean') return 'bool';
  if (isDateArgument(value)) return 'flight::Date';
  if (typeof value === 'number') return 'double';
  if (typeof value === 'string') return 'flight::String';
  if (isTaskArgument(value)) return inferCppValueType(value.task);
  if (isRejectedTaskArgument(value)) return inferCppValueType(value.rejects);
  return undefined;
}

function renderCppValue(value: unknown, hint?: string | null): string {
  if (isDateArgument(value)) return `flight::Date(${renderCppValue(value.date)})`;
  if (isStringEnumArgument(value)) {
    return `flighthq_golden::${value.$stringEnum}::${value.variant}`;
  }
  if (isRecordArgument(value)) {
    const fields = Object.entries(value)
      .filter(([key]) => key !== '$type')
      .map(([key, fieldValue]) => `.${toCppName(key)} = ${renderCppValue(fieldValue)}`);
    return `flighthq_golden::${value.$type}{${fields.join(', ')}}`;
  }
  if (isTaskArgument(value)) {
    const type = unwrapCppTaskType(hint) ?? inferCppValueType(value.task);
    if (!type) throw new Error('C++ oracle task argument needs a scalar settled type');
    return `flight::Task<${type}>::ready(${renderCppValue(value.task)})`;
  }
  if (isRejectedTaskArgument(value)) {
    const type = unwrapCppTaskType(hint) ?? inferCppValueType(value.rejects);
    if (!type) throw new Error('C++ oracle rejection argument needs a scalar rejection type');
    return `flight::Task<${type}>::reject(${renderCppValue(value.rejects)})`;
  }
  if (Array.isArray(value)) {
    const arrayType = inferCppValueType(value) ?? hint;
    if (!arrayType?.startsWith('flight::Array<')) {
      throw new Error('C++ oracle empty array needs a same-call nonempty type example');
    }
    const elementType = arrayType.slice('flight::Array<'.length, -1);
    return `${arrayType}{${value.map((item) => renderCppValue(item, elementType)).join(', ')}}`;
  }
  if (typeof value === 'string') return `flight::String(${JSON.stringify(value)})`;
  if (typeof value === 'number') return Number.isInteger(value) ? `${String(value)}.0` : String(value);
  if (typeof value === 'boolean') return String(value);
  throw new Error(`C++ oracle cannot render ${JSON.stringify(value)}`);
}

function unwrapCppTaskType(type: string | null | undefined): string | undefined {
  const match = /^flight::Task<(?<value>.+)>$/u.exec(type ?? '');
  return match?.groups?.value;
}

function runLines(command: string, args: readonly string[], cwd: string, subject: string): readonly string[] {
  const result = spawnSync(command, [...args], { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${subject} run failed:\n${result.stderr ?? ''}`);
  const lines = (result.stdout ?? '').split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function haxeModuleType(fixture: string): string {
  const directory = path.join(goldenDirectory, fixture, 'haxe');
  const entries = readdirSync(directory, { recursive: true, withFileTypes: true });
  const file = entries.find((entry) => entry.isFile() && entry.name.endsWith('.hx'));
  if (!file) throw new Error(`${fixture} has no emitted Haxe module`);
  return path
    .relative(directory, path.join(file.parentPath, file.name))
    .slice(0, -'.hx'.length)
    .split(path.sep)
    .join('.');
}

function renderTypeScriptValue(value: unknown): string {
  if (isDateArgument(value)) return `new Date(${JSON.stringify(value.date)})`;
  if (isStringEnumArgument(value)) return JSON.stringify(value.value);
  if (isTaskArgument(value)) return `Promise.resolve(${JSON.stringify(value.task)})`;
  if (isRejectedTaskArgument(value)) return `Promise.reject(${JSON.stringify(value.rejects)})`;
  if (isRecordArgument(value)) {
    const fields = Object.entries(value)
      .filter(([key]) => key !== '$type')
      .map(([key, fieldValue]) => `${key}: ${renderTypeScriptValue(fieldValue)}`);
    return `{${fields.join(', ')}}`;
  }
  return JSON.stringify(value);
}

function renderHaxeValue(value: unknown): string {
  if (isStringEnumArgument(value)) return JSON.stringify(value.value);
  if (isRecordArgument(value)) {
    const fields = Object.entries(value)
      .filter(([key]) => key !== '$type')
      .map(([key, fieldValue]) => `${key}: ${renderHaxeValue(fieldValue)}`);
    return `{${fields.join(', ')}}`;
  }
  if (isTaskArgument(value)) return `flighthq._internal._Promise.resolve(${renderHaxeValue(value.task)})`;
  if (isRejectedTaskArgument(value)) return `flighthq._internal._Promise.reject(${renderHaxeValue(value.rejects)})`;
  if (Array.isArray(value)) return `[${value.map(renderHaxeValue).join(', ')}]`;
  return JSON.stringify(value);
}

function renderRustValue(value: unknown, rustModule?: string): string {
  if (isStringEnumArgument(value)) {
    const module = rustModule ?? 'fixture';
    return `${module}::${value.$stringEnum}::${value.variant}`;
  }
  if (isRecordArgument(value)) {
    const module = rustModule ?? 'fixture';
    const fields = Object.entries(value)
      .filter(([key]) => key !== '$type')
      .map(([key, fieldValue]) => `${toSnakeCase(key)}: ${renderRustValue(fieldValue, rustModule)}`);
    return `${module}::${value.$type} { ${fields.join(', ')} }`;
  }
  if (isTaskArgument(value)) return `flight_runtime::FlightTask::ready(${renderRustValue(value.task, rustModule)})`;
  if (isRejectedTaskArgument(value))
    return `flight_runtime::FlightTask::reject(${JSON.stringify(String(value.rejects))})`;

  if (Array.isArray(value)) return `vec![${value.map((item) => renderRustValue(item, rustModule)).join(', ')}]`;
  if (typeof value === 'string') return `${JSON.stringify(value)}.to_owned()`;
  if (typeof value === 'number') return Number.isInteger(value) ? `${String(value)}.0` : String(value);
  return String(value);
}

function toSnakeCase(value: string): string {
  return value.replaceAll(/([a-z0-9])([A-Z])/gu, '$1_$2').toLowerCase();
}

function toCppName(value: string): string {
  const name = toSnakeCase(value);
  return cppKeywords.has(name) ? `${name}_` : name;
}

function hasCommand(command: string): boolean {
  try {
    execFileSync(command, ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
