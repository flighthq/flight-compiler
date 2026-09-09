import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createCppSyntaxOnlyArguments, findCppCompilerToolchain } from './cppToolchain.js';
import { resolveDependency } from './dependencyLock.js';

// Does the emitted source actually compile?
//
// Every other gate reads the compiler's output; this one hands it to the target's own compiler. That
// is a different question, and the only one that can catch output which is well-formed, byte-stable,
// and still not a program — a wrong receiver, a moved value, a type that never resolves.
//
// Emission is one module at a time by design, so a fixture's runtime contract and its siblings are
// supplied from `golden/support`. Those stubs stand in for downstream implementations: the gate is
// checking the compiler, not the runtime.
//
// A toolchain that is not installed is reported and skipped rather than failed, so the gate stays
// runnable on a machine that has neither.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const goldenDirectory = path.join(root, 'golden');
const supportDirectory = path.join(goldenDirectory, 'support');
const cppRuntime = resolveDependency(root, 'flight-cpp');

interface TargetCompileFailure {
  readonly fixture: string;
  readonly output: string;
}

const fixtures = readdirSync(goldenDirectory, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(path.join(goldenDirectory, entry.name, 'input.ts')))
  .map((entry) => entry.name)
  .sort();

const failures: TargetCompileFailure[] = [];
const reports: string[] = [];
let checked = 0;

if (hasCommand('haxe', ['--version'])) {
  const haxeFixtures = fixtures.filter((fixture) => existsSync(path.join(goldenDirectory, fixture, 'haxe')));
  for (const fixture of haxeFixtures) {
    const emitted = path.join(goldenDirectory, fixture, 'haxe');
    const types = collectSourceFiles(emitted, '.hx').map((file) =>
      file.slice(0, -'.hx'.length).split(path.sep).join('.'),
    );
    if (types.length === 0) continue;
    checked += types.length;
    const result = spawnSync(
      'haxe',
      ['-cp', emitted, '-cp', path.join(supportDirectory, 'haxe'), '--js', devNull(), '--no-output', ...types],
      { encoding: 'utf8' },
    );
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
    if (output.length > 0) failures.push({ fixture: `haxe/${fixture}`, output });
  }
  reports.push(`haxe ${String(haxeFixtures.length)} fixtures`);
} else {
  reports.push('haxe not installed (skipped)');
}

if (hasCommand('rustc', ['--version'])) {
  const rustFixtures = fixtures.filter((fixture) => existsSync(path.join(goldenDirectory, fixture, 'rust')));
  const workspace = mkdtempSync(path.join(tmpdir(), 'flight-compile-'));
  try {
    for (const fixture of rustFixtures) {
      const emitted = path.join(goldenDirectory, fixture, 'rust');
      const modules = collectSourceFiles(emitted, '.rs').map((file) => file.slice(0, -'.rs'.length));
      if (modules.length === 0) continue;
      checked += modules.length;
      const crate = path.join(workspace, fixture);
      cpSync(emitted, crate, { recursive: true });
      cpSync(path.join(supportDirectory, 'rust'), crate, { recursive: true });
      // The runtime contract is a separate crate, which is what the emitted `use` says, so it is
      // built as one. Sibling modules stay modules of this crate, which is what `crate::` says.
      // `--extern` takes a built dependency, not metadata, and recognises it by its `lib*.rlib`
      // name. Building a library needs no linker, so this works without a system C toolchain.
      const runtime = path.join(crate, 'libflight_runtime.rlib');
      const built = spawnSync(
        'rustc',
        ['--edition', '2021', '--crate-name', 'flight_runtime', '--crate-type=lib', '-o', runtime, 'flight_runtime.rs'],
        { cwd: crate, encoding: 'utf8' },
      );
      if (built.status !== 0) {
        failures.push({ fixture: 'rust/flight_runtime', output: `${built.stdout ?? ''}${built.stderr ?? ''}`.trim() });
        break;
      }
      writeFileSync(
        path.join(crate, 'lib.rs'),
        `${['helper', ...modules].map((module) => `pub mod ${module};`).join('\n')}\n`,
      );
      const result = spawnSync(
        'rustc',
        [
          '--edition',
          '2021',
          '--crate-type=lib',
          '--emit=metadata',
          '--extern',
          `flight_runtime=${runtime}`,
          '-o',
          path.join(crate, 'out.rmeta'),
          'lib.rs',
        ],
        { cwd: crate, encoding: 'utf8' },
      );
      const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
      if (/^error/mu.test(output)) failures.push({ fixture: `rust/${fixture}`, output: output.trim() });
    }
  } finally {
    rmSync(workspace, { force: true, recursive: true });
  }
  reports.push(`rust ${String(rustFixtures.length)} fixtures`);
} else {
  reports.push('rustc not installed (skipped)');
}

const cppRuntimeInclude = path.join(cppRuntime.directory, 'include');
const cppRuntimeAvailable = existsSync(cppRuntimeInclude);
const cppToolchain = cppRuntimeAvailable ? findCppCompilerToolchain() : undefined;
if (cppToolchain) {
  const cppFixtures = fixtures.filter((fixture) => existsSync(path.join(goldenDirectory, fixture, 'cpp')));
  for (const fixture of cppFixtures) {
    const emitted = path.join(goldenDirectory, fixture, 'cpp');
    const headers = collectSourceFiles(emitted, '.hpp');
    if (headers.length === 0) continue;
    checked += headers.length;
    for (const header of headers) {
      const result = spawnSync(
        cppToolchain.command,
        createCppSyntaxOnlyArguments(cppToolchain, path.join(emitted, header), [
          cppRuntimeInclude,
          path.join(supportDirectory, 'cpp'),
        ]),
        {
          cwd: emitted,
          encoding: 'utf8',
        },
      );
      const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
      if (result.status !== 0) failures.push({ fixture: `cpp/${fixture}/${header}`, output: output.trim() });
    }
  }
  reports.push(`cpp ${String(cppFixtures.length)} fixtures (${cppToolchain.command}, ${cppToolchain.family})`);
} else if (cppRuntimeAvailable) {
  reports.push('C++ compiler not installed (skipped)');
} else {
  reports.push('flight-cpp not rehydrated (skipped)');
}

if (failures.length > 0) {
  for (const failure of failures) {
    process.stderr.write(`\n### ${failure.fixture}\n${failure.output}\n`);
  }
  process.stderr.write(`\n${String(failures.length)} emitted fixture(s) do not compile (${reports.join(', ')}).\n`);
  process.exit(1);
}

process.stdout.write(`Emitted source compiles: ${String(checked)} files (${reports.join(', ')}).\n`);

function collectSourceFiles(directory: string, extension: string): string[] {
  const entries = readdirSync(directory, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(extension))
    .map((entry) => path.relative(directory, path.join(entry.parentPath, entry.name)))
    .sort();
}

function devNull(): string {
  return process.platform === 'win32' ? 'NUL' : '/dev/null';
}

function hasCommand(command: string, args: readonly string[]): boolean {
  try {
    execFileSync(command, [...args], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
