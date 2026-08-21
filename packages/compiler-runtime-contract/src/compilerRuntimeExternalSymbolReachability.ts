import { compareTextCodeUnits } from '../../compiler-canonical-form/src/index.js';
import { analyzeIrModuleTraversal } from '../../compiler-ir-traversal/src/index.js';
import type { CompilerRuntimeExternalSymbolIdentity, IrModule } from '../../compiler-types/src/index.js';

export function collectIrModulesRuntimeExternalSymbolIdentities(
  modules: readonly Readonly<IrModule>[],
): readonly CompilerRuntimeExternalSymbolIdentity[] {
  const identities = new Map<string, CompilerRuntimeExternalSymbolIdentity>();
  const add = (sourceName: string, space: CompilerRuntimeExternalSymbolIdentity['space']) => {
    const normalized = sourceName.normalize('NFC');
    if (space === 'type' && compilerIntrinsicTypeNames.has(normalized)) return;
    if (space === 'value' && compilerIntrinsicValueNames.has(normalized)) return;
    const identity = { sourceName: normalized, space } as const;
    identities.set(JSON.stringify([identity.sourceName, identity.space]), identity);
  };
  for (const module of modules) {
    analyzeIrModuleTraversal(module, {
      expression(expression) {
        if (expression.kind === 'identifier' && expression.reference.kind === 'ambient') {
          add(expression.reference.name, 'value');
        }
      },
      type(type) {
        if (type.kind === 'named' && type.reference.kind === 'ambient') add(type.reference.name, 'type');
        if (type.kind === 'typeOf' && type.reference.kind === 'ambient') add(type.reference.name, 'value');
      },
    });
  }
  return [...identities.values()].sort(compareIrRuntimeExternalSymbolIdentities);
}

function compareIrRuntimeExternalSymbolIdentities(
  left: Readonly<CompilerRuntimeExternalSymbolIdentity>,
  right: Readonly<CompilerRuntimeExternalSymbolIdentity>,
): number {
  return compareTextCodeUnits(left.sourceName, right.sourceName) || compareTextCodeUnits(left.space, right.space);
}

// These TypeScript utility wrappers change compile-time type meaning but do not name runtime storage.
const compilerIntrinsicTypeNames = new Set(['Partial', 'Readonly', 'Required']);
const compilerIntrinsicValueNames = new Set(['undefined']);
