import type { CompilerBackend, RustCompilerBackendOptions } from '../../compiler-types/src/index.js';
import { createRustCompilerBackend as createRustCompilerEmissionBackend } from './rustCompilerBackend.js';
import { createCompilerRustPublicBindingPlan, createCompilerRustPublicBindingPlanV3 } from './rustPublicBindingPlan.js';

export function createRustCompilerPublicBindingBackend(): CompilerBackend<RustCompilerBackendOptions> {
  const backend = createRustCompilerEmissionBackend();
  return {
    ...backend,
    createPublicBindingPlan: (request) =>
      request.moduleEvaluationExecution === undefined
        ? createCompilerRustPublicBindingPlan({
            facade: request.facade,
            modules: request.modules,
            refusals: request.refusals,
          })
        : createCompilerRustPublicBindingPlanV3({
            execution: request.moduleEvaluationExecution,
            facade: request.facade,
            modules: request.modules,
            refusals: request.refusals,
            ...(request.options.runtimeCrate === undefined ? {} : { runtimeCrate: request.options.runtimeCrate }),
          }),
  };
}
