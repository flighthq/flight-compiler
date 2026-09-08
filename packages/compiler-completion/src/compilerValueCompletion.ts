import { compareTextCodeUnits } from '../../compiler-canonical-form/src/index.js';
import type {
  IrBindingIdentity,
  CompilerCompletionKind,
  CompilerCompletionValueSource,
  CompilerValueCompletionCatchReplacement,
  CompilerValueCompletionFailure,
  CompilerValueCompletionFailureCode,
  CompilerValueCompletionPath,
  CompilerValueCompletionPathSet,
} from '../../compiler-types/src/index.js';

export function applyCompilerValueCompletionPathSetCatchReplacement(
  tryCompletion: Readonly<CompilerValueCompletionPathSet>,
  catchCompletion: Readonly<CompilerValueCompletionPathSet>,
): CompilerValueCompletionCatchReplacement {
  const incoming = combineCompilerValueCompletionPathSetsAlternatively([tryCompletion]);
  const handler = combineCompilerValueCompletionPathSetsAlternatively([catchCompletion]);
  const thrown = incoming.paths.filter((completion) => completion.kind === 'throw');
  const completions =
    thrown.length === 0
      ? incoming
      : combineCompilerValueCompletionPathSetsAlternatively([
          createCompilerValueCompletionPathSet(incoming.paths.filter((completion) => completion.kind !== 'throw')),
          handler,
        ]);
  return cloneCompilerValueCompletionValue({
    completions,
    interceptions: thrown.map((completion) => ({ path: completion.path, value: completion.value })),
    schema: 'flight-compiler-value-completion-catch-replacement/1' as const,
  });
}

export function applyCompilerValueCompletionPathSetFinallyReplacement(
  completion: Readonly<CompilerValueCompletionPathSet>,
  finallyCompletion: Readonly<CompilerValueCompletionPathSet>,
): CompilerValueCompletionPathSet {
  const incoming = combineCompilerValueCompletionPathSetsAlternatively([completion]);
  const finalizer = combineCompilerValueCompletionPathSetsAlternatively([finallyCompletion]);
  return createCompilerValueCompletionPathSet(
    incoming.paths.flatMap((prior) =>
      finalizer.paths.map((cleanup) =>
        cleanup.kind === 'normal' ? prior : createCompilerValueCompletionPathUpdated(cleanup, prior.value),
      ),
    ),
  );
}

export function combineCompilerValueCompletionPathSetsAlternatively(
  sets: readonly Readonly<CompilerValueCompletionPathSet>[],
): CompilerValueCompletionPathSet {
  return createCompilerValueCompletionPathSet(
    validateCompilerValueCompletionPathSetList(sets).flatMap((set) => set.paths),
  );
}

export function combineCompilerValueCompletionPathSetsSequentially(
  sets: readonly Readonly<CompilerValueCompletionPathSet>[],
): CompilerValueCompletionPathSet {
  const validated = validateCompilerValueCompletionPathSetList(sets);
  let paths: readonly CompilerValueCompletionPath[] = createCompilerValueCompletionPathSet([
    { kind: 'normal', path: [], value: { kind: 'empty' } },
  ]).paths;
  for (const next of validated) {
    const normal = paths.filter((completion) => completion.kind === 'normal');
    if (normal.length === 0) break;
    paths = createCompilerValueCompletionPathSet([
      ...paths.filter((completion) => completion.kind !== 'normal'),
      ...normal.flatMap((prior) =>
        next.paths.map((completion) => createCompilerValueCompletionPathUpdated(completion, prior.value)),
      ),
    ]).paths;
  }
  return createCompilerValueCompletionPathSet(paths);
}

export function createCompilerValueCompletionPathSet(
  paths: readonly Readonly<CompilerValueCompletionPath>[],
): CompilerValueCompletionPathSet {
  if (!Array.isArray(paths)) {
    throw createCompilerValueCompletionFailure('invalid-path-set', ['paths'], 'Completion paths must be an array');
  }
  const unique = new Map<string, CompilerValueCompletionPath>();
  paths.forEach((completion, index) => {
    const normalized = normalizeCompilerValueCompletionPath(completion, ['paths', index]);
    unique.set(getCompilerValueCompletionPathIdentity(normalized), normalized);
  });
  return Object.freeze({
    paths: Object.freeze([...unique.values()].sort(compareCompilerValueCompletionPaths)),
    schema: 'flight-compiler-value-completion-path-set/1',
  });
}

export function isCompilerValueCompletionFailure(value: unknown): value is CompilerValueCompletionFailure {
  return (
    value instanceof Error &&
    'kind' in value &&
    value.kind === 'compiler-value-completion' &&
    'code' in value &&
    compilerValueCompletionFailureCodes.has(value.code as CompilerValueCompletionFailureCode) &&
    'path' in value &&
    isCompilerValueCompletionTraversalPath(value.path)
  );
}

function cloneCompilerValueCompletionValue<Value>(value: Value): Value {
  const clone = structuredClone(value);
  freezeCompilerValueCompletionValue(clone, new WeakSet());
  return clone;
}

function compareCompilerValueCompletionPaths(
  left: Readonly<CompilerValueCompletionPath>,
  right: Readonly<CompilerValueCompletionPath>,
): number {
  const kind = compilerValueCompletionKindOrder.get(left.kind)! - compilerValueCompletionKindOrder.get(right.kind)!;
  return kind === 0
    ? compareTextCodeUnits(getCompilerValueCompletionPathIdentity(left), getCompilerValueCompletionPathIdentity(right))
    : kind;
}

function createCompilerValueCompletionFailure(
  code: CompilerValueCompletionFailureCode,
  path: readonly (number | string)[],
  message: string,
): CompilerValueCompletionFailure {
  const failure = Object.assign(new Error(message), {
    code,
    kind: 'compiler-value-completion' as const,
    path: Object.freeze([...path]),
  });
  failure.name = 'CompilerValueCompletionError';
  return failure;
}

function createCompilerValueCompletionPathUpdated(
  completion: Readonly<CompilerValueCompletionPath>,
  prior: Readonly<CompilerCompletionValueSource>,
): CompilerValueCompletionPath {
  return completion.value.kind === 'empty' ? { ...completion, value: prior } : completion;
}

function freezeCompilerValueCompletionValue(value: unknown, seen: WeakSet<object>): void {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  for (const child of Object.values(value)) freezeCompilerValueCompletionValue(child, seen);
  Object.freeze(value);
}

function getCompilerValueCompletionPathIdentity(completion: Readonly<CompilerValueCompletionPath>): string {
  return JSON.stringify(completion);
}

function isCompilerValueCompletionCarriedBinding(value: unknown): value is IrBindingIdentity {
  return (
    !!value &&
    typeof value === 'object' &&
    'id' in value &&
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    'name' in value &&
    typeof value.name === 'string'
  );
}

function isCompilerValueCompletionTraversalPath(value: unknown): value is readonly (number | string)[] {
  return (
    Array.isArray(value) &&
    value.every(
      (segment) =>
        (typeof segment === 'string' && segment.length > 0) ||
        (typeof segment === 'number' && Number.isSafeInteger(segment) && segment >= 0),
    )
  );
}

function normalizeCompilerCompletionValueSource(
  value: Readonly<CompilerCompletionValueSource>,
  path: readonly (number | string)[],
): CompilerCompletionValueSource {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !('kind' in value)) {
    throw createCompilerValueCompletionFailure('invalid-completion-value', path, 'Completion value must be a record');
  }
  if (value.kind === 'empty' || value.kind === 'implicitUndefined') {
    if (Object.keys(value).length !== 1) {
      throw createCompilerValueCompletionFailure(
        'invalid-completion-value',
        path,
        'Empty and implicit undefined values have no additional fields',
      );
    }
    return Object.freeze({ kind: value.kind });
  }
  if (value.kind === 'carried') {
    // A carried value names a binding the machine introduced rather than a place in the source, so
    // it has an identity to check instead of a path.
    if (Object.keys(value).length !== 2 || !isCompilerValueCompletionCarriedBinding(value.binding)) {
      throw createCompilerValueCompletionFailure(
        'invalid-completion-value',
        path,
        'Carried values require exactly one binding identity',
      );
    }
    return Object.freeze({ binding: Object.freeze({ ...value.binding }), kind: 'carried' });
  }
  if (
    value.kind !== 'expression' ||
    Object.keys(value).length !== 3 ||
    !isCompilerValueCompletionTraversalPath(value.path) ||
    (value.phase !== 'abrupt' && value.phase !== 'result')
  ) {
    throw createCompilerValueCompletionFailure(
      'invalid-completion-value',
      path,
      'Expression values require an exact path and abrupt or result phase',
    );
  }
  return Object.freeze({ kind: 'expression', path: Object.freeze([...value.path]), phase: value.phase });
}

function normalizeCompilerValueCompletionPath(
  completion: Readonly<CompilerValueCompletionPath>,
  path: readonly (number | string)[],
): CompilerValueCompletionPath {
  if (
    !completion ||
    typeof completion !== 'object' ||
    Array.isArray(completion) ||
    !compilerValueCompletionKinds.has(completion.kind)
  ) {
    throw createCompilerValueCompletionFailure(
      'invalid-completion-kind',
      path,
      'Completion must use one exact known kind',
    );
  }
  if (!isCompilerValueCompletionTraversalPath(completion.path)) {
    throw createCompilerValueCompletionFailure(
      'invalid-completion-path',
      [...path, 'path'],
      'Completion path must contain nonempty properties and nonnegative safe indices',
    );
  }
  const value = normalizeCompilerCompletionValueSource(completion.value, [...path, 'value']);
  const targeted = completion.kind === 'break' || completion.kind === 'continue';
  const keys = Object.keys(completion);
  if (targeted) {
    if (keys.some((key) => key !== 'kind' && key !== 'path' && key !== 'target' && key !== 'value')) {
      throw createCompilerValueCompletionFailure(
        'invalid-completion-kind',
        path,
        'Targeted completion has unknown fields',
      );
    }
    if (completion.target !== undefined && (typeof completion.target !== 'string' || completion.target.length === 0)) {
      throw createCompilerValueCompletionFailure(
        'invalid-completion-target',
        [...path, 'target'],
        'Break and continue targets must be nonempty identities',
      );
    }
    return Object.freeze({
      kind: completion.kind,
      path: Object.freeze([...completion.path]),
      ...(completion.target === undefined ? {} : { target: completion.target }),
      value,
    });
  }
  if (keys.length !== 3 || keys.some((key) => key !== 'kind' && key !== 'path' && key !== 'value')) {
    throw createCompilerValueCompletionFailure(
      'invalid-completion-kind',
      path,
      'Untargeted completion has unknown fields',
    );
  }
  return Object.freeze({ kind: completion.kind, path: Object.freeze([...completion.path]), value });
}

function validateCompilerValueCompletionPathSet(
  set: Readonly<CompilerValueCompletionPathSet>,
  index: number,
): CompilerValueCompletionPathSet {
  if (
    !set ||
    typeof set !== 'object' ||
    Array.isArray(set) ||
    set.schema !== 'flight-compiler-value-completion-path-set/1' ||
    !Array.isArray(set.paths)
  ) {
    throw createCompilerValueCompletionFailure(
      'invalid-path-set',
      ['sets', index],
      `Completion path set ${String(index)} does not use flight-compiler-value-completion-path-set/1`,
    );
  }
  return createCompilerValueCompletionPathSet(set.paths);
}

function validateCompilerValueCompletionPathSetList(
  sets: readonly Readonly<CompilerValueCompletionPathSet>[],
): readonly CompilerValueCompletionPathSet[] {
  if (!Array.isArray(sets)) {
    throw createCompilerValueCompletionFailure('invalid-path-set', ['sets'], 'Completion path sets must be an array');
  }
  return sets.map(validateCompilerValueCompletionPathSet);
}

const compilerValueCompletionFailureCodes = new Set<CompilerValueCompletionFailureCode>([
  'invalid-completion-kind',
  'invalid-completion-path',
  'invalid-completion-target',
  'invalid-completion-value',
  'invalid-path-set',
]);

const compilerValueCompletionKinds = new Set<CompilerCompletionKind>([
  'break',
  'continue',
  'normal',
  'return',
  'throw',
]);

const compilerValueCompletionKindOrder = new Map<CompilerCompletionKind, number>([
  ['normal', 0],
  ['break', 1],
  ['continue', 2],
  ['return', 3],
  ['throw', 4],
]);
