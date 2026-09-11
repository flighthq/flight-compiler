import { isDeepStrictEqual } from 'node:util';

import { validateIrModuleStructure } from '../../compiler-ir-validation/src/index.js';
import type {
  CompilerLoweringFailure,
  CompilerLoweringFailureCode,
  CompilerLoweringPass,
  CompilerLoweringPassExecutionOptions,
  CompilerLoweringPassVerification,
  CompilerSourceIdentity,
  IrModule,
} from '../../compiler-types/src/index.js';

export function createCompilerLoweringFailure(
  code: CompilerLoweringFailureCode,
  pass: string,
  sourceIdentity: Readonly<CompilerSourceIdentity>,
  message: string,
  cause?: unknown,
): CompilerLoweringFailure {
  const subject = `${sourceIdentity.packageName}/${sourceIdentity.source}`;
  const failure = Object.assign(
    new Error(`Compiler lowering pass ${pass} failed for ${subject}: ${message}`, { cause }),
    {
      code,
      kind: 'compiler-lowering' as const,
      packageName: sourceIdentity.packageName,
      pass,
      source: sourceIdentity.source,
    },
  );
  failure.name = 'CompilerLoweringError';
  return failure;
}

export function isCompilerLoweringFailure(value: unknown): value is CompilerLoweringFailure {
  return (
    value instanceof Error &&
    'kind' in value &&
    value.kind === 'compiler-lowering' &&
    'code' in value &&
    typeof value.code === 'string' &&
    Object.hasOwn(compilerLoweringFailureCodes, value.code) &&
    'packageName' in value &&
    typeof value.packageName === 'string' &&
    'pass' in value &&
    typeof value.pass === 'string' &&
    'source' in value &&
    typeof value.source === 'string'
  );
}

export function lowerIrModuleWithCompilerPasses(
  module: Readonly<IrModule>,
  passes: readonly Readonly<CompilerLoweringPass>[],
  options: Readonly<CompilerLoweringPassExecutionOptions> = {},
): IrModule {
  validateCompilerLoweringPassExecutionOptions(module, options);
  validateCompilerLoweringPassOrder(module, passes);
  validateCompilerLoweringModule(module, module, 'lowering-plan');
  let lowered = structuredClone(module);
  for (const pass of passes) {
    const output = getCompilerLoweringPassOutput(module, lowered, pass);
    if (options.verificationDepth === 'idempotence' && pass.idempotent) {
      const repeated = getCompilerLoweringPassOutput(module, output, pass);
      if (!isDeepStrictEqual(output, repeated)) {
        throw createCompilerLoweringFailure(
          'non-idempotent-pass',
          pass.name,
          module,
          'the pass declares idempotence but a second application changed its output',
        );
      }
    }
    lowered = output;
  }
  return lowered;
}

function getCompilerLoweringPassOutput(
  sourceIdentity: Readonly<CompilerSourceIdentity>,
  module: Readonly<IrModule>,
  pass: Readonly<CompilerLoweringPass>,
): IrModule {
  try {
    const output = pass.lowerIrModule(module);
    validateCompilerLoweringModule(sourceIdentity, output, pass.name);
    if (output.name !== module.name || output.packageName !== module.packageName || output.source !== module.source) {
      throw createCompilerLoweringFailure(
        'malformed-ir',
        pass.name,
        sourceIdentity,
        'a target-neutral lowering pass must preserve module identity',
      );
    }
    const verification: unknown = pass.verifyIrModule(output);
    if (!isCompilerLoweringPassVerification(verification)) {
      throw new TypeError('lowering pass verification must be a valid or invalid tagged result');
    }
    if (verification.kind === 'invalid') {
      throw createCompilerLoweringFailure('malformed-ir', pass.name, sourceIdentity, verification.reason);
    }
    return output;
  } catch (error) {
    if (isCompilerLoweringFailure(error)) throw error;
    throw createCompilerLoweringFailure(
      'pass-execution-failed',
      pass.name,
      sourceIdentity,
      error instanceof Error ? error.message : String(error),
      error,
    );
  }
}

function validateCompilerLoweringModule(
  sourceIdentity: Readonly<CompilerSourceIdentity>,
  module: Readonly<IrModule>,
  pass: string,
): void {
  const structuralValidation = validateIrModuleStructure(module);
  if (structuralValidation.kind === 'invalid') {
    throw createCompilerLoweringFailure(
      'malformed-ir',
      pass,
      sourceIdentity,
      structuralValidation.failures
        .map((failure) => `${failure.code} at ${failure.path}: ${failure.reason}`)
        .join('; '),
    );
  }
}

function isCompilerLoweringPassVerification(value: unknown): value is CompilerLoweringPassVerification {
  return (
    typeof value === 'object' &&
    value !== null &&
    'kind' in value &&
    (value.kind === 'valid' ||
      (value.kind === 'invalid' && 'reason' in value && typeof value.reason === 'string' && value.reason.length > 0))
  );
}

function isCompilerLoweringPassIdentity(value: string): boolean {
  return /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(value);
}

function validateCompilerLoweringPassExecutionOptions(
  module: Readonly<IrModule>,
  options: Readonly<CompilerLoweringPassExecutionOptions>,
): void {
  if (
    options.verificationDepth !== undefined &&
    options.verificationDepth !== 'idempotence' &&
    options.verificationDepth !== 'output'
  ) {
    throw createCompilerLoweringFailure(
      'invalid-verification-depth',
      'lowering-plan',
      module,
      `unknown verification depth ${String(options.verificationDepth)}`,
    );
  }
}

function validateCompilerLoweringPassOrder(
  module: Readonly<IrModule>,
  passes: readonly Readonly<CompilerLoweringPass>[],
): void {
  const positions = new Map<string, number>();
  for (const [position, pass] of passes.entries()) {
    if (!isCompilerLoweringPassIdentity(pass.name)) {
      throw createCompilerLoweringFailure(
        'invalid-pass-identity',
        pass.name,
        module,
        `lowering pass names must be nonempty lowercase kebab-case identities: ${pass.name}`,
      );
    }
    const dependencies = new Set<string>();
    for (const predecessor of pass.runsAfter) {
      if (!isCompilerLoweringPassIdentity(predecessor) || dependencies.has(predecessor)) {
        throw createCompilerLoweringFailure(
          'invalid-pass-identity',
          pass.name,
          module,
          `${pass.name} has an invalid or duplicate predecessor identity: ${predecessor}`,
        );
      }
      dependencies.add(predecessor);
    }
    if (positions.has(pass.name)) {
      throw createCompilerLoweringFailure(
        'duplicate-pass-name',
        pass.name,
        module,
        `the lowering plan selects ${pass.name} more than once`,
      );
    }
    positions.set(pass.name, position);
  }
  for (const [position, pass] of passes.entries()) {
    for (const predecessor of pass.runsAfter) {
      const predecessorPosition = positions.get(predecessor);
      if (predecessorPosition === undefined) {
        throw createCompilerLoweringFailure(
          'invalid-pass-order',
          pass.name,
          module,
          `${pass.name} requires missing predecessor ${predecessor}`,
        );
      }
      if (predecessorPosition >= position) {
        throw createCompilerLoweringFailure(
          'invalid-pass-order',
          pass.name,
          module,
          `${pass.name} must run after ${predecessor}`,
        );
      }
    }
  }
}

const compilerLoweringFailureCodes: Readonly<Record<CompilerLoweringFailureCode, true>> = {
  'duplicate-pass-name': true,
  'invalid-pass-identity': true,
  'invalid-pass-order': true,
  'invalid-verification-depth': true,
  'malformed-ir': true,
  'non-idempotent-pass': true,
  'pass-execution-failed': true,
  'unsupported-ir': true,
};
