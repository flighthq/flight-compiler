import { compareTextCodeUnits } from '../../compiler-canonical-form/src/index.js';
import type {
  CompilerCompletion,
  CompilerCompletionFailure,
  CompilerCompletionFailureCode,
  CompilerCompletionKind,
  CompilerCompletionSet,
} from '../../compiler-types/src/index.js';

export function combineCompilerCompletionSetsAlternatively(
  sets: readonly Readonly<CompilerCompletionSet>[],
): CompilerCompletionSet {
  validateCompilerCompletionSetList(sets);
  return createCompilerCompletionSet(sets.flatMap((set, index) => validateCompilerCompletionSet(set, index)));
}

export function combineCompilerCompletionSetsSequentially(
  sets: readonly Readonly<CompilerCompletionSet>[],
): CompilerCompletionSet {
  validateCompilerCompletionSetList(sets);
  const validated = sets.map((set, index) => validateCompilerCompletionSet(set, index));
  let completions: readonly CompilerCompletion[] = [{ kind: 'normal' }];
  for (const next of validated) {
    if (!completions.some((completion) => completion.kind === 'normal')) break;
    completions = [...completions.filter((completion) => completion.kind !== 'normal'), ...next];
  }
  return createCompilerCompletionSet(completions);
}

export function createCompilerCompletionSet(
  completions: readonly Readonly<CompilerCompletion>[],
): CompilerCompletionSet {
  if (!Array.isArray(completions)) {
    throw createCompilerCompletionFailure(
      'invalid-completion-set',
      ['completions'],
      'Completion set input must be an array',
    );
  }
  const unique = new Map<string, CompilerCompletion>();
  completions.forEach((completion, index) => {
    validateCompilerCompletion(completion, ['completions', index]);
    const normalized = Object.freeze(
      (completion.kind === 'break' || completion.kind === 'continue') && completion.target !== undefined
        ? { kind: completion.kind, target: completion.target }
        : { kind: completion.kind },
    );
    unique.set(getCompilerCompletionIdentity(normalized), normalized);
  });
  return Object.freeze({
    completions: Object.freeze([...unique.values()].sort(compareCompilerCompletions)),
    schema: 'flight-compiler-completion-set/1',
  });
}

export function isCompilerCompletionFailure(value: unknown): value is CompilerCompletionFailure {
  return (
    value instanceof Error &&
    'kind' in value &&
    value.kind === 'compiler-completion' &&
    'code' in value &&
    compilerCompletionFailureCodes.has(value.code as CompilerCompletionFailureCode) &&
    'path' in value &&
    Array.isArray(value.path) &&
    value.path.every((segment) => typeof segment === 'string' || typeof segment === 'number')
  );
}

function validateCompilerCompletionSet(
  set: Readonly<CompilerCompletionSet>,
  index: number,
): readonly CompilerCompletion[] {
  if (
    !set ||
    typeof set !== 'object' ||
    set.schema !== 'flight-compiler-completion-set/1' ||
    !Array.isArray(set.completions)
  ) {
    throw createCompilerCompletionFailure(
      'invalid-completion-set',
      ['sets', index],
      `Completion set ${String(index)} does not use flight-compiler-completion-set/1`,
    );
  }
  set.completions.forEach((completion, completionIndex) =>
    validateCompilerCompletion(completion, ['sets', index, 'completions', completionIndex]),
  );
  return set.completions;
}

function validateCompilerCompletionSetList(sets: readonly Readonly<CompilerCompletionSet>[]): void {
  if (!Array.isArray(sets)) {
    throw createCompilerCompletionFailure('invalid-completion-set', ['sets'], 'Completion sets must be an array');
  }
}

function validateCompilerCompletion(
  completion: Readonly<CompilerCompletion>,
  path: readonly (number | string)[],
): void {
  if (!completion || typeof completion !== 'object' || !compilerCompletionKinds.has(completion.kind)) {
    throw createCompilerCompletionFailure('invalid-completion', path, 'Completion must use one exact known kind');
  }
  const keys = Object.keys(completion);
  if (completion.kind === 'break' || completion.kind === 'continue') {
    if (keys.some((key) => key !== 'kind' && key !== 'target')) {
      throw createCompilerCompletionFailure('invalid-completion', path, 'Targeted completion has unknown fields');
    }
    if (completion.target !== undefined && (typeof completion.target !== 'string' || completion.target.length === 0)) {
      throw createCompilerCompletionFailure(
        'invalid-completion-target',
        [...path, 'target'],
        'Break and continue targets must be nonempty identities',
      );
    }
    return;
  }
  if (keys.length !== 1 || keys[0] !== 'kind') {
    throw createCompilerCompletionFailure('invalid-completion', path, 'Untargeted completion has unknown fields');
  }
}

function compareCompilerCompletions(left: CompilerCompletion, right: CompilerCompletion): number {
  const kind = compilerCompletionKindOrder.get(left.kind)! - compilerCompletionKindOrder.get(right.kind)!;
  if (kind !== 0) return kind;
  return compareTextCodeUnits(getCompilerCompletionIdentity(left), getCompilerCompletionIdentity(right));
}

function getCompilerCompletionIdentity(completion: CompilerCompletion): string {
  return completion.kind === 'break' || completion.kind === 'continue'
    ? `${completion.kind}:${completion.target ?? ''}`
    : completion.kind;
}

function createCompilerCompletionFailure(
  code: CompilerCompletionFailureCode,
  path: readonly (number | string)[],
  message: string,
): CompilerCompletionFailure {
  const failure = Object.assign(new Error(message), {
    code,
    kind: 'compiler-completion' as const,
    path: Object.freeze([...path]),
  });
  failure.name = 'CompilerCompletionError';
  return failure;
}

const compilerCompletionKinds = new Set<CompilerCompletionKind>(['break', 'continue', 'normal', 'return', 'throw']);

const compilerCompletionKindOrder = new Map<CompilerCompletionKind, number>([
  ['normal', 0],
  ['break', 1],
  ['continue', 2],
  ['return', 3],
  ['throw', 4],
]);

const compilerCompletionFailureCodes = new Set<CompilerCompletionFailureCode>([
  'invalid-completion',
  'invalid-completion-set',
  'invalid-completion-target',
]);
