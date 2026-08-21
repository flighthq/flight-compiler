interface CompilerVariableInitializationCompletion {
  readonly break?: ReadonlySet<string>;
  readonly continue?: ReadonlySet<string>;
  readonly normal?: ReadonlySet<string>;
  readonly return?: ReadonlySet<string>;
  readonly throw?: ReadonlySet<string>;
}

type CompilerVariableInitializationCompletionKind = keyof CompilerVariableInitializationCompletion;

export function combineCompilerVariableInitializationCompletionStates(
  completion: Readonly<CompilerVariableInitializationCompletion>,
): Set<string> | undefined {
  let initialized: Set<string> | undefined;
  for (const kind of compilerVariableInitializationCompletionKinds) {
    initialized = combineCompilerVariableInitializationSets(initialized, completion[kind]);
  }
  return initialized;
}

export function combineCompilerVariableInitializationSets(
  left: ReadonlySet<string> | undefined,
  right: ReadonlySet<string> | undefined,
): Set<string> | undefined {
  if (!left) return right ? new Set(right) : undefined;
  if (!right) return new Set(left);
  return new Set([...left].filter((identity) => right.has(identity)));
}

export function createCompilerVariableInitializationCompletionAlternative(
  left: Readonly<CompilerVariableInitializationCompletion>,
  right: Readonly<CompilerVariableInitializationCompletion>,
): CompilerVariableInitializationCompletion {
  return {
    ...createCompilerVariableInitializationCompletionKind('break', left.break, right.break),
    ...createCompilerVariableInitializationCompletionKind('continue', left.continue, right.continue),
    ...createCompilerVariableInitializationCompletionKind('normal', left.normal, right.normal),
    ...createCompilerVariableInitializationCompletionKind('return', left.return, right.return),
    ...createCompilerVariableInitializationCompletionKind('throw', left.throw, right.throw),
  };
}

export function createCompilerVariableInitializationCompletionWithState(
  completion: Readonly<CompilerVariableInitializationCompletion>,
  kind: CompilerVariableInitializationCompletionKind,
  initialized: ReadonlySet<string> | undefined,
): CompilerVariableInitializationCompletion {
  if (!initialized) return completion;
  return createCompilerVariableInitializationCompletionAlternative(completion, {
    [kind]: initialized,
  });
}

function createCompilerVariableInitializationCompletionKind(
  kind: CompilerVariableInitializationCompletionKind,
  left: ReadonlySet<string> | undefined,
  right: ReadonlySet<string> | undefined,
): CompilerVariableInitializationCompletion {
  const initialized = combineCompilerVariableInitializationSets(left, right);
  return initialized ? { [kind]: initialized } : {};
}

const compilerVariableInitializationCompletionKinds: readonly CompilerVariableInitializationCompletionKind[] = [
  'break',
  'continue',
  'normal',
  'return',
  'throw',
];
