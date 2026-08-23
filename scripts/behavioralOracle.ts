import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

// Does the emitted source do what the source language does?
//
// `compile:check` proves the output is a program. This proves it is the same program: each fixture's
// own TypeScript is run under Node and its answers become the expected values, then the emitted Haxe
// and Rust are built and run and compared against them. The source language is the oracle because it
// is the behavioral source of truth; a target that disagrees with it is wrong however well it
// compiles.
//
// The Haxe lane runs on the JavaScript target, so JavaScript-shaped semantics are inherited there
// rather than proven: what this gate establishes for Haxe is that the lowering is right, not that
// every Haxe backend renders a value the same way. Proving that needs hxcpp and a C++ toolchain.
//
// Arguments are scalars, arrays of scalars, and tasks. A record argument would have to be rendered
// as each target spells a record — including its type name in Rust — which is worth doing when a
// fixture needs it and is not done yet; such a fixture takes compile coverage only.
//
// A fixture opts in with `oracle.json`. Values are compared as canonical text rather than by each
// language's own formatting, because `1` and `1.0` and `1.000000` are the same answer — and because
// three languages printing the same double three ways is a difference in the harness, not in the
// compiler. Every side rounds to six decimals and trims, so the comparison is of values.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const goldenDirectory = path.join(root, 'golden');
const supportDirectory = path.join(goldenDirectory, 'support');

type OracleValueKind = 'boolean' | 'number' | 'numbers' | 'string' | 'strings';

interface OracleCase {
  readonly arguments: readonly unknown[];
  readonly awaits?: boolean;
  readonly call: string;
  readonly returns: OracleValueKind;
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

interface OracleDivergence {
  readonly actual: string;
  readonly expected: string;
  readonly fixture: string;
  readonly subject: string;
  readonly target: string;
}

const fixtures = readdirSync(goldenDirectory, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(path.join(goldenDirectory, entry.name, 'oracle.json')))
  .map((entry) => entry.name)
  .sort();

const haxeAvailable = hasCommand('haxe');
const rustAvailable = hasCommand('rustc') && hasCommand('cc');
const divergences: OracleDivergence[] = [];
const workspace = mkdtempSync(path.join(tmpdir(), 'flight-oracle-'));
let compared = 0;

try {
  for (const fixture of fixtures) {
    const cases = JSON.parse(
      readFileSync(path.join(goldenDirectory, fixture, 'oracle.json'), 'utf8'),
    ) as readonly OracleCase[];
    const expected = runTypeScriptOracle(fixture, cases);
    if (haxeAvailable && existsSync(path.join(goldenDirectory, fixture, 'haxe'))) {
      compare(fixture, 'haxe', expected, runHaxeOracle(fixture, cases));
    }
    if (rustAvailable && existsSync(path.join(goldenDirectory, fixture, 'rust'))) {
      compare(fixture, 'rust', expected, runRustOracle(fixture, cases));
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

const skipped = [...(haxeAvailable ? [] : ['haxe']), ...(rustAvailable ? [] : ['rust'])];
process.stdout.write(
  `Emitted source agrees with the source language: ${String(compared)} answers across ${String(fixtures.length)} fixtures${
    skipped.length > 0 ? ` (${skipped.join(', ')} not installed, skipped)` : ''
  }.\n`,
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
      '    ? Number.isInteger(value)',
      '      ? String(value)',
      "      : value.toFixed(6).replace(/0+$/u, '').replace(/\\.$/u, '')",
      '    : Array.isArray(value)',
      "      ? `[${value.map(say).join(', ')}]`",
      '      : String(value);',
      ...cases.map((oracleCase) => {
        const call = `fixture.${oracleCase.call}(${oracleCase.arguments.map(renderTypeScriptValue).join(', ')})`;
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
      '      if (number == Math.ffloor(number)) return Std.string(Std.int(number));',
      '      return Std.string(Math.round(number * 1000000) / 1000000);',
      '    }',
      '    return Std.string(value);',
      '  }',
      '  static function main() {',
      '    var step:flighthq._internal._Promise<Dynamic> = flighthq._internal._Promise.resolve(null);',
      ...cases.map((oracleCase) =>
        ((): string => {
          const call = `${haxeModuleType(fixture)}.${oracleCase.call}(${oracleCase.arguments.map(renderHaxeValue).join(', ')})`;
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
      '    if value == value.trunc() {',
      '        format!("{}", value as i64)',
      '    } else {',
      '        let rendered = format!("{:.6}", value);',
      "        rendered.trim_end_matches('0').trim_end_matches('.').to_owned()",
      '    }',
      '}',
      'fn main() {',
      ...cases.map((oracleCase) => {
        const invocation = `${modules[0] ?? 'fixture'}::${toSnakeCase(oracleCase.call)}(${oracleCase.arguments.map(renderRustValue).join(', ')})`;
        const call = oracleCase.awaits ? `flight_runtime::block_on(${invocation})` : invocation;
        switch (oracleCase.returns) {
          case 'number':
            return `    println!("{}", say_number(${call}));`;
          case 'numbers':
            return `    println!("[{}]", ${call}.into_iter().map(say_number).collect::<Vec<_>>().join(", "));`;
          case 'strings':
            return `    println!("[{}]", ${call}.join(", "));`;
          default:
            return `    println!("{}", ${call});`;
        }
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

function runLines(command: string, args: readonly string[], cwd: string, subject: string): readonly string[] {
  const result = spawnSync(command, [...args], { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${subject} run failed:\n${result.stderr ?? ''}`);
  return (result.stdout ?? '').trimEnd().split('\n');
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
  if (isTaskArgument(value)) return `Promise.resolve(${JSON.stringify(value.task)})`;
  if (isRejectedTaskArgument(value)) return `Promise.reject(${JSON.stringify(value.rejects)})`;
  return JSON.stringify(value);
}

function renderHaxeValue(value: unknown): string {
  if (isTaskArgument(value)) return `flighthq._internal._Promise.resolve(${renderHaxeValue(value.task)})`;
  if (isRejectedTaskArgument(value)) return `flighthq._internal._Promise.reject(${renderHaxeValue(value.rejects)})`;
  if (Array.isArray(value)) return `[${value.map(renderHaxeValue).join(', ')}]`;
  return JSON.stringify(value);
}

function renderRustValue(value: unknown): string {
  if (isTaskArgument(value)) return `flight_runtime::FlightTask::ready(${renderRustValue(value.task)})`;
  if (isRejectedTaskArgument(value)) throw new Error('a rejected task has no Rust settlement yet');
  if (Array.isArray(value)) return `vec![${value.map(renderRustValue).join(', ')}]`;
  if (typeof value === 'string') return `${JSON.stringify(value)}.to_owned()`;
  if (typeof value === 'number') return Number.isInteger(value) ? `${String(value)}.0` : String(value);
  return String(value);
}

function toSnakeCase(value: string): string {
  return value.replaceAll(/([a-z0-9])([A-Z])/gu, '$1_$2').toLowerCase();
}

function hasCommand(command: string): boolean {
  try {
    execFileSync(command, ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
