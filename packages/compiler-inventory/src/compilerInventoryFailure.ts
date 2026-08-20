import type { CompilerInventoryFailure, CompilerInventoryFailureCode } from '../../compiler-types/src/index.js';

export function createCompilerInventoryFailure(
  code: CompilerInventoryFailureCode,
  subject: string,
  message: string,
  cause?: unknown,
): CompilerInventoryFailure {
  const failure = Object.assign(new Error(message, cause === undefined ? undefined : { cause }), {
    code,
    kind: 'compiler-inventory' as const,
    subject,
  });
  failure.name = 'CompilerInventoryError';
  return failure;
}

export function isCompilerInventoryFailure(value: unknown): value is CompilerInventoryFailure {
  return (
    value instanceof Error &&
    'kind' in value &&
    value.kind === 'compiler-inventory' &&
    'code' in value &&
    typeof value.code === 'string' &&
    Object.hasOwn(compilerInventoryFailureCodes, value.code) &&
    'subject' in value &&
    typeof value.subject === 'string'
  );
}

const compilerInventoryFailureCodes = {
  'duplicate-package-name': true,
  'invalid-package-directory': true,
  'invalid-package-manifest': true,
  'invalid-package-scope': true,
  'missing-packages-directory': true,
} as const satisfies Readonly<Record<CompilerInventoryFailureCode, true>>;
