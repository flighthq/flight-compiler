import type {
  CompilerAsyncTaskCompletionFailure,
  CompilerAsyncTaskCompletionFailureCode,
  CompilerAsyncTaskCompletionPlan,
  CompilerAsyncTaskSettlement,
  CompilerCompletionSet,
  IrAwaitSemantics,
} from '../../compiler-types/src/index.js';
import { combineCompilerCompletionSetsAlternatively } from './compilerCompletionSet.js';

export function createCompilerAsyncTaskCompletionPlan(
  bodyCompletion: Readonly<CompilerCompletionSet>,
): CompilerAsyncTaskCompletionPlan {
  const normalized = combineCompilerCompletionSetsAlternatively([bodyCompletion]);
  const settlements: CompilerAsyncTaskSettlement[] = [];
  normalized.completions.forEach((completion, index) => {
    switch (completion.kind) {
      case 'normal':
        settlements.push(Object.freeze({ kind: 'resolve', source: 'implicit-undefined' }));
        break;
      case 'return':
        settlements.push(Object.freeze({ kind: 'resolve', source: 'return-value' }));
        break;
      case 'throw':
        settlements.push(Object.freeze({ kind: 'reject', source: 'thrown-value' }));
        break;
      case 'break':
      case 'continue':
        throw createCompilerAsyncTaskCompletionFailure(completion.kind, completion.target, index);
    }
  });
  return Object.freeze({
    bodyStart: 'synchronous-until-suspension',
    resolution: 'normalize-value-task-or-thenable',
    schema: 'flight-compiler-async-task-completion/1',
    settlements: Object.freeze(settlements),
    taskCreation: 'before-body',
  });
}

export function createIrAwaitSemantics(): IrAwaitSemantics {
  return Object.freeze({
    continuation: 'enqueue-after-settlement',
    fulfillment: 'resume-normal-with-value',
    operandEvaluation: 'once-before-suspension',
    rejection: 'resume-throw-with-reason',
    schema: 'flight-compiler-await-semantics/1',
    suspension: 'always-before-continuation',
    taskResolution: 'normalize-value-task-or-thenable',
  });
}

export function isCompilerAsyncTaskCompletionFailure(value: unknown): value is CompilerAsyncTaskCompletionFailure {
  return (
    value instanceof Error &&
    'kind' in value &&
    value.kind === 'compiler-async-task-completion' &&
    'code' in value &&
    compilerAsyncTaskCompletionFailureCodes.has(value.code as CompilerAsyncTaskCompletionFailureCode) &&
    'completion' in value &&
    (value.completion === 'break' || value.completion === 'continue') &&
    'path' in value &&
    Array.isArray(value.path) &&
    value.path.every((segment) => typeof segment === 'string' || typeof segment === 'number') &&
    (!('target' in value) ||
      value.target === undefined ||
      (typeof value.target === 'string' && value.target.length > 0))
  );
}

export function isIrAwaitSemantics(value: unknown): value is IrAwaitSemantics {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === 7 &&
    'continuation' in value &&
    value.continuation === 'enqueue-after-settlement' &&
    'fulfillment' in value &&
    value.fulfillment === 'resume-normal-with-value' &&
    'operandEvaluation' in value &&
    value.operandEvaluation === 'once-before-suspension' &&
    'rejection' in value &&
    value.rejection === 'resume-throw-with-reason' &&
    'schema' in value &&
    value.schema === 'flight-compiler-await-semantics/1' &&
    'suspension' in value &&
    value.suspension === 'always-before-continuation' &&
    'taskResolution' in value &&
    value.taskResolution === 'normalize-value-task-or-thenable'
  );
}

function createCompilerAsyncTaskCompletionFailure(
  completion: 'break' | 'continue',
  target: string | undefined,
  index: number,
): CompilerAsyncTaskCompletionFailure {
  const failure = Object.assign(new Error(`${completion} completion cannot escape an async function body`), {
    code: 'escaping-control-flow' as const,
    completion,
    kind: 'compiler-async-task-completion' as const,
    path: Object.freeze(['bodyCompletion', 'completions', index]),
    ...(target === undefined ? {} : { target }),
  });
  failure.name = 'CompilerAsyncTaskCompletionError';
  return failure;
}

const compilerAsyncTaskCompletionFailureCodes = new Set<CompilerAsyncTaskCompletionFailureCode>([
  'escaping-control-flow',
]);
