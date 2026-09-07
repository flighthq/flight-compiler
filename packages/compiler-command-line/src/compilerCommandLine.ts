import { createCppCompilerBackend } from '../../compiler-backend-cpp/src/index.js';
import { createHaxeCompilerBackend } from '../../compiler-backend-hx/src/index.js';
import { createRustCompilerBackend } from '../../compiler-backend-rs/src/index.js';
import { isBackendEmissionFailure } from '../../compiler-emission/src/index.js';
import {
  compileTypeScriptModules,
  isCompilerDiagnosticsFailure,
  parseTypeScriptSource,
} from '../../compiler-orchestration/src/index.js';
import type {
  CompilerBackend,
  CompilerCommandLineCapabilities,
  CompilerCommandLineRequest,
  CompilerCommandLineResult,
} from '../../compiler-types/src/index.js';

// Pointing the compiler at a directory.
//
// Every module is compiled on its own and its outcome recorded, rather than the whole run failing on
// the first module the compiler cannot lower. Pointed at a codebase this compiler has never seen,
// what one wants is the list of what it could not do — a run that stops at the first refusal answers
// a question nobody asked.
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
  const sources = capabilities.listSourceFiles(parsed.sourceDirectory);
  if (sources.length === 0) {
    capabilities.writeError(`No TypeScript modules under ${parsed.sourceDirectory}\n`);
    return { emitted: 0, exitCode: 2, refusals: [] };
  }
  const refusals: { module: string; reason: string }[] = [];
  let emitted = 0;
  for (const source of sources) {
    const outcome = compileOneModule(source, parsed, backend, capabilities);
    if (outcome.kind === 'emitted') {
      emitted += 1;
      continue;
    }
    refusals.push({ module: source.moduleName, reason: outcome.reason });
  }
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
  --root-package <name>   Root package for Haxe output (default: the target's own)
  --report                Report refusals without failing the run`;

function compileOneModule(
  source: Readonly<{ contents: string; moduleName: string; sourcePath: string }>,
  request: ParsedCompilerCommandLineRequest,
  backend: CompilerBackend<Record<string, unknown>>,
  capabilities: Readonly<CompilerCommandLineCapabilities>,
): Readonly<{ kind: 'emitted' } | { kind: 'refused'; reason: string }> {
  try {
    const result = compileTypeScriptModules({
      backend,
      backendOptions: request.rootPackage === undefined ? {} : { rootPackage: request.rootPackage },
      sources: [
        {
          packageName: request.packageName,
          sourceFile: parseTypeScriptSource(source.sourcePath, source.contents),
          upstreamDirectory: request.sourceDirectory,
        },
      ],
    });
    for (const file of result.compilation.files) {
      capabilities.writeOutputFile(request.outputDirectory, file.path, file.contents);
    }
    return { kind: 'emitted' };
  } catch (error) {
    if (isBackendEmissionFailure(error)) return { kind: 'refused', reason: error.message };
    if (isCompilerDiagnosticsFailure(error)) {
      return { kind: 'refused', reason: error.diagnostics[0]?.message ?? 'lowering produced diagnostics' };
    }
    if (error instanceof Error) return { kind: 'refused', reason: error.message };
    throw error;
  }
}

interface ParsedCompilerCommandLineRequest {
  readonly outputDirectory: string;
  readonly packageName: string;
  readonly reportOnly: boolean;
  readonly rootPackage?: string | undefined;
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
    const value = request.argv[index + 1];
    if (value === undefined || value.startsWith('--')) return { failure: `${argument} requires a value` };
    named.set(argument.slice(2), value);
    index += 1;
  }
  const sourceDirectory = positional[0];
  if (sourceDirectory === undefined) return { failure: 'A source directory is required' };
  const target = named.get('target');
  if (target !== 'cpp' && target !== 'haxe' && target !== 'rust')
    return { failure: '--target must be cpp, haxe, or rust' };
  const outputDirectory = named.get('out');
  if (outputDirectory === undefined) return { failure: '--out is required' };
  const rootPackage = named.get('root-package');
  return {
    outputDirectory,
    packageName: named.get('package') ?? '@local/source',
    reportOnly,
    ...(rootPackage === undefined ? {} : { rootPackage }),
    sourceDirectory,
    target,
  };
}

const refusalModuleSampleSize = 3;
