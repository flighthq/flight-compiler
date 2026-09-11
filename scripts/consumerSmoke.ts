import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Installs the packed tarball into a clean project outside this repository and compiles through the
// published entry point.
//
// `pack:check` proves the tarball's contents and imports the built module in place. That is a
// different claim: in place, every private workspace is still on disk and every relative import
// resolves whether or not it was assembled correctly. This installs what a consumer would install,
// with nothing else present, and runs a real compile through it.
//
// It is deliberately not part of `npm run verify`. Installing a tarball reaches the network for the
// package's own dependencies, and a gate that needs the network is a gate that fails for reasons
// unrelated to the change under test. It runs in the nightly workflow, where that cost is expected.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageDirectory = path.join(root, 'packages', 'tool-compiler');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
if (!existsSync(packageDirectory)) {
  process.stderr.write('Consumer smoke failed: the public package directory is missing.\n');
  process.exit(1);
}

const consumer = mkdtempSync(path.join(os.tmpdir(), 'flight-compiler-consumer-'));

try {
  run([npm, 'run', 'build', '--silent'], root, 'build the publishable output');
  run([npm, 'pack', '--ignore-scripts', `--pack-destination=${consumer}`], packageDirectory, 'pack the tarball');

  const tarball = readdirSync(consumer).find((entry) => entry.endsWith('.tgz'));
  if (tarball === undefined) fail('pack produced no tarball, so nothing was installed');

  writeFileSync(
    path.join(consumer, 'package.json'),
    `${JSON.stringify({ name: 'consumer', private: true, type: 'module', version: '0.0.0' }, null, 2)}\n`,
  );
  run([npm, 'install', '--no-audit', '--no-fund', `./${tarball}`], consumer, 'install the tarball');
  writeFileSync(path.join(consumer, 'smoke.mjs'), smokeSource());

  const smoke = spawnSync(process.execPath, ['smoke.mjs'], { cwd: consumer, encoding: 'utf8' });
  if (smoke.status !== 0) {
    process.stderr.write(smoke.stdout);
    process.stderr.write(smoke.stderr);
    fail('the installed package did not compile a module through its published entry point');
  }
  process.stdout.write(smoke.stdout);
  process.stdout.write(`Consumer smoke passed against ${tarball}.\n`);
} finally {
  rmSync(consumer, { force: true, recursive: true });
}

function fail(message: string): never {
  process.stderr.write(`Consumer smoke failed: ${message}.\n`);
  process.exit(1);
}

function run(command: readonly string[], cwd: string, description: string): void {
  const [executable, ...args] = command;
  if (executable === undefined) fail(`no command given to ${description}`);
  const result = spawnSync(executable, args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    process.stderr.write(result.stdout ?? '');
    process.stderr.write(result.stderr ?? '');
    fail(`could not ${description}`);
  }
}

// The consumer compiles a module through both backends and asserts the emitted paths and a line of
// each output, so a package that imports cleanly but emits nothing still fails.
function smokeSource(): string {
  return `import {
  compileTypeScriptModules,
  createHaxeCompilerBackend,
  createRustCompilerBackend,
  parseTypeScriptSource,
} from '@flighthq/tool-compiler';

const source = parseTypeScriptSource(
  '/flight/packages/math/src/clamp.ts',
  'export function clamp(v: number, lo: number, hi: number): number {\\n  if (v < lo) return lo;\\n  return v;\\n}\\n',
);
const input = { packageName: '@flighthq/math', sourceFile: source, upstreamDirectory: '/flight' };
const haxe = compileTypeScriptModules({ backend: createHaxeCompilerBackend(), backendOptions: {}, sources: [input] });
const rust = compileTypeScriptModules({ backend: createRustCompilerBackend(), backendOptions: {}, sources: [input] });

const expectations = [
  [haxe.compilation.files[0]?.path, 'flighthq/math/Clamp.hx'],
  [rust.compilation.files[0]?.path, 'clamp.rs'],
];
for (const [actual, expected] of expectations) {
  if (actual !== expected) throw new Error(\`expected \${expected}, received \${String(actual)}\`);
}
if (!haxe.compilation.files[0].contents.includes('public static function clamp(v:Float, lo:Float, hi:Float):Float')) {
  throw new Error('the Haxe backend emitted no clamp signature');
}
if (!rust.compilation.files[0].contents.includes('pub fn clamp(v: f64, lo: f64, hi: f64) -> f64')) {
  throw new Error('the Rust backend emitted no clamp signature');
}
console.log('consumer compiled ' + haxe.compilation.files[0].path + ' and ' + rust.compilation.files[0].path);
`;
}
