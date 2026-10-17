import type { CompilerBackend, RustCompilerBackendOptions } from '../../compiler-types/src/index.js';
import { createRustCompilerBackend as createRustCompilerEmissionBackend } from './rustCompilerBackend.js';
import { createCompilerRustPublicBindingPlan } from './rustPublicBindingPlan.js';

export function createRustCompilerPublicBindingBackend(): CompilerBackend<RustCompilerBackendOptions> {
  const backend = createRustCompilerEmissionBackend();
  return {
    ...backend,
    createPublicBindingPlan: (request) =>
      createCompilerRustPublicBindingPlan({
        facade: request.facade,
        modules: request.modules,
        refusals: request.refusals,
      }),
  };
}
