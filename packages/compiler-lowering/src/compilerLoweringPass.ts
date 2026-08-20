import { isDeepStrictEqual } from 'node:util';

import type {
  CompilerLoweringFailure,
  CompilerLoweringFailureCode,
  CompilerLoweringPass,
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
): IrModule {
  validateCompilerLoweringPassOrder(module, passes);
  let lowered = structuredClone(module);
  for (const pass of passes) {
    const output = getCompilerLoweringPassOutput(module, lowered, pass);
    if (pass.idempotent) {
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
    const output = pass.lowerIrModule(structuredClone(module));
    const verification = pass.verifyIrModule(structuredClone(output));
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

function validateCompilerLoweringPassOrder(
  module: Readonly<IrModule>,
  passes: readonly Readonly<CompilerLoweringPass>[],
): void {
  const positions = new Map<string, number>();
  for (const [position, pass] of passes.entries()) {
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
      if (predecessor === pass.name || (predecessorPosition !== undefined && predecessorPosition > position)) {
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
  'invalid-pass-order': true,
  'malformed-ir': true,
  'non-idempotent-pass': true,
  'pass-execution-failed': true,
  'unsupported-ir': true,
};
