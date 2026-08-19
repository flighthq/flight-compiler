import { readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

interface PackFile {
  path: string;
  size: number;
}

interface PackReport {
  files: PackFile[];
  name: string;
  version: string;
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageDirectory = path.join(root, 'packages', 'tool-compiler');
const distDirectory = path.join(packageDirectory, 'dist');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const result = spawnSync(npm, ['pack', '--dry-run', '--json', '--ignore-scripts'], {
  cwd: packageDirectory,
  encoding: 'utf8',
});

if (result.status !== 0) {
  process.stderr.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exit(result.status ?? 1);
}

let reports: PackReport[];
try {
  reports = JSON.parse(result.stdout) as PackReport[];
} catch {
  process.stderr.write(`Unable to parse npm pack report:\n${result.stdout}\n${result.stderr}`);
  process.exit(1);
}

const report = reports[0];
if (!report || reports.length !== 1) {
  process.stderr.write(`Expected one npm pack report, received ${String(reports.length)}.\n`);
  process.exit(1);
}

const errors: string[] = [];
const files = new Set(report.files.map((file) => file.path));
const packages = readdirSync(path.join(root, 'packages'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && entry.name.startsWith('compiler-'))
  .map((entry) => entry.name)
  .sort();

check(report.name === '@flighthq/tool-compiler', 'tarball name must be @flighthq/tool-compiler');
for (const required of [
  'LICENSE.md',
  'README.md',
  'dist/packages/tool-compiler/src/index.d.ts',
  'dist/packages/tool-compiler/src/index.js',
  'package.json',
]) {
  check(files.has(required), `tarball is missing ${required}`);
}
for (const packageName of packages) {
  for (const extension of ['d.ts', 'js']) {
    const entry = `dist/packages/${packageName}/src/index.${extension}`;
    check(files.has(entry), `tarball is missing assembled workspace entry ${entry}`);
  }
}
for (const file of files) {
  check(!file.endsWith('.test.ts') && !file.includes('.test.'), `tarball contains test output ${file}`);
  check(!file.startsWith('coverage/'), `tarball contains coverage output ${file}`);
  check(!file.startsWith('packages/'), `tarball exposes private workspace source ${file}`);
}

for (const file of walk(distDirectory)) {
  if (!file.endsWith('.js') && !file.endsWith('.d.ts')) continue;
  const contents = readFileSync(file, 'utf8');
  check(!contents.includes('@flighthq/compiler-'), `${relative(file)} references an unpublished private package`);
  check(!/from\s+['"][^'"]+\.ts['"]/u.test(contents), `${relative(file)} retains a TypeScript import specifier`);
}

const publicModule = (await import(
  pathToFileURL(path.join(distDirectory, 'packages', 'tool-compiler', 'src', 'index.js')).href
)) as Record<string, unknown>;
for (const publicExport of [
  'analyzeFlightWorkspace',
  'compileTypeScriptModules',
  'createHaxeCompilerBackend',
  'createRustCompilerBackend',
]) {
  check(publicExport in publicModule, `assembled public module is missing ${publicExport}`);
}

if (errors.length > 0) {
  process.stderr.write(`Pack health failed with ${String(errors.length)} error(s):\n`);
  for (const error of errors) process.stderr.write(`- ${error}\n`);
  process.exit(1);
}

const bytes = report.files.reduce((total, file) => total + file.size, 0);
process.stdout.write(
  `Pack health passed for ${report.name}@${report.version}: ${String(report.files.length)} files, ${String(bytes)} bytes.\n`,
);

function check(condition: boolean, message: string): void {
  if (!condition) errors.push(message);
}

function walk(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(target));
    else if (entry.isFile()) files.push(target);
  }
  return files;
}

function relative(file: string): string {
  return path.relative(root, file).replaceAll('\\', '/');
}
