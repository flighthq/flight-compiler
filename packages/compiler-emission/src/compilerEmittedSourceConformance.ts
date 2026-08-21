import { compareTextCodeUnits } from '../../compiler-canonical-form/src/index.js';
import type {
  CompilerEmittedSourceConformanceDiagnostic,
  CompilerEmittedSourceConformanceFailure,
  CompilerEmittedSourceConformanceReport,
  CompilerEmittedSourceParser,
  CompilerEmittedSourceParserDiagnostic,
  EmittedFile,
} from '../../compiler-types/src/index.js';
import { createCompilerInvariantFailure, normalizeEmittedFile } from './compilerSourceEmission.js';

export function isCompilerEmittedSourceConformanceFailure(
  value: unknown,
): value is CompilerEmittedSourceConformanceFailure {
  return (
    value instanceof Error &&
    'kind' in value &&
    value.kind === 'emitted-source-conformance' &&
    'parser' in value &&
    typeof value.parser === 'string' &&
    value.parser.length > 0 &&
    'diagnostics' in value &&
    Array.isArray(value.diagnostics) &&
    value.diagnostics.every(isCompilerEmittedSourceConformanceDiagnostic)
  );
}

export function validateCompilerEmittedSourceConformance(
  files: readonly Readonly<EmittedFile>[],
  parser: Readonly<CompilerEmittedSourceParser>,
): CompilerEmittedSourceConformanceReport {
  const parserName = validateCompilerEmittedSourceParserName(parser.name);
  const diagnostics: CompilerEmittedSourceConformanceDiagnostic[] = [];
  let checkedFiles = 0;
  for (const input of files) {
    const file = Object.freeze(normalizeEmittedFile(input));
    const supported = parser.supportsEmittedSource(file);
    if (typeof supported !== 'boolean') {
      throw createCompilerInvariantFailure(
        'invalid-source-conformance-parser',
        parserName,
        `Emitted-source parser ${parserName} returned a non-boolean support decision for ${file.path}`,
      );
    }
    if (!supported) continue;
    checkedFiles += 1;
    const parsed = parser.parseEmittedSource(file);
    if (!Array.isArray(parsed)) {
      throw createCompilerInvariantFailure(
        'invalid-source-conformance-parser',
        parserName,
        `Emitted-source parser ${parserName} returned a non-array diagnostic result for ${file.path}`,
      );
    }
    parsed.forEach((diagnostic, index) => {
      diagnostics.push(normalizeCompilerEmittedSourceParserDiagnostic(diagnostic, file.path, index, parserName));
    });
  }
  diagnostics.sort(compareCompilerEmittedSourceConformanceDiagnostics);
  if (diagnostics.length > 0) throw createCompilerEmittedSourceConformanceFailure(parserName, diagnostics);
  return { checkedFiles, parser: parserName };
}

function compareCompilerEmittedSourceConformanceDiagnostics(
  left: Readonly<CompilerEmittedSourceConformanceDiagnostic>,
  right: Readonly<CompilerEmittedSourceConformanceDiagnostic>,
): number {
  return (
    compareTextCodeUnits(left.path, right.path) ||
    left.line - right.line ||
    left.column - right.column ||
    compareTextCodeUnits(left.code, right.code) ||
    compareTextCodeUnits(left.message, right.message)
  );
}

function createCompilerEmittedSourceConformanceFailure(
  parser: string,
  diagnostics: readonly Readonly<CompilerEmittedSourceConformanceDiagnostic>[],
): CompilerEmittedSourceConformanceFailure {
  const captured = diagnostics.map((diagnostic) => Object.freeze({ ...diagnostic }));
  const message = `Emitted-source parser ${parser} produced ${String(captured.length)} diagnostic(s):\n${captured
    .map(
      (diagnostic) =>
        `${diagnostic.path}:${String(diagnostic.line)}:${String(diagnostic.column)} [${diagnostic.code}] ${diagnostic.message}`,
    )
    .join('\n')}`;
  const failure = Object.assign(new Error(message), {
    diagnostics: Object.freeze(captured),
    kind: 'emitted-source-conformance' as const,
    parser,
  });
  failure.name = 'CompilerEmittedSourceConformanceError';
  return failure;
}

function isCompilerEmittedSourceConformanceDiagnostic(
  value: unknown,
): value is CompilerEmittedSourceConformanceDiagnostic {
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

function normalizeCompilerEmittedSourceParserDiagnostic(
  value: unknown,
  path: string,
  index: number,
  parser: string,
): CompilerEmittedSourceConformanceDiagnostic {
  if (!isCompilerEmittedSourceParserDiagnostic(value)) {
    const subject = `${parser}/${path}#${String(index)}`;
    throw createCompilerInvariantFailure(
      'invalid-source-conformance-diagnostic',
      subject,
      `Emitted-source parser ${parser} returned an invalid diagnostic for ${path} at index ${String(index)}`,
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

function isCompilerEmittedSourceParserDiagnostic(value: unknown): value is CompilerEmittedSourceParserDiagnostic {
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
    value.message.length > 0
  );
}

function validateCompilerEmittedSourceParserName(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value || /[\n\r\u2028\u2029]/u.test(value)) {
    throw createCompilerInvariantFailure(
      'invalid-source-conformance-parser',
      typeof value === 'string' ? value : '<non-string>',
      'Emitted-source parser names must be nonempty, unpadded, and single-line',
    );
  }
  return value.normalize('NFC');
}
