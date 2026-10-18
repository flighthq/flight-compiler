import type {
  CompilerBackend,
  CompilerBackendTargetInitializationPlan,
  CompilerRustModuleEvaluationExecutionPlan,
  RustCompilerBackendOptions,
} from '../../compiler-types/src/index.js';
import { createRustCompilerBackend as createRustCompilerEmissionBackend } from './rustCompilerBackend.js';
import { createCompilerRustPublicBindingPlan, createCompilerRustPublicBindingPlanV3 } from './rustPublicBindingPlan.js';

export function createRustCompilerPublicBindingBackend(): CompilerBackend<RustCompilerBackendOptions> {
  const backend = createRustCompilerEmissionBackend();
  return {
    ...backend,
    createPublicBindingPlan: (request) => {
      const execution = getRustTargetInitializationPlanRust(request.targetInitialization);
      return execution === undefined
        ? createCompilerRustPublicBindingPlan({
            facade: request.facade,
            modules: request.modules,
            refusals: request.refusals,
          })
        : createCompilerRustPublicBindingPlanV3({
            execution,
            facade: request.facade,
            modules: request.modules,
            refusals: request.refusals,
            ...(request.options.runtimeCrate === undefined ? {} : { runtimeCrate: request.options.runtimeCrate }),
          });
    },
  };
}

// The generic seam may carry another target's plan once the union grows; this adapter only consumes
// the Rust module-evaluation execution plan and otherwise keeps the v2 compatibility path.
function getRustTargetInitializationPlanRust(
  plan: Readonly<CompilerBackendTargetInitializationPlan> | undefined,
): CompilerRustModuleEvaluationExecutionPlan | undefined {
  return plan?.schema === 'flight-rust-module-evaluation-execution-plan/1' ? plan : undefined;
}
