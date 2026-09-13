import { analyzeIrModuleTraversal } from '../../compiler-ir-traversal/src/index.js';
import type { IrExpression, IrModule, IrType } from '../../compiler-types/src/index.js';

interface CompilerCppBindingTypeInferenceCandidate {
  readonly bindingId: string;
  readonly dependencies: ReadonlySet<string>;
  readonly index: number;
  readonly initializer: Readonly<IrExpression>;
}

interface CompilerCppBindingTypeInferenceWorkItem {
  readonly candidateIndex: number;
  readonly round: number;
}

export function collectIrModuleBindingTypesCpp(module: Readonly<IrModule>): ReadonlyMap<string, Readonly<IrType>> {
  const bindingTypes = new Map<string, Readonly<IrType>>();
  const candidates: CompilerCppBindingTypeInferenceCandidate[] = [];
  analyzeIrModuleTraversal(module, {
    parameter(parameter) {
      bindingTypes.set(parameter.binding.id, parameter.type);
    },
    variable(variable) {
      if (!('binding' in variable)) return;
      if (variable.type) bindingTypes.set(variable.binding.id, variable.type);
      if (!variable.initializer) return;
      candidates.push({
        bindingId: variable.binding.id,
        dependencies: collectIrExpressionTypeDependenciesCpp(variable.initializer),
        index: candidates.length,
        initializer: variable.initializer,
      });
    },
  });

  const dependentsByBindingId = new Map<string, number[]>();
  for (const candidate of candidates) {
    for (const dependency of candidate.dependencies) {
      const dependents = dependentsByBindingId.get(dependency) ?? [];
      dependents.push(candidate.index);
      dependentsByBindingId.set(dependency, dependents);
    }
  }

  const scheduledRounds: Array<number | undefined> = candidates.map(() => 0);
  const workItems: CompilerCppBindingTypeInferenceWorkItem[] = candidates.map((candidate) => ({
    candidateIndex: candidate.index,
    round: 0,
  }));
  while (workItems.length > 0) {
    const workItem = removeCompilerCppBindingTypeInferenceWorkItem(workItems);
    if (scheduledRounds[workItem.candidateIndex] !== workItem.round) continue;
    scheduledRounds[workItem.candidateIndex] = undefined;
    const candidate = candidates[workItem.candidateIndex]!;
    const existing = bindingTypes.get(candidate.bindingId);
    if (existing && existing.kind !== 'unknown') continue;
    const inferred = inferIrExpressionTypeCpp(candidate.initializer, bindingTypes);
    if (!inferred || inferred.kind === 'unknown') continue;
    bindingTypes.set(candidate.bindingId, inferred);
    for (const dependentIndex of dependentsByBindingId.get(candidate.bindingId) ?? []) {
      const dependent = candidates[dependentIndex]!;
      const dependentType = bindingTypes.get(dependent.bindingId);
      if (dependentType && dependentType.kind !== 'unknown') continue;
      const round = dependentIndex > candidate.index ? workItem.round : workItem.round + 1;
      scheduleCompilerCppBindingTypeInferenceWorkItem(workItems, scheduledRounds, dependentIndex, round);
    }
  }
  return bindingTypes;
}

function collectIrExpressionTypeDependenciesCpp(expression: Readonly<IrExpression>): ReadonlySet<string> {
  const dependencies = new Set<string>();
  collectIrExpressionTypeDependenciesIntoCpp(expression, dependencies);
  return dependencies;
}

function collectIrExpressionTypeDependenciesIntoCpp(
  expression: Readonly<IrExpression>,
  dependencies: Set<string>,
): void {
  switch (expression.kind) {
    case 'assignment':
      if (expression.left.kind === 'identifier' && expression.left.reference.kind === 'binding') {
        dependencies.add(expression.left.reference.binding.id);
      }
      return;
    case 'conditional':
      collectIrExpressionTypeDependenciesIntoCpp(expression.whenTrue, dependencies);
      collectIrExpressionTypeDependenciesIntoCpp(expression.whenFalse, dependencies);
      return;
    case 'identifier':
      if (expression.reference.kind === 'binding') dependencies.add(expression.reference.binding.id);
      return;
    case 'array':
    case 'await':
    case 'binary':
    case 'call':
    case 'cast':
    case 'element':
    case 'function':
    case 'literal':
    case 'new':
    case 'object':
    case 'objectRest':
    case 'property':
    case 'regexp':
    case 'spread':
    case 'template':
    case 'tuple':
    case 'tupleRest':
    case 'tupleSpread':
    case 'tupleSuffix':
    case 'unary':
    case 'undefinedDefault':
    case 'undefinedValue':
      return;
  }
}

function compareCompilerCppBindingTypeInferenceWorkItems(
  left: Readonly<CompilerCppBindingTypeInferenceWorkItem>,
  right: Readonly<CompilerCppBindingTypeInferenceWorkItem>,
): number {
  return left.round - right.round || left.candidateIndex - right.candidateIndex;
}

function inferIrExpressionTypeCpp(
  expression: Readonly<IrExpression>,
  bindingTypes: ReadonlyMap<string, Readonly<IrType>>,
): Readonly<IrType> | undefined {
  switch (expression.kind) {
    case 'assignment':
      return expression.left.kind === 'identifier' && expression.left.reference.kind === 'binding'
        ? bindingTypes.get(expression.left.reference.binding.id)
        : undefined;
    case 'call':
      return expression.semantics.resultType.kind === 'unknown' ? undefined : expression.semantics.resultType;
    case 'cast':
      return expression.type;
    case 'conditional':
      return (
        inferIrExpressionTypeCpp(expression.whenTrue, bindingTypes) ??
        inferIrExpressionTypeCpp(expression.whenFalse, bindingTypes)
      );
    case 'identifier':
      return expression.reference.kind === 'binding' ? bindingTypes.get(expression.reference.binding.id) : undefined;
    case 'new':
      return expression.callee.kind === 'identifier' && expression.callee.reference.kind === 'binding'
        ? {
            kind: 'named',
            reference: { binding: expression.callee.reference.binding, kind: 'binding', path: [] },
            typeArguments: expression.typeArguments,
          }
        : undefined;
    case 'object':
      return expression.type;
    case 'undefinedValue':
      return expression.type;
    case 'array':
    case 'await':
    case 'binary':
    case 'element':
    case 'function':
    case 'literal':
    case 'objectRest':
    case 'property':
    case 'regexp':
    case 'spread':
    case 'template':
    case 'tuple':
    case 'tupleRest':
    case 'tupleSpread':
    case 'tupleSuffix':
    case 'unary':
    case 'undefinedDefault':
      return undefined;
  }
}

function removeCompilerCppBindingTypeInferenceWorkItem(
  workItems: CompilerCppBindingTypeInferenceWorkItem[],
): CompilerCppBindingTypeInferenceWorkItem {
  const first = workItems[0]!;
  const last = workItems.pop()!;
  if (workItems.length === 0) return first;
  workItems[0] = last;
  let parentIndex = 0;
  for (;;) {
    const leftIndex = parentIndex * 2 + 1;
    const rightIndex = leftIndex + 1;
    let childIndex = parentIndex;
    if (
      leftIndex < workItems.length &&
      compareCompilerCppBindingTypeInferenceWorkItems(workItems[leftIndex]!, workItems[childIndex]!) < 0
    ) {
      childIndex = leftIndex;
    }
    if (
      rightIndex < workItems.length &&
      compareCompilerCppBindingTypeInferenceWorkItems(workItems[rightIndex]!, workItems[childIndex]!) < 0
    ) {
      childIndex = rightIndex;
    }
    if (childIndex === parentIndex) return first;
    [workItems[parentIndex], workItems[childIndex]] = [workItems[childIndex]!, workItems[parentIndex]!];
    parentIndex = childIndex;
  }
}

function scheduleCompilerCppBindingTypeInferenceWorkItem(
  workItems: CompilerCppBindingTypeInferenceWorkItem[],
  scheduledRounds: Array<number | undefined>,
  candidateIndex: number,
  round: number,
): void {
  const scheduledRound = scheduledRounds[candidateIndex];
  if (scheduledRound !== undefined && scheduledRound <= round) return;
  scheduledRounds[candidateIndex] = round;
  workItems.push({ candidateIndex, round });
  let childIndex = workItems.length - 1;
  while (childIndex > 0) {
    const parentIndex = Math.floor((childIndex - 1) / 2);
    if (compareCompilerCppBindingTypeInferenceWorkItems(workItems[parentIndex]!, workItems[childIndex]!) <= 0) {
      return;
    }
    [workItems[parentIndex], workItems[childIndex]] = [workItems[childIndex]!, workItems[parentIndex]!];
    childIndex = parentIndex;
  }
}
