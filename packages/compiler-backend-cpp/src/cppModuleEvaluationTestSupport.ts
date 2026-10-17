import { compileIrModules } from '../../compiler-orchestration/src/index.js';
import type {
  CompilerModuleEvaluationPlan,
  CompilerModuleIdentity,
  CompilerModuleResolutionPlan,
  IrModule,
} from '../../compiler-types/src/index.js';

const emptyModuleEvaluation = captureModuleEvaluation([]);

/**
 * Supplies the same module-evaluation context that orchestration gives a backend session. Tests
 * without import or re-export links share the canonical empty plan; linked fixtures retain the
 * production dependency completion and request ordering rather than reconstructing either here.
 */
export function createCppTestModuleEvaluation(
  modules: readonly Readonly<IrModule>[],
  moduleResolution?: Readonly<CompilerModuleResolutionPlan>,
): CompilerModuleEvaluationPlan {
  if (
    modules.every((module) => module.imports.length === 0 && module.exports.every((item) => !('specifier' in item)))
  ) {
    return emptyModuleEvaluation;
  }
  return captureClosedModuleEvaluation(modules, moduleResolution);
}

function captureClosedModuleEvaluation(
  modules: readonly Readonly<IrModule>[],
  moduleResolution: Readonly<CompilerModuleResolutionPlan> | undefined,
): CompilerModuleEvaluationPlan {
  let closedModules = [...modules];
  for (;;) {
    try {
      return captureModuleEvaluation(closedModules, moduleResolution);
    } catch (error) {
      const failedModule = getModuleEvaluationFailureModule(error);
      if (!failedModule) throw error;
      const retained = closedModules.filter((module) => !isModuleIdentity(module, failedModule));
      if (retained.length === closedModules.length) throw error;
      if (retained.length === 0) {
        // A single-module negative fixture can intentionally have no resolvable target at all. It
        // still gets a real plan for its local declarations and evaluation steps; only the link the
        // fixture exists to reject is absent from this test context.
        return captureModuleEvaluation([withoutModuleLinks(closedModules[0]!)], undefined);
      }
      // Several ownership-refusal fixtures deliberately leave one import unresolved or ambiguous.
      // Such a module is not an evaluable entry. Remove it, then let the production planner prove the
      // remaining fixture graph is closed; dependents are removed by the same validation on a later pass.
      closedModules = retained;
    }
  }
}

function captureModuleEvaluation(
  modules: readonly Readonly<IrModule>[],
  moduleResolution?: Readonly<CompilerModuleResolutionPlan>,
): CompilerModuleEvaluationPlan {
  let captured: CompilerModuleEvaluationPlan | undefined;
  compileIrModules({
    backend: {
      createEmissionSession(context) {
        captured = context.moduleEvaluation;
        return { emitModule: () => [] };
      },
      emitModule: () => [],
      name: 'cpp-module-evaluation-test-support',
    },
    backendOptions: {},
    ...(moduleResolution ? { moduleResolution } : {}),
    modules,
  });
  if (!captured) throw new Error('compiler orchestration did not create a module-evaluation plan');
  return captured;
}

function getModuleEvaluationFailureModule(error: unknown): CompilerModuleIdentity | undefined {
  if (
    !error ||
    typeof error !== 'object' ||
    !('kind' in error) ||
    error.kind !== 'compiler-module-evaluation' ||
    !('module' in error) ||
    !error.module ||
    typeof error.module !== 'object'
  ) {
    return undefined;
  }
  const { module } = error;
  return 'name' in module && 'packageName' in module && 'source' in module
    ? (module as unknown as CompilerModuleIdentity)
    : undefined;
}

function isModuleIdentity(module: Readonly<IrModule>, identity: Readonly<CompilerModuleIdentity>): boolean {
  return (
    module.name === identity.name && module.packageName === identity.packageName && module.source === identity.source
  );
}

function withoutModuleLinks(module: Readonly<IrModule>): IrModule {
  return {
    ...module,
    exports: module.exports.filter((item) => !('specifier' in item)),
    imports: [],
  };
}
