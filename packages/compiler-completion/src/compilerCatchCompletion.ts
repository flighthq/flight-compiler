import type {
  CompilerCatchBindingInitialization,
  CompilerCatchBindingPresence,
  CompilerCatchCompletionFailure,
  CompilerCatchCompletionFailureCode,
  CompilerCompletionSet,
  IrCatchSemantics,
} from '../../compiler-types/src/index.js';
import { combineCompilerCompletionSetsAlternatively, createCompilerCompletionSet } from './compilerCompletionSet.js';

export function applyCompilerCompletionSetCatchReplacement(
  tryCompletion: Readonly<CompilerCompletionSet>,
  catchCompletion: Readonly<CompilerCompletionSet>,
): CompilerCompletionSet {
  const normalized = [tryCompletion, catchCompletion].map((set) => combineCompilerCompletionSetsAlternatively([set]));
  const incoming = normalized[0]!;
  const handler = normalized[1]!;
  if (!incoming.completions.some((completion) => completion.kind === 'throw')) return incoming;
  const uncaught = createCompilerCompletionSet(
    incoming.completions.filter((completion) => completion.kind !== 'throw'),
  );
  return combineCompilerCompletionSetsAlternatively([uncaught, handler]);
}

export function createIrCatchSemantics(bindingPresence: CompilerCatchBindingPresence): IrCatchSemantics {
  if (!compilerCatchBindingPresences.has(bindingPresence)) {
    throw createCompilerCatchCompletionFailure();
  }
  const bindingInitialization: CompilerCatchBindingInitialization = Object.freeze(
    bindingPresence === 'present'
      ? { kind: 'initialize', source: 'thrown-value', timing: 'before-body' }
      : { kind: 'discard' },
  );
  return Object.freeze({
    bindingInitialization,
    bodyExecution: 'once-per-caught-throw',
    catchCompletion: 'propagate',
    interceptedCompletion: 'throw',
    schema: 'flight-compiler-catch-semantics/1',
    uncaughtCompletion: 'preserve',
  });
}

export function isCompilerCatchCompletionFailure(value: unknown): value is CompilerCatchCompletionFailure {
  return (
    value instanceof Error &&
    'kind' in value &&
    value.kind === 'compiler-catch-completion' &&
    'code' in value &&
    compilerCatchCompletionFailureCodes.has(value.code as CompilerCatchCompletionFailureCode) &&
    'path' in value &&
    Array.isArray(value.path) &&
    value.path.every((segment) => typeof segment === 'string' || typeof segment === 'number')
  );
}

export function isIrCatchSemantics(value: unknown): value is IrCatchSemantics {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 6) return false;
  if (!('bindingInitialization' in value) || !isCompilerCatchBindingInitialization(value.bindingInitialization)) {
    return false;
  }
  return (
    'bodyExecution' in value &&
    value.bodyExecution === 'once-per-caught-throw' &&
    'catchCompletion' in value &&
    value.catchCompletion === 'propagate' &&
    'interceptedCompletion' in value &&
    value.interceptedCompletion === 'throw' &&
    'schema' in value &&
    value.schema === 'flight-compiler-catch-semantics/1' &&
    'uncaughtCompletion' in value &&
    value.uncaughtCompletion === 'preserve'
  );
}

function isCompilerCatchBindingInitialization(value: unknown): value is CompilerCatchBindingInitialization {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !('kind' in value)) return false;
  if (value.kind === 'discard') return Object.keys(value).length === 1;
  return (
    value.kind === 'initialize' &&
    Object.keys(value).length === 3 &&
    'source' in value &&
    value.source === 'thrown-value' &&
    'timing' in value &&
    value.timing === 'before-body'
  );
}

function createCompilerCatchCompletionFailure(): CompilerCatchCompletionFailure {
  const failure = Object.assign(new Error('Catch binding presence must be absent or present'), {
    code: 'invalid-binding-presence' as const,
    kind: 'compiler-catch-completion' as const,
    path: Object.freeze(['bindingPresence']),
  });
  failure.name = 'CompilerCatchCompletionError';
  return failure;
}

const compilerCatchBindingPresences = new Set<CompilerCatchBindingPresence>(['absent', 'present']);

const compilerCatchCompletionFailureCodes = new Set<CompilerCatchCompletionFailureCode>(['invalid-binding-presence']);
