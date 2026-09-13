import type { CompilerHaxeRuntimeAbiManifest } from '../../compiler-types/src/index.js';
import { createCompilerHaxeAmbientMemberBindingPlan } from './haxeAmbientMemberBinding.js';
import { createCompilerRuntimeExternalConstructorAbiPlanHaxe } from './haxeRuntimeExternalConstructorAbi.js';
import { createCompilerHaxeRuntimeExternalSymbolBindingPlan } from './haxeRuntimeExternalSymbolBinding.js';
import { createCompilerRuntimeTaskCapabilityPlanHaxe } from './haxeRuntimeTaskCapability.js';

export function createCompilerHaxeRuntimeAbiManifest(): CompilerHaxeRuntimeAbiManifest {
  return {
    ambientMembers: createCompilerHaxeAmbientMemberBindingPlan(),
    constructors: createCompilerRuntimeExternalConstructorAbiPlanHaxe(),
    externalSymbols: createCompilerHaxeRuntimeExternalSymbolBindingPlan(),
    schema: 'flight-haxe-runtime-abi/1',
    tasks: createCompilerRuntimeTaskCapabilityPlanHaxe(),
  };
}
