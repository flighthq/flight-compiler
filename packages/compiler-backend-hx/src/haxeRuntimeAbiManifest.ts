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
    intrinsics: {
      requirements: [
        { capability: 'array', members: ['pushMany'], targetName: '_ArrayTools' },
        {
          capability: 'javascript-semantics',
          members: [
            'add',
            'bitwiseAnd',
            'bitwiseNot',
            'bitwiseOr',
            'bitwiseXor',
            'deleteProperty',
            'divide',
            'getProperty',
            'greaterThan',
            'greaterThanOrEqual',
            'inOperator',
            'instanceOf',
            'lessThan',
            'lessThanOrEqual',
            'looseEqual',
            'multiply',
            'power',
            'remainder',
            'setProperty',
            'shiftLeft',
            'shiftRight',
            'shiftRightUnsigned',
            'strictEqual',
            'subtract',
            'toNumber',
            'truthy',
            'typeOf',
          ],
          targetName: '_Js',
        },
      ],
      schema: 'flight-haxe-runtime-intrinsics/1',
    },
    schema: 'flight-haxe-runtime-abi/2',
    tasks: createCompilerRuntimeTaskCapabilityPlanHaxe(),
  };
}
