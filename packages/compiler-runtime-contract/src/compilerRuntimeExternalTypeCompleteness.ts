import { compareTextCodeUnits } from '../../compiler-canonical-form/src/index.js';
import type {
  CompilerRuntimeExternalTypeBindingPlan,
  CompilerRuntimeExternalTypeCompleteness,
  CompilerRuntimeExternalTypeIdentity,
} from '../../compiler-types/src/index.js';

export function analyzeCompilerRuntimeExternalTypeCompleteness(
  requiredExternalTypes: readonly Readonly<CompilerRuntimeExternalTypeIdentity>[],
  bindingPlan: Readonly<CompilerRuntimeExternalTypeBindingPlan>,
): CompilerRuntimeExternalTypeCompleteness {
  const required = createSortedExternalTypeIdentities(requiredExternalTypes.map(({ sourceName }) => sourceName));
  const bindingCounts = new Map<string, number>();
  for (const binding of bindingPlan.bindings) {
    const sourceName = binding.externalType.sourceName.normalize('NFC');
    bindingCounts.set(sourceName, (bindingCounts.get(sourceName) ?? 0) + 1);
  }

  const duplicateExternalTypes = createSortedExternalTypeIdentities(
    [...bindingCounts].filter(([, count]) => count > 1).map(([sourceName]) => sourceName),
  );
  const missingExternalTypes = required.filter(({ sourceName }) => !bindingCounts.has(sourceName));
  const common = {
    contract: bindingPlan.contract,
    requiredExternalTypes: required,
    schema: 'flight-runtime-contract-completeness/1' as const,
  };
  if (duplicateExternalTypes.length === 0 && missingExternalTypes.length === 0) {
    return { ...common, kind: 'complete' };
  }
  return {
    ...common,
    duplicateExternalTypes,
    kind: 'incomplete',
    missingExternalTypes,
  };
}

function createSortedExternalTypeIdentities(sourceNames: readonly string[]): CompilerRuntimeExternalTypeIdentity[] {
  return [...new Set(sourceNames.map((sourceName) => sourceName.normalize('NFC')))]
    .sort(compareTextCodeUnits)
    .map((sourceName) => ({ sourceName }));
}
