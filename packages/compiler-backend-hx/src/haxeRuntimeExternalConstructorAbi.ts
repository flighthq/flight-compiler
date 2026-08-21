import type { CompilerRuntimeExternalConstructorAbiPlan } from '../../compiler-types/src/index.js';

export function createCompilerRuntimeExternalConstructorAbiPlanHaxe(): CompilerRuntimeExternalConstructorAbiPlan {
  return {
    constructors: haxeRuntimeExternalConstructorAbis.map((constructor) => ({
      dynamicArguments: constructor.dynamicArguments,
      externalSymbol: { ...constructor.externalSymbol },
      fixedArgumentCounts: [...constructor.fixedArgumentCounts],
    })),
    contract: 'flight-runtime-constructor-abi/1',
  };
}

const haxeRuntimeExternalConstructorAbis = [
  createHaxeRuntimeExternalConstructorAbi('Array', [0]),
  createHaxeRuntimeExternalConstructorAbi('Float32Array', [0, 1, 2, 3]),
  createHaxeRuntimeExternalConstructorAbi('Float64Array', [0, 1, 2, 3]),
  createHaxeRuntimeExternalConstructorAbi('Int16Array', [0, 1, 2, 3]),
  createHaxeRuntimeExternalConstructorAbi('Int32Array', [0, 1, 2, 3]),
  createHaxeRuntimeExternalConstructorAbi('Int8Array', [0, 1, 2, 3]),
  createHaxeRuntimeExternalConstructorAbi('Map', [0, 1]),
  createHaxeRuntimeExternalConstructorAbi('Promise', [1]),
  createHaxeRuntimeExternalConstructorAbi('Set', [0, 1]),
  createHaxeRuntimeExternalConstructorAbi('Uint16Array', [0, 1, 2, 3]),
  createHaxeRuntimeExternalConstructorAbi('Uint32Array', [0, 1, 2, 3]),
  createHaxeRuntimeExternalConstructorAbi('Uint8Array', [0, 1, 2, 3]),
  createHaxeRuntimeExternalConstructorAbi('Uint8ClampedArray', [0, 1, 2, 3]),
] as const;

function createHaxeRuntimeExternalConstructorAbi(sourceName: string, fixedArgumentCounts: readonly number[]) {
  return {
    dynamicArguments: false,
    externalSymbol: { sourceName, space: 'value' },
    fixedArgumentCounts,
  } as const;
}
