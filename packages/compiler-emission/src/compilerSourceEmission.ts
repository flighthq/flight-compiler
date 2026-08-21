import { normalizePathPortable } from '../../compiler-canonical-form/src/index.js';
import type {
  BackendEmissionFailure,
  BackendEmissionFailureCode,
  CompilerInvariantCode,
  CompilerInvariantFailure,
  CompilerSourceIdentity,
  EmittedFile,
} from '../../compiler-types/src/index.js';

export function createBackendEmissionFailure(
  backend: string,
  sourceIdentity: Readonly<CompilerSourceIdentity>,
  message: string,
): BackendEmissionFailure {
  const subject = `${sourceIdentity.packageName}/${sourceIdentity.source}`;
  const failure = Object.assign(new Error(`${backend} emission failed for ${subject}: ${message}`), {
    backend,
    code: 'unsupported-ir' as const,
    kind: 'backend-emission' as const,
    packageName: sourceIdentity.packageName,
    source: sourceIdentity.source,
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

export function convertEmittedFileContentsToUtf8(contents: string): Uint8Array {
  return new TextEncoder().encode(normalizeEmittedFileContents(contents));
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
    'code' in value &&
    typeof value.code === 'string' &&
    Object.hasOwn(backendEmissionFailureCodes, value.code) &&
    'packageName' in value &&
    typeof value.packageName === 'string' &&
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
  return {
    contents: normalizeEmittedFileContents(file.contents),
    path: normalizeEmittedFilePath(file.path),
  };
}

export function normalizeEmittedFileContents(contents: string): string {
  validateEmittedFileContents(contents);
  const lineNormalized = contents.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  return `${lineNormalized.replace(/\n+$/u, '')}\n`;
}

export function normalizeEmittedFilePath(value: string): string {
  const normalizedPath = normalizePathPortable(value).normalize('NFC');
  if (normalizedPath.split('/').some(isUnsafePortablePathSegment)) {
    throw createCompilerInvariantFailure('unsafe-emitted-path', value, `Backend emitted an unsafe file path: ${value}`);
  }
  return normalizedPath;
}

function isUnsafePortablePathSegment(segment: string): boolean {
  switch (segment) {
    case '':
    case '.':
    case '..':
      return true;
  }
  return (
    [...segment].some((character) => character.codePointAt(0)! <= 0x1f) ||
    /[<>:"|?*]/u.test(segment) ||
    /[ .]$/u.test(segment) ||
    /^(?:AUX|COM[1-9]|CON|LPT[1-9]|NUL|PRN)(?:\..*)?$/iu.test(segment)
  );
}

function validateEmittedFileContents(contents: string): void {
  if (contents.startsWith('\uFEFF')) {
    throw createCompilerInvariantFailure(
      'unsafe-emitted-contents',
      'byte-order-mark',
      'Backend emitted contents with a leading byte-order mark',
    );
  }
  let codeUnitIndex = 0;
  for (const character of contents) {
    const codeUnit = character.charCodeAt(0);
    if (character.length === 1 && codeUnit >= 0xd800 && codeUnit <= 0xdfff) {
      throwUnsafeSurrogate(codeUnitIndex);
    }
    codeUnitIndex += character.length;
  }
}

function throwUnsafeSurrogate(index: number): never {
  const subject = `unicode-code-unit:${String(index)}`;
  throw createCompilerInvariantFailure(
    'unsafe-emitted-contents',
    subject,
    `Backend emitted contents with an unpaired Unicode surrogate at code-unit index ${String(index)}`,
  );
}

const backendEmissionFailureCodes = {
  'unsupported-ir': true,
} as const satisfies Readonly<Record<BackendEmissionFailureCode, true>>;

const compilerInvariantCodes = {
  'duplicate-emitted-path': true,
  'duplicate-module-identity': true,
  'duplicate-target-name-identity': true,
  'invalid-generated-file-provenance': true,
  'invalid-target-name-candidate': true,
  'unsafe-emitted-contents': true,
  'unsafe-emitted-path': true,
} as const satisfies Readonly<Record<CompilerInvariantCode, true>>;
