import type { CompilerRustRuntimeAbiManifest } from '../../compiler-types/src/index.js';
import { createCompilerRustAmbientMemberBindingPlan } from './rustAmbientMemberBinding.js';
import { createCompilerRuntimeExternalConstructorAbiPlanRust } from './rustRuntimeExternalConstructorAbi.js';
import { createCompilerRustRuntimeExternalSymbolBindingPlan } from './rustRuntimeExternalSymbolBinding.js';

export function createCompilerRustRuntimeAbiManifest(): CompilerRustRuntimeAbiManifest {
  return {
    ambientMembers: createCompilerRustAmbientMemberBindingPlan(),
    constructors: createCompilerRuntimeExternalConstructorAbiPlanRust(),
    externalSymbols: createCompilerRustRuntimeExternalSymbolBindingPlan(),
    representation: {
      nullability: { nonNull: 'direct', nullableTargetName: 'Option' },
      ownership: { nonCopyReuse: 'clone', temporaryAccess: 'borrow' },
      schema: 'flight-rust-runtime-representation/1',
    },
    schema: 'flight-rust-runtime-abi/1',
  };
}
