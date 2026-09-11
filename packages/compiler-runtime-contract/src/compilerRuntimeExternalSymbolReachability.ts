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
    const erasedTypeArgumentPaths: (readonly (number | string)[])[] = [];
    analyzeIrModuleTraversal(module, {
      expression(expression) {
        if (expression.kind === 'identifier' && expression.reference.kind === 'ambient') {
          add(expression.reference.name, 'value');
        }
      },
      type(type, path) {
        if (erasedTypeArgumentPaths.some((prefix) => isCompilerIrTraversalPathWithin(path, prefix))) return;
        if (type.kind === 'named' && type.reference.kind === 'ambient') {
          for (const index of compilerErasedTypeArgumentIndexes.get(type.reference.name) ?? []) {
            erasedTypeArgumentPaths.push([...path, 'typeArguments', index]);
          }
        }
        if (type.kind === 'named' && type.reference.kind === 'ambient') add(type.reference.name, 'type');
        if (type.kind === 'typeOf' && type.reference.kind === 'ambient') add(type.reference.name, 'value');
      },
    });
  }
  return [...identities.values()].sort(compareIrRuntimeExternalSymbolIdentities);
}

function isCompilerIrTraversalPathWithin(
  path: readonly (number | string)[],
  prefix: readonly (number | string)[],
): boolean {
  return prefix.length <= path.length && prefix.every((part, index) => path[index] === part);
}

function compareIrRuntimeExternalSymbolIdentities(
  left: Readonly<CompilerRuntimeExternalSymbolIdentity>,
  right: Readonly<CompilerRuntimeExternalSymbolIdentity>,
): number {
  return compareTextCodeUnits(left.sourceName, right.sourceName) || compareTextCodeUnits(left.space, right.space);
}

// These TypeScript utility wrappers change compile-time type meaning but do not name runtime storage.
const compilerIntrinsicTypeNames = new Set([
  'Exclude',
  'Extract',
  'NonNullable',
  'NoInfer',
  'Omit',
  'Partial',
  'Pick',
  'PropertyKey',
  'Readonly',
  'Required',
]);
const compilerErasedTypeArgumentIndexes = new Map<string, readonly number[]>([
  ['Exclude', [1]],
  ['Extract', [1]],
  ['Omit', [1]],
  ['Pick', [1]],
]);
const compilerIntrinsicValueNames = new Set(['undefined']);
