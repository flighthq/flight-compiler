import type { CompilerCompletionSet } from '../../compiler-types/src/index.js';
import { combineCompilerCompletionSetsAlternatively, createCompilerCompletionSet } from './compilerCompletionSet.js';

export function applyCompilerCompletionSetFinallyReplacement(
  completion: Readonly<CompilerCompletionSet>,
  finallyCompletion: Readonly<CompilerCompletionSet>,
): CompilerCompletionSet {
  const normalized = [completion, finallyCompletion].map((set) => combineCompilerCompletionSetsAlternatively([set]));
  const incoming = normalized[0]!;
  const finalizer = normalized[1]!;
  if (incoming.completions.length === 0) return createCompilerCompletionSet([]);
  const abrupt = createCompilerCompletionSet(finalizer.completions.filter((candidate) => candidate.kind !== 'normal'));
  return finalizer.completions.some((candidate) => candidate.kind === 'normal')
    ? combineCompilerCompletionSetsAlternatively([incoming, abrupt])
    : abrupt;
}
