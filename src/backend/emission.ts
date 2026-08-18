import path from 'node:path';

import type { EmittedFile } from '../model/backend.ts';

export class BackendEmissionError extends Error {
  constructor(backend: string, source: string, message: string) {
    super(`${backend} emission failed for ${source}: ${message}`);
  }
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
