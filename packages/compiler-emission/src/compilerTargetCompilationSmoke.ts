import { compareTextCodeUnits } from '../../compiler-canonical-form/src/index.js';
import type {
  CompilerTargetCompilationSmoke,
  CompilerTargetCompilationSmokeDiagnostic,
  CompilerTargetCompilationSmokeFailure,
  CompilerTargetCompilationSmokeReport,
  EmittedFile,
} from '../../compiler-types/src/index.js';
import {
  createCompilerInvariantFailure,
  normalizeEmittedFile,
  normalizeEmittedFilePath,
} from './compilerSourceEmission.js';

export function isCompilerTargetCompilationSmokeFailure(
  value: unknown,
): value is CompilerTargetCompilationSmokeFailure {
  return (
    value instanceof Error &&
    'kind' in value &&
    value.kind === 'target-compilation-smoke' &&
    'compiler' in value &&
    typeof value.compiler === 'string' &&
    value.compiler.length > 0 &&
    'diagnostics' in value &&
    Array.isArray(value.diagnostics) &&
    value.diagnostics.every(isCompilerTargetCompilationSmokeDiagnostic)
  );
}

export function validateCompilerTargetCompilationSmoke(
  files: readonly Readonly<EmittedFile>[],
  compiler: Readonly<CompilerTargetCompilationSmoke>,
): CompilerTargetCompilationSmokeReport {
  const compilerName = validateCompilerTargetCompilationSmokeName(compiler.name);
  const checkedFiles: EmittedFile[] = [];
  const skippedFiles: string[] = [];
  for (const input of files) {
    const file = Object.freeze(normalizeEmittedFile(input));
    const supported = compiler.supportsEmittedSource(file);
    if (typeof supported !== 'boolean') {
      throw createCompilerInvariantFailure(
        'invalid-target-compilation-smoke-adapter',
        compilerName,
        `Target compiler ${compilerName} returned a non-boolean support decision for ${file.path}`,
      );
    }
    if (supported) checkedFiles.push(file);
    else skippedFiles.push(file.path);
  }
  if (checkedFiles.length > 0) {
    const compiled = compiler.compileEmittedSources(Object.freeze(checkedFiles));
    if (!Array.isArray(compiled)) {
      throw createCompilerInvariantFailure(
        'invalid-target-compilation-smoke-adapter',
        compilerName,
        `Target compiler ${compilerName} returned a non-array diagnostic result`,
      );
    }
    const checkedPaths = new Set(checkedFiles.map((file) => file.path));
    const diagnostics = compiled.map((diagnostic, index) =>
      normalizeCompilerTargetCompilationSmokeDiagnostic(diagnostic, checkedPaths, index, compilerName),
    );
    diagnostics.sort(compareCompilerTargetCompilationSmokeDiagnostics);
    if (diagnostics.length > 0) throw createCompilerTargetCompilationSmokeFailure(compilerName, diagnostics);
  }
  skippedFiles.sort(compareTextCodeUnits);
  return { checkedFiles: checkedFiles.length, compiler: compilerName, skippedFiles };
}

function compareCompilerTargetCompilationSmokeDiagnostics(
  left: Readonly<CompilerTargetCompilationSmokeDiagnostic>,
  right: Readonly<CompilerTargetCompilationSmokeDiagnostic>,
): number {
  return (
    compareTextCodeUnits(left.path, right.path) ||
    left.line - right.line ||
    left.column - right.column ||
    compareTextCodeUnits(left.code, right.code) ||
    compareTextCodeUnits(left.message, right.message)
  );
}

function createCompilerTargetCompilationSmokeFailure(
  compiler: string,
  diagnostics: readonly Readonly<CompilerTargetCompilationSmokeDiagnostic>[],
): CompilerTargetCompilationSmokeFailure {
  const captured = diagnostics.map((diagnostic) => Object.freeze({ ...diagnostic }));
  const message = `Target compiler ${compiler} produced ${String(captured.length)} diagnostic(s):\n${captured
    .map(
      (diagnostic) =>
        `${diagnostic.path}:${String(diagnostic.line)}:${String(diagnostic.column)} [${diagnostic.code}] ${diagnostic.message}`,
    )
    .join('\n')}`;
  const failure = Object.assign(new Error(message), {
    compiler,
    diagnostics: Object.freeze(captured),
    kind: 'target-compilation-smoke' as const,
  });
  failure.name = 'CompilerTargetCompilationSmokeError';
  return failure;
}

function isCompilerTargetCompilationSmokeDiagnostic(value: unknown): value is CompilerTargetCompilationSmokeDiagnostic {
  return (
    typeof value === 'object' &&
    value !== null &&
    'code' in value &&
    typeof value.code === 'string' &&
    value.code.length > 0 &&
    'column' in value &&
    typeof value.column === 'number' &&
    Number.isInteger(value.column) &&
    value.column >= 1 &&
    'line' in value &&
    typeof value.line === 'number' &&
    Number.isInteger(value.line) &&
    value.line >= 1 &&
    'message' in value &&
    typeof value.message === 'string' &&
    value.message.length > 0 &&
    'path' in value &&
    typeof value.path === 'string' &&
    value.path.length > 0
  );
}

function normalizeCompilerTargetCompilationSmokeDiagnostic(
  value: unknown,
  checkedPaths: ReadonlySet<string>,
  index: number,
  compiler: string,
): CompilerTargetCompilationSmokeDiagnostic {
  const path = getCompilerTargetCompilationSmokeDiagnosticPath(value);
  if (!isCompilerTargetCompilationSmokeDiagnostic(value) || !path || !checkedPaths.has(path)) {
    throw createCompilerInvariantFailure(
      'invalid-target-compilation-smoke-diagnostic',
      `${compiler}#${String(index)}`,
      `Target compiler ${compiler} returned an invalid or unmatched diagnostic at index ${String(index)}`,
    );
  }
  return {
    code: value.code.normalize('NFC'),
    column: value.column,
    line: value.line,
    message: value.message.normalize('NFC'),
    path,
  };
}

function getCompilerTargetCompilationSmokeDiagnosticPath(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || !('path' in value) || typeof value.path !== 'string') {
    return undefined;
  }
  try {
    return normalizeEmittedFilePath(value.path);
  } catch {
    return undefined;
  }
}

function validateCompilerTargetCompilationSmokeName(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value || /[\n\r\u2028\u2029]/u.test(value)) {
    throw createCompilerInvariantFailure(
      'invalid-target-compilation-smoke-adapter',
      typeof value === 'string' ? value : '<non-string>',
      'Target compiler names must be nonempty, unpadded, and single-line',
    );
  }
  return value.normalize('NFC');
}
