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
  'ambiguous-export': true,
  'duplicate-package-name': true,
  'invalid-git-commit': true,
  'invalid-host-endpoint-receiver': true,
  'invalid-package-directory': true,
  'invalid-package-export': true,
  'invalid-package-manifest': true,
  'invalid-package-scope': true,
  'invalid-source-path': true,
  'invalid-typescript-project': true,
  'missing-package-export': true,
  'missing-packages-directory': true,
  'missing-sdk-package': true,
  'package-exclusion-drift': true,
  'runtime-export-classification': true,
  'unknown-package': true,
  'unresolved-export': true,
  'unresolved-source': true,
  'unsupported-package-specifier': true,
  'unsupported-dynamic-import': true,
} as const satisfies Readonly<Record<CompilerInventoryFailureCode, true>>;
