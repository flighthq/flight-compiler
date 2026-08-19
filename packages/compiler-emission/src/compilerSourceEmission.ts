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

export function createBackendEmissionFailure(backend: string, source: string, message: string): BackendEmissionFailure {
  const failure = Object.assign(new Error(`${backend} emission failed for ${source}: ${message}`), {
    backend,
    kind: 'backend-emission' as const,
    source,
  });
  failure.name = 'BackendEmissionError';
  return failure;
}

export function createCompilerInvariantFailure(
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

export function indentSourceLines(lines: readonly string[], depth = 1): string[] {
  const prefix = '  '.repeat(depth);
  return lines.map((line) => (line.length === 0 ? '' : `${prefix}${line}`));
}

export function isBackendEmissionFailure(value: unknown): value is BackendEmissionFailure {
  return (
    value instanceof Error &&
    'kind' in value &&
    value.kind === 'backend-emission' &&
    'backend' in value &&
    typeof value.backend === 'string' &&
    'source' in value &&
    typeof value.source === 'string'
  );
}

export function isCompilerInvariantFailure(value: unknown): value is CompilerInvariantFailure {
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
    normalizedPath.includes('\0') ||
    path.posix.isAbsolute(normalizedPath) ||
    path.win32.isAbsolute(file.path) ||
    /^[A-Za-z]:/u.test(file.path) ||
    normalizedPath.split('/').some(isUnsafePortablePathSegment)
  ) {
    throw createCompilerInvariantFailure(
      'unsafe-emitted-path',
      file.path,
      `Backend emitted an unsafe file path: ${file.path}`,
    );
  }
  return {
    contents: `${file.contents.replaceAll('\r\n', '\n').replaceAll('\r', '\n').trimEnd()}\n`,
    path: normalizedPath,
  };
}

function isUnsafePortablePathSegment(segment: string): boolean {
  return (
    segment === '' ||
    segment === '.' ||
    segment === '..' ||
    [...segment].some((character) => character.codePointAt(0)! <= 0x1f) ||
    /[<>:"|?*]/u.test(segment) ||
    /[ .]$/u.test(segment) ||
    /^(?:AUX|COM[1-9]|CON|LPT[1-9]|NUL|PRN)(?:\..*)?$/iu.test(segment)
  );
}
