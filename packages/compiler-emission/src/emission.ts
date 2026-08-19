import path from 'node:path';

import type {
  BackendEmissionFailure,
  CompilerInvariantCode,
  CompilerInvariantFailure,
  EmittedFile,
} from '../../compiler-types/src/index.js';

const compilerInvariantCodes = {
  'duplicate-emitted-path': true,
  'duplicate-module-identity': true,
  'unsafe-emitted-path': true,
} as const satisfies Readonly<Record<CompilerInvariantCode, true>>;

export function createBackendEmissionError(backend: string, source: string, message: string): BackendEmissionFailure {
  const failure = Object.assign(new Error(`${backend} emission failed for ${source}: ${message}`), {
    backend,
    kind: 'backend-emission' as const,
    source,
  });
  failure.name = 'BackendEmissionError';
  return failure;
}

export function createCompilerInvariantError(
  code: CompilerInvariantCode,
  subject: string,
  message: string,
): CompilerInvariantFailure {
  const failure = Object.assign(new Error(message), {
    code,
    kind: 'compiler-invariant' as const,
    subject,
  });
  failure.name = 'CompilerInvariantError';
  return failure;
}

export function indentSource(lines: readonly string[], depth = 1): string[] {
  const prefix = '  '.repeat(depth);
  return lines.map((line) => (line.length === 0 ? '' : `${prefix}${line}`));
}

export function isBackendEmissionError(value: unknown): value is BackendEmissionFailure {
  return value instanceof Error && 'kind' in value && value.kind === 'backend-emission';
}

export function isCompilerInvariantError(value: unknown): value is CompilerInvariantFailure {
  return (
    value instanceof Error &&
    'kind' in value &&
    value.kind === 'compiler-invariant' &&
    'code' in value &&
    typeof value.code === 'string' &&
    Object.hasOwn(compilerInvariantCodes, value.code) &&
    'subject' in value &&
    typeof value.subject === 'string'
  );
}

export function normalizeEmittedFile(file: Readonly<EmittedFile>): EmittedFile {
  const normalizedPath = file.path.replaceAll('\\', '/');
  if (
    normalizedPath.length === 0 ||
    path.posix.isAbsolute(normalizedPath) ||
    normalizedPath.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw createCompilerInvariantError(
      'unsafe-emitted-path',
      file.path,
      `Backend emitted an unsafe file path: ${file.path}`,
    );
  }
  return {
    contents: `${file.contents.replaceAll('\r\n', '\n').trimEnd()}\n`,
    path: normalizedPath,
  };
}
