import { compareTextCodeUnits } from '../../compiler-canonical-form/src/index.js';
import { analyzeIrModuleTraversal } from '../../compiler-ir-traversal/src/index.js';
import type { CompilerRuntimeExternalSymbolIdentity, IrExpression, IrModule } from '../../compiler-types/src/index.js';

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
    // `typeof x` asks whether a global exists; it does not use it. ECMAScript evaluates a typeof
    // operand naming an undeclared identifier to "undefined" rather than throwing, so a module that
    // only probes a symbol makes no runtime claim on it and must not require a binding. Only a bare
    // identifier is protected this way: `typeof a.b` still evaluates `a`, so it remains a use.
    const presenceQueryOperands = new Set<Readonly<IrExpression>>();
    analyzeIrModuleTraversal(module, {
      expression(expression) {
        if (expression.kind === 'unary' && expression.operator === 'typeof') {
          presenceQueryOperands.add(expression.operand);
          return;
        }
        if (
          expression.kind === 'identifier' &&
          expression.reference.kind === 'ambient' &&
          !presenceQueryOperands.has(expression)
        ) {
          add(expression.reference.name, 'value');
        }
      },
      type(type, path) {
        if (isCompilerOptionalChainValueTypePath(path)) return;
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

// Optional-chain valueType is checker evidence used to classify the source operation. It is not a
// value representation that the selected runtime must provide; the concrete resultType remains
// independently reachable and authoritative for emitted storage.
function isCompilerOptionalChainValueTypePath(path: readonly (number | string)[]): boolean {
  return path.some((part, index) => part === 'optionalChain' && path[index + 1] === 'valueType');
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
  'Awaited',
  'Exclude',
  'Extract',
  'FlatArray',
  'NonNullable',
  'NoInfer',
  'Omit',
  'Parameters',
  'Partial',
  'Pick',
  'PropertyKey',
  'Readonly',
  'ReturnType',
  'Required',
  'ThisType',
]);
const compilerErasedTypeArgumentIndexes = new Map<string, readonly number[]>([
  ['Exclude', [1]],
  ['Extract', [1]],
  ['Omit', [1]],
  ['Pick', [1]],
]);
const compilerIntrinsicValueNames = new Set(['undefined']);
