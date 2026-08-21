import { compareTextCodeUnits } from '../../compiler-canonical-form/src/index.js';
import type {
  CompilerRuntimeExternalSymbolBindingPlan,
  CompilerRuntimeExternalSymbolCompleteness,
  CompilerRuntimeExternalSymbolIdentity,
} from '../../compiler-types/src/index.js';

export function analyzeCompilerRuntimeExternalSymbolCompleteness(
  requiredExternalSymbols: readonly Readonly<CompilerRuntimeExternalSymbolIdentity>[],
  bindingPlan: Readonly<CompilerRuntimeExternalSymbolBindingPlan>,
): CompilerRuntimeExternalSymbolCompleteness {
  const required = createSortedExternalSymbolIdentities(requiredExternalSymbols);
  const bindingCounts = new Map<string, { count: number; identity: CompilerRuntimeExternalSymbolIdentity }>();
  for (const binding of bindingPlan.bindings) {
    const identity = normalizeExternalSymbolIdentity(binding.externalSymbol);
    const key = serializeExternalSymbolIdentity(identity);
    const existing = bindingCounts.get(key);
    bindingCounts.set(key, { count: (existing?.count ?? 0) + 1, identity });
  }

  const duplicateExternalSymbols = [...bindingCounts.values()]
    .filter(({ count }) => count > 1)
    .map(({ identity }) => identity)
    .sort(compareExternalSymbolIdentities);
  const missingExternalSymbols = required.filter(
    (identity) => !bindingCounts.has(serializeExternalSymbolIdentity(identity)),
  );
  const common = {
    contract: bindingPlan.contract,
    requiredExternalSymbols: required,
    schema: 'flight-runtime-contract-completeness/2' as const,
  };
  if (duplicateExternalSymbols.length === 0 && missingExternalSymbols.length === 0) {
    return { ...common, kind: 'complete' };
  }
  return {
    ...common,
    duplicateExternalSymbols,
    kind: 'incomplete',
    missingExternalSymbols,
  };
}

function compareExternalSymbolIdentities(
  left: Readonly<CompilerRuntimeExternalSymbolIdentity>,
  right: Readonly<CompilerRuntimeExternalSymbolIdentity>,
): number {
  return compareTextCodeUnits(left.sourceName, right.sourceName) || compareTextCodeUnits(left.space, right.space);
}

function createSortedExternalSymbolIdentities(
  identities: readonly Readonly<CompilerRuntimeExternalSymbolIdentity>[],
): CompilerRuntimeExternalSymbolIdentity[] {
  const normalized = identities.map(normalizeExternalSymbolIdentity);
  return [
    ...new Map(normalized.map((identity) => [serializeExternalSymbolIdentity(identity), identity])).values(),
  ].sort(compareExternalSymbolIdentities);
}

function normalizeExternalSymbolIdentity(
  identity: Readonly<CompilerRuntimeExternalSymbolIdentity>,
): CompilerRuntimeExternalSymbolIdentity {
  return { sourceName: identity.sourceName.normalize('NFC'), space: identity.space };
}

function serializeExternalSymbolIdentity(identity: Readonly<CompilerRuntimeExternalSymbolIdentity>): string {
  return JSON.stringify([identity.sourceName, identity.space]);
}
