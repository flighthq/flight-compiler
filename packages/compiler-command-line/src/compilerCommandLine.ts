import { createCppCompilerBackend } from '../../compiler-backend-cpp/src/index.js';
import { createHaxeCompilerBackend } from '../../compiler-backend-hx/src/index.js';
import { createRustCompilerBackend } from '../../compiler-backend-rs/src/index.js';
import { compileTypeScriptPackageGraph, parseTypeScriptSource } from '../../compiler-orchestration/src/index.js';
import type {
  CompilerCommandLineCapabilities,
  CompilerCommandLineRefusal,
  CompilerCommandLineRequest,
  CompilerCommandLineResult,
  HaxeCompilerEmissionMode,
} from '../../compiler-types/src/index.js';

// Pointing the compiler at a directory.
//
// All modules enter one graph compilation so sibling identities and graph-wide backend analysis are
// available. Each module still has its own outcome: pointed at an unfamiliar codebase, what one
// wants is the complete refusal report rather than a run that stops at the first unsupported form.
//
// The filesystem arrives as a capability record so the decision layer stays testable and so this
// stays the only place in the package that touches it.
export function compileCompilerCommandLineRequest(
  request: Readonly<CompilerCommandLineRequest>,
  capabilities: Readonly<CompilerCommandLineCapabilities>,
): CompilerCommandLineResult {
  const parsed = parseCompilerCommandLineRequest(request);
  if ('failure' in parsed) {
    capabilities.writeError(`${parsed.failure}\n\n${getCompilerCommandLineUsage()}\n`);
    return { emitted: 0, exitCode: 2, refusals: [] };
  }
  const backend =
    parsed.target === 'haxe'
      ? createHaxeCompilerBackend()
      : parsed.target === 'cpp'
        ? createCppCompilerBackend()
        : createRustCompilerBackend();
  const backendOptions: Record<string, unknown> =
    parsed.target === 'haxe'
      ? {
          emissionMode: parsed.emissionMode,
          ...(parsed.rootPackage === undefined ? {} : { rootPackage: parsed.rootPackage }),
        }
      : parsed.target === 'cpp'
        ? {
            runtimeProfile: parsed.runtimeProfile,
            ...(parsed.runtimeHeader === undefined ? {} : { runtimeHeader: parsed.runtimeHeader }),
          }
        : {};
  const sources = capabilities.listSourceFiles(parsed.sourceDirectory);
  if (sources.length === 0) {
    capabilities.writeError(`No TypeScript modules under ${parsed.sourceDirectory}\n`);
    return { emitted: 0, exitCode: 2, refusals: [] };
  }
  const result = compileTypeScriptPackageGraph({
    backend,
    backendOptions,
    graph: {
      entries: [],
      moduleDependencies: [],
      packages: [{ dependencies: [], name: parsed.packageName, root: parsed.sourceDirectory }],
      schema: 'flight-compiler-package-graph/1',
    },
    sources: sources.map((source) => ({
      packageName: parsed.packageName,
      packageRoot: parsed.sourceDirectory,
      sourceFile: parseTypeScriptSource(source.sourcePath, source.contents),
      upstreamDirectory: parsed.sourceDirectory,
    })),
  });
  for (const file of result.compilation.files) {
    capabilities.writeOutputFile(parsed.outputDirectory, file.path, file.contents);
  }
  const emitted = result.report.modules.filter((module) => module.status === 'emitted').length;
  const refusals = result.report.modules.flatMap((module): CompilerCommandLineRefusal[] => {
    const refusal = module.refusals[0];
    if (!refusal) return [];
    return [
      {
        code: refusal.code,
        ...(refusal.column === undefined ? {} : { column: refusal.column }),
        ...(refusal.line === undefined ? {} : { line: refusal.line }),
        module: module.module.source,
        reason: refusal.message,
        stage: refusal.stage,
      },
    ];
  });
  capabilities.write(createCompilerCommandLineReport(emitted, refusals));
  return { emitted, exitCode: refusals.length > 0 && !parsed.reportOnly ? 1 : 0, refusals };
}

// What the compiler could not do, grouped by reason rather than listed by module. One rule blocking
// forty modules is one thing to decide about; forty lines are forty things to read.
export function createCompilerCommandLineReport(
  emitted: number,
  refusals: readonly Readonly<{ module: string; reason: string }>[],
): string {
  const lines = [`${String(emitted)} module(s) emitted, ${String(refusals.length)} refused.`];
  const grouped = new Map<string, string[]>();
  for (const refusal of refusals) {
    grouped.set(refusal.reason, [...(grouped.get(refusal.reason) ?? []), refusal.module]);
  }
  const ordered = [...grouped.entries()].sort(
    (left, right) => right[1].length - left[1].length || (left[0] < right[0] ? -1 : 1),
  );
  for (const [reason, modules] of ordered) {
    lines.push('', `  ${String(modules.length)}x ${reason}`);
    for (const module of modules.slice(0, refusalModuleSampleSize)) lines.push(`       ${module}`);
    if (modules.length > refusalModuleSampleSize) {
      lines.push(`       … and ${String(modules.length - refusalModuleSampleSize)} more`);
    }
  }
  return `${lines.join('\n')}\n`;
}

export function getCompilerCommandLineUsage(): string {
  return commandLineUsage;
}

const commandLineUsage = `Usage: flight-compile <source-directory> --target <cpp|haxe|rust> --out <directory>

  --package <name>        Package name the modules belong to (default: @local/source)
  --emission-mode <mode>  Haxe emission: extern or transpile (default: transpile)
  --root-package <name>   Root package for Haxe output (default: the target's own)
  --runtime-profile <id>  C++ runtime profile: flight-cpp or standard-library (default: flight-cpp)
  --runtime-header <path> Override the flight-cpp runtime include spelling
  --report                Report refusals without failing the run`;

interface ParsedCompilerCommandLineRequest {
  readonly emissionMode: HaxeCompilerEmissionMode;
  readonly outputDirectory: string;
  readonly packageName: string;
  readonly reportOnly: boolean;
  readonly rootPackage?: string | undefined;
  readonly runtimeHeader?: string | undefined;
  readonly runtimeProfile: 'flight-cpp' | 'standard-library';
  readonly sourceDirectory: string;
  readonly target: 'cpp' | 'haxe' | 'rust';
}

function parseCompilerCommandLineRequest(
  request: Readonly<CompilerCommandLineRequest>,
): ParsedCompilerCommandLineRequest | Readonly<{ failure: string }> {
  const positional: string[] = [];
  const named = new Map<string, string>();
  let reportOnly = false;
  for (let index = 0; index < request.argv.length; index += 1) {
    const argument = request.argv[index]!;
    if (argument === '--report') {
      reportOnly = true;
      continue;
    }
    if (!argument.startsWith('--')) {
      positional.push(argument);
      continue;
    }
    if (!commandLineValueOptions.has(argument)) return { failure: `Unknown option ${argument}` };
    if (named.has(argument.slice(2))) return { failure: `${argument} may be supplied once` };
    const value = request.argv[index + 1];
    if (value === undefined || value.startsWith('--')) return { failure: `${argument} requires a value` };
    named.set(argument.slice(2), value);
    index += 1;
  }
  const sourceDirectory = positional[0];
  if (sourceDirectory === undefined) return { failure: 'A source directory is required' };
  if (positional.length > 1) return { failure: 'Exactly one source directory is required' };
  const target = named.get('target');
  if (target !== 'cpp' && target !== 'haxe' && target !== 'rust')
    return { failure: '--target must be cpp, haxe, or rust' };
  const outputDirectory = named.get('out');
  if (outputDirectory === undefined) return { failure: '--out is required' };
  const rootPackage = named.get('root-package');
  if (rootPackage !== undefined && target !== 'haxe') return { failure: '--root-package requires --target haxe' };
  const emissionMode = named.get('emission-mode') ?? 'transpile';
  if (emissionMode !== 'extern' && emissionMode !== 'transpile') {
    return { failure: '--emission-mode must be extern or transpile' };
  }
  if (named.has('emission-mode') && target !== 'haxe') {
    return { failure: '--emission-mode requires --target haxe' };
  }
  const runtimeProfile = named.get('runtime-profile') ?? 'flight-cpp';
  if (runtimeProfile !== 'flight-cpp' && runtimeProfile !== 'standard-library') {
    return { failure: '--runtime-profile must be flight-cpp or standard-library' };
  }
  const runtimeHeader = named.get('runtime-header');
  if ((named.has('runtime-profile') || runtimeHeader !== undefined) && target !== 'cpp') {
    return { failure: '--runtime-profile and --runtime-header require --target cpp' };
  }
  if (runtimeHeader !== undefined && (!isPortableIncludePath(runtimeHeader) || runtimeProfile !== 'flight-cpp')) {
    return {
      failure:
        runtimeProfile !== 'flight-cpp'
          ? '--runtime-header requires the flight-cpp runtime profile'
          : '--runtime-header must be a portable quoted-include path',
    };
  }
  return {
    emissionMode,
    outputDirectory,
    packageName: named.get('package') ?? '@local/source',
    reportOnly,
    ...(rootPackage === undefined ? {} : { rootPackage }),
    ...(runtimeHeader === undefined ? {} : { runtimeHeader }),
    runtimeProfile,
    sourceDirectory,
    target,
  };
}

function isPortableIncludePath(value: string): boolean {
  return value.length > 0 && !value.includes('\\') && !/["<>\r\n]/u.test(value);
}

const commandLineValueOptions = new Set([
  '--emission-mode',
  '--out',
  '--package',
  '--root-package',
  '--runtime-header',
  '--runtime-profile',
  '--target',
]);

const refusalModuleSampleSize = 3;
