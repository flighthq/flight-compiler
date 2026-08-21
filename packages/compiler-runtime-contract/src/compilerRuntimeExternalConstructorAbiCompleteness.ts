import { compareTextCodeUnits } from '../../compiler-canonical-form/src/index.js';
import type {
  CompilerRuntimeExternalConstructorAbi,
  CompilerRuntimeExternalConstructorAbiCompleteness,
  CompilerRuntimeExternalConstructorAbiContractMismatchFailure,
  CompilerRuntimeExternalConstructorAbiPlan,
  CompilerRuntimeExternalConstructorIdentity,
  CompilerRuntimeExternalConstructorInvocation,
} from '../../compiler-types/src/index.js';

export function analyzeCompilerRuntimeExternalConstructorAbiCompleteness(
  requiredExternalConstructors: readonly Readonly<CompilerRuntimeExternalConstructorInvocation>[],
  abiPlan: Readonly<CompilerRuntimeExternalConstructorAbiPlan>,
): CompilerRuntimeExternalConstructorAbiCompleteness {
  assertCompilerRuntimeExternalConstructorAbiContract(abiPlan);
  const required = createSortedExternalConstructorInvocations(requiredExternalConstructors);
  const constructorGroups = new Map<string, Readonly<CompilerRuntimeExternalConstructorAbi>[]>();
  for (const constructor of abiPlan.constructors) {
    const normalized = normalizeExternalConstructorAbi(constructor);
    const key = normalized.externalSymbol.sourceName;
    constructorGroups.set(key, [...(constructorGroups.get(key) ?? []), normalized]);
  }
  const duplicateExternalConstructors = [...constructorGroups.values()]
    .filter((constructors) => constructors.length > 1)
    .map(([constructor]) => constructor!.externalSymbol)
    .sort(compareExternalConstructorIdentities);
  const invalidExternalConstructors = [...constructorGroups.values()]
    .flatMap((constructors) => constructors.filter((constructor) => !isExternalConstructorAbiValid(constructor)))
    .map((constructor) => constructor.externalSymbol)
    .filter(
      (identity, index, identities) =>
        identities.findIndex((candidate) => candidate.sourceName === identity.sourceName) === index,
    )
    .sort(compareExternalConstructorIdentities);
  const missingExternalConstructors = required.filter((invocation) => {
    const constructors = constructorGroups.get(invocation.externalSymbol.sourceName);
    if (constructors?.length !== 1) return true;
    const [constructor] = constructors;
    if (!constructor || !isExternalConstructorAbiValid(constructor)) return true;
    return invocation.providedArgumentCount === 'dynamic'
      ? !constructor.dynamicArguments
      : !constructor.fixedArgumentCounts.includes(invocation.providedArgumentCount);
  });
  const common = {
    contract: abiPlan.contract,
    requiredExternalConstructors: required,
    schema: 'flight-runtime-constructor-abi-completeness/1' as const,
  };
  if (
    duplicateExternalConstructors.length === 0 &&
    invalidExternalConstructors.length === 0 &&
    missingExternalConstructors.length === 0
  ) {
    return { ...common, kind: 'complete' };
  }
  return {
    ...common,
    duplicateExternalConstructors,
    invalidExternalConstructors,
    kind: 'incomplete',
    missingExternalConstructors,
  };
}

export function isCompilerRuntimeExternalConstructorAbiContractMismatchFailure(
  value: unknown,
): value is CompilerRuntimeExternalConstructorAbiContractMismatchFailure {
  return (
    value instanceof Error &&
    'kind' in value &&
    value.kind === 'runtime-external-constructor-abi-contract-mismatch' &&
    'expected' in value &&
    value.expected === 'flight-runtime-constructor-abi/1' &&
    'received' in value &&
    typeof value.received === 'string'
  );
}

function assertCompilerRuntimeExternalConstructorAbiContract(
  abiPlan: Readonly<CompilerRuntimeExternalConstructorAbiPlan>,
): void {
  if (abiPlan.contract === 'flight-runtime-constructor-abi/1') return;
  const failure = Object.assign(
    new Error(
      `Runtime external constructor ABI plan uses ${String(abiPlan.contract)}; expected flight-runtime-constructor-abi/1`,
    ),
    {
      expected: 'flight-runtime-constructor-abi/1' as const,
      kind: 'runtime-external-constructor-abi-contract-mismatch' as const,
      received: String(abiPlan.contract),
    },
  );
  failure.name = 'CompilerRuntimeExternalConstructorAbiContractMismatchError';
  throw failure;
}

function compareExternalConstructorArgumentCounts(
  left: CompilerRuntimeExternalConstructorInvocation['providedArgumentCount'],
  right: CompilerRuntimeExternalConstructorInvocation['providedArgumentCount'],
): number {
  return (
    (left === 'dynamic' ? Number.MAX_SAFE_INTEGER : left) - (right === 'dynamic' ? Number.MAX_SAFE_INTEGER : right)
  );
}

function compareExternalConstructorIdentities(
  left: Readonly<CompilerRuntimeExternalConstructorIdentity>,
  right: Readonly<CompilerRuntimeExternalConstructorIdentity>,
): number {
  return compareTextCodeUnits(left.sourceName, right.sourceName);
}

function compareExternalConstructorInvocations(
  left: Readonly<CompilerRuntimeExternalConstructorInvocation>,
  right: Readonly<CompilerRuntimeExternalConstructorInvocation>,
): number {
  return (
    compareExternalConstructorIdentities(left.externalSymbol, right.externalSymbol) ||
    compareExternalConstructorArgumentCounts(left.providedArgumentCount, right.providedArgumentCount)
  );
}

function createSortedExternalConstructorInvocations(
  invocations: readonly Readonly<CompilerRuntimeExternalConstructorInvocation>[],
): CompilerRuntimeExternalConstructorInvocation[] {
  const normalized = invocations.map((invocation) => ({
    externalSymbol: normalizeExternalConstructorIdentity(invocation.externalSymbol),
    providedArgumentCount: invocation.providedArgumentCount,
  }));
  return [
    ...new Map(
      normalized.map((invocation) => [
        JSON.stringify([invocation.externalSymbol.sourceName, invocation.providedArgumentCount]),
        invocation,
      ]),
    ).values(),
  ].sort(compareExternalConstructorInvocations);
}

function isExternalConstructorAbiValid(constructor: Readonly<CompilerRuntimeExternalConstructorAbi>): boolean {
  return (
    constructor.externalSymbol.sourceName.length > 0 &&
    constructor.externalSymbol.space === 'value' &&
    typeof constructor.dynamicArguments === 'boolean' &&
    Array.isArray(constructor.fixedArgumentCounts) &&
    constructor.fixedArgumentCounts.every(
      (count, index) =>
        Number.isSafeInteger(count) &&
        count >= 0 &&
        (index === 0 || constructor.fixedArgumentCounts[index - 1]! < count),
    )
  );
}

function normalizeExternalConstructorAbi(
  constructor: Readonly<CompilerRuntimeExternalConstructorAbi>,
): CompilerRuntimeExternalConstructorAbi {
  return {
    dynamicArguments: constructor.dynamicArguments,
    externalSymbol: normalizeExternalConstructorIdentity(constructor.externalSymbol),
    fixedArgumentCounts: [...constructor.fixedArgumentCounts],
  };
}

function normalizeExternalConstructorIdentity(
  identity: Readonly<CompilerRuntimeExternalConstructorIdentity>,
): CompilerRuntimeExternalConstructorIdentity {
  return { sourceName: identity.sourceName.normalize('NFC'), space: 'value' };
}
