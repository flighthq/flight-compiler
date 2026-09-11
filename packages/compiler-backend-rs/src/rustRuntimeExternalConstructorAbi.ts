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
  createRustRuntimeExternalConstructorAbi('Date', [0, 1]),
  createRustRuntimeExternalConstructorAbi('Error', [0, 1]),
  createRustRuntimeExternalConstructorAbi('Float32Array', [0, 1, 2, 3]),
  createRustRuntimeExternalConstructorAbi('Float64Array', [0, 1, 2, 3]),
  createRustRuntimeExternalConstructorAbi('Int16Array', [0, 1, 2, 3]),
  createRustRuntimeExternalConstructorAbi('Int32Array', [0, 1, 2, 3]),
  createRustRuntimeExternalConstructorAbi('Int8Array', [0, 1, 2, 3]),
  createRustRuntimeExternalConstructorAbi('Map', [0, 1]),
  createRustRuntimeExternalConstructorAbi('RangeError', [0, 1]),
  createRustRuntimeExternalConstructorAbi('Set', [0, 1]),
  createRustRuntimeExternalConstructorAbi('TypeError', [0, 1]),
  createRustRuntimeExternalConstructorAbi('Uint16Array', [0, 1, 2, 3]),
  createRustRuntimeExternalConstructorAbi('Uint32Array', [0, 1, 2, 3]),
  createRustRuntimeExternalConstructorAbi('Uint8Array', [0, 1, 2, 3]),
  createRustRuntimeExternalConstructorAbi('Uint8ClampedArray', [0, 1, 2, 3]),
] as const;

function createRustRuntimeExternalConstructorAbi(sourceName: string, fixedArgumentCounts: readonly number[] = [0]) {
  return {
    dynamicArguments: false,
    externalSymbol: { sourceName, space: 'value' },
    fixedArgumentCounts,
  } as const;
}
