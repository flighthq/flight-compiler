import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { resolveDependency } from './dependencyLock.js';
import { formatHaxeDualBindingGateRunReport, runHaxeDualBindingGateChecks } from './haxeDualBindingRun.js';

interface HaxeBindingCheckpointProducerOptions {
  readonly cppDirectory: string;
  readonly flightDirectory: string;
  readonly outputDirectory: string;
}

interface HaxeBindingCheckpointProducerResult {
  readonly cppIncludeDirectories: readonly string[];
  readonly cppSlicePaths: readonly string[];
  readonly haxeDirectory: string;
  readonly javascriptModuleDirectory: string;
  readonly planArtifactDirectory: string;
  readonly refusalArtifactDirectory: string;
}

interface HaxeBindingCheckpointToolStatus {
  readonly detail: string;
  readonly status: 'failed' | 'passed' | 'unchecked';
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cpp = resolveDependency(root, 'flight-cpp');
const flight = resolveDependency(cpp.directory, 'flight');
const outputDirectory =
  parseHaxeBindingCheckpointOutput(process.argv.slice(2)) ??
  path.join(root, '.script-build', 'haxe-binding-checkpoint');
const producerFile = path.join(
  root,
  'packages',
  'tool-compiler',
  'dist',
  'packages',
  'tool-compiler',
  'src',
  'compilerHaxeBindingCheckpoint.js',
);
const producer = (await import(pathToFileURL(producerFile).href)) as {
  readonly produceCompilerHaxeBindingCheckpoint: (
    options: Readonly<HaxeBindingCheckpointProducerOptions>,
  ) => HaxeBindingCheckpointProducerResult;
};
const options = {
  cppDirectory: cpp.directory,
  flightDirectory: flight.directory,
  outputDirectory,
};

producer.produceCompilerHaxeBindingCheckpoint(options);
const firstSnapshot = snapshotHaxeBindingCheckpointOutput(outputDirectory);
const result = producer.produceCompilerHaxeBindingCheckpoint(options);
const secondSnapshot = snapshotHaxeBindingCheckpointOutput(outputDirectory);
const deterministic = compareHaxeBindingCheckpointSnapshots(firstSnapshot, secondSnapshot);

const gateOptions = {
  cpp: { includeDirectories: result.cppIncludeDirectories, slicePaths: result.cppSlicePaths },
  js: { moduleDirectories: [result.javascriptModuleDirectory] },
};
const report = await runHaxeDualBindingGateChecks({
  artifactDirectory: result.planArtifactDirectory,
  ...gateOptions,
});
const refusalReport = await runHaxeDualBindingGateChecks({
  artifactDirectory: result.refusalArtifactDirectory,
  ...gateOptions,
});
const refusalObserved = refusalReport.failures.some(
  (failure) =>
    failure.rule === 'haxe-dual-binding-gate-backing-refused' && failure.detail.includes('SharedArrayBuffer[type]'),
);
const haxeNoOutput = runHaxeBindingCheckpointNoOutput(result, outputDirectory);
const hxcppRuntime = inspectHaxeBindingCheckpointHxcppRuntime();

process.stdout.write(formatHaxeDualBindingGateRunReport(report));
process.stdout.write(
  `Haxe checkpoint deterministic rerun: ${deterministic ? 'passed' : 'failed'} (${String(firstSnapshot.size)} file(s)).\n`,
);
process.stdout.write(
  `Haxe checkpoint selected refusal: ${refusalObserved ? 'passed' : 'failed'} (${String(refusalReport.failures.length)} expected negative-gate failure(s)).\n`,
);
process.stdout.write(`Haxe no-output: ${haxeNoOutput.status} — ${haxeNoOutput.detail}\n`);
process.stdout.write(`hxcpp runtime: ${hxcppRuntime.status} — ${hxcppRuntime.detail}\n`);
process.stdout.write(
  `Artifacts: plans=${path.relative(root, result.planArtifactDirectory)} modules=${path.relative(root, result.javascriptModuleDirectory)} haxe=${path.relative(root, result.haxeDirectory)}\n`,
);

if (report.failures.length > 0 || !deterministic || !refusalObserved || haxeNoOutput.status === 'failed') {
  process.exitCode = 1;
}

function parseHaxeBindingCheckpointOutput(argv: readonly string[]): string | undefined {
  for (const argument of argv) {
    if (argument.startsWith('--output=')) return path.resolve(argument.slice('--output='.length));
  }
  return undefined;
}

function snapshotHaxeBindingCheckpointOutput(directory: string): ReadonlyMap<string, string> {
  const result = new Map<string, string>();
  const visit = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((left, right) =>
      compareHaxeBindingCheckpointText(left.name, right.name),
    )) {
      const absolutePath = path.join(current, entry.name);
      if (entry.isDirectory()) visit(absolutePath);
      else
        result.set(
          path.relative(directory, absolutePath).split(path.sep).join('/'),
          readFileSync(absolutePath, 'utf8'),
        );
    }
  };
  visit(directory);
  return result;
}

function compareHaxeBindingCheckpointSnapshots(
  left: ReadonlyMap<string, string>,
  right: ReadonlyMap<string, string>,
): boolean {
  return (
    left.size === right.size &&
    [...left].every(([file, contents]) => right.get(file) === contents) &&
    [...right].every(([file, contents]) => left.get(file) === contents)
  );
}

function runHaxeBindingCheckpointNoOutput(
  result: Readonly<HaxeBindingCheckpointProducerResult>,
  outputDirectory: string,
): HaxeBindingCheckpointToolStatus {
  const version = spawnSync('haxe', ['--version'], { encoding: 'utf8' });
  if (version.error || version.status !== 0) {
    return { detail: 'haxe executable unavailable; generated sources were not typechecked', status: 'unchecked' };
  }
  const check = spawnSync(
    'haxe',
    [
      '-cp',
      result.haxeDirectory,
      '-cp',
      path.join(outputDirectory, 'consumer'),
      '--main',
      'Checkpoint',
      '--js',
      os.devNull,
      '--no-output',
      '-D',
      'flight_esm',
    ],
    { encoding: 'utf8' },
  );
  const output = `${check.stdout ?? ''}${check.stderr ?? ''}`.trim();
  const haxeVersion = `${version.stdout ?? ''}${version.stderr ?? ''}`.trim();
  return check.status === 0
    ? {
        detail: `Haxe ${haxeVersion} accepted the public JavaScript selector consumer`,
        status: 'passed',
      }
    : { detail: output || `haxe exited ${String(check.status)}`, status: 'failed' };
}

function inspectHaxeBindingCheckpointHxcppRuntime(): HaxeBindingCheckpointToolStatus {
  const haxelib = spawnSync('haxelib', ['path', 'hxcpp'], { encoding: 'utf8' });
  if (haxelib.error || haxelib.status !== 0) {
    return {
      detail: 'hxcpp is unavailable; no native Haxe binary was built or executed',
      status: 'unchecked',
    };
  }
  return {
    detail: 'hxcpp is present, but this checkpoint does not install or configure a downstream native runtime harness',
    status: 'unchecked',
  };
}

function compareHaxeBindingCheckpointText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
