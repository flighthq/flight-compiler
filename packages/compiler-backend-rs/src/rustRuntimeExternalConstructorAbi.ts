import type { CompilerRuntimeExternalConstructorAbiPlan } from '../../compiler-types/src/index.js';

export function createCompilerRuntimeExternalConstructorAbiPlanRust(): CompilerRuntimeExternalConstructorAbiPlan {
  return {
    constructors: rustRuntimeExternalConstructorAbis.map((constructor) => ({
      dynamicArguments: constructor.dynamicArguments,
      externalSymbol: { ...constructor.externalSymbol },
      fixedArgumentCounts: [...constructor.fixedArgumentCounts],
    })),
    contract: 'flight-runtime-constructor-abi/1',
  };
}

const rustRuntimeExternalConstructorAbis = [
  createRustRuntimeExternalConstructorAbi('Array'),
  createRustRuntimeExternalConstructorAbi('Float32Array'),
  createRustRuntimeExternalConstructorAbi('Float64Array'),
  createRustRuntimeExternalConstructorAbi('Int16Array'),
  createRustRuntimeExternalConstructorAbi('Int32Array'),
  createRustRuntimeExternalConstructorAbi('Int8Array'),
  createRustRuntimeExternalConstructorAbi('Map'),
  createRustRuntimeExternalConstructorAbi('Set'),
  createRustRuntimeExternalConstructorAbi('Uint16Array'),
  createRustRuntimeExternalConstructorAbi('Uint32Array'),
  createRustRuntimeExternalConstructorAbi('Uint8Array'),
  createRustRuntimeExternalConstructorAbi('Uint8ClampedArray'),
] as const;

function createRustRuntimeExternalConstructorAbi(sourceName: string) {
  return {
    dynamicArguments: false,
    externalSymbol: { sourceName, space: 'value' },
    fixedArgumentCounts: [0],
  } as const;
}
