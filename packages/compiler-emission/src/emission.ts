import path from 'node:path';

import type { BackendEmissionFailure, EmittedFile } from '../../compiler-types/src/index.js';

export function createBackendEmissionError(backend: string, source: string, message: string): BackendEmissionFailure {
  const failure = Object.assign(new Error(`${backend} emission failed for ${source}: ${message}`), {
    backend,
    kind: 'backend-emission' as const,
    source,
  });
  failure.name = 'BackendEmissionError';
  return failure;
}

export function isBackendEmissionError(value: unknown): value is BackendEmissionFailure {
  return value instanceof Error && 'kind' in value && value.kind === 'backend-emission';
}

export function indentSource(lines: readonly string[], depth = 1): string[] {
  const prefix = '  '.repeat(depth);
  return lines.map((line) => (line.length === 0 ? '' : `${prefix}${line}`));
}

export function normalizeEmittedFile(file: Readonly<EmittedFile>): EmittedFile {
  const normalizedPath = file.path.replaceAll('\\', '/');
  if (
    normalizedPath.length === 0 ||
    path.posix.isAbsolute(normalizedPath) ||
    normalizedPath.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new Error(`Backend emitted an unsafe file path: ${file.path}`);
  }
  return {
    contents: `${file.contents.replaceAll('\r\n', '\n').trimEnd()}\n`,
    path: normalizedPath,
  };
}
