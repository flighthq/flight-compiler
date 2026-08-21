import { compareTextCodeUnits } from '../../compiler-canonical-form/src/index.js';
import { analyzeIrModuleTraversal } from '../../compiler-ir-traversal/src/index.js';
import type { CompilerRuntimeExternalConstructorInvocation, IrModule } from '../../compiler-types/src/index.js';

export function collectIrModulesRuntimeExternalConstructorInvocations(
  modules: readonly Readonly<IrModule>[],
): readonly CompilerRuntimeExternalConstructorInvocation[] {
  const invocations = new Map<string, CompilerRuntimeExternalConstructorInvocation>();
  for (const module of modules) {
    analyzeIrModuleTraversal(module, {
      expression(expression) {
        if (
          expression.kind !== 'new' ||
          expression.callee.kind !== 'identifier' ||
          expression.callee.reference.kind !== 'ambient'
        ) {
          return;
        }
        const invocation = {
          externalSymbol: { sourceName: expression.callee.reference.name.normalize('NFC'), space: 'value' },
          providedArgumentCount: expression.arguments.some((argument) => argument.kind === 'spread')
            ? ('dynamic' as const)
            : expression.arguments.length,
        } satisfies CompilerRuntimeExternalConstructorInvocation;
        invocations.set(serializeExternalConstructorInvocation(invocation), invocation);
      },
    });
  }
  return [...invocations.values()].sort(compareExternalConstructorInvocations);
}

function compareExternalConstructorInvocations(
  left: Readonly<CompilerRuntimeExternalConstructorInvocation>,
  right: Readonly<CompilerRuntimeExternalConstructorInvocation>,
): number {
  return (
    compareTextCodeUnits(left.externalSymbol.sourceName, right.externalSymbol.sourceName) ||
    compareExternalConstructorArgumentCounts(left.providedArgumentCount, right.providedArgumentCount)
  );
}

function compareExternalConstructorArgumentCounts(
  left: CompilerRuntimeExternalConstructorInvocation['providedArgumentCount'],
  right: CompilerRuntimeExternalConstructorInvocation['providedArgumentCount'],
): number {
  return (
    (left === 'dynamic' ? Number.MAX_SAFE_INTEGER : left) - (right === 'dynamic' ? Number.MAX_SAFE_INTEGER : right)
  );
}

function serializeExternalConstructorInvocation(
  invocation: Readonly<CompilerRuntimeExternalConstructorInvocation>,
): string {
  return JSON.stringify([invocation.externalSymbol.sourceName, invocation.providedArgumentCount]);
}
