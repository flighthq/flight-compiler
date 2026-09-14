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
  createHaxeRuntimeExternalConstructorAbi('AbortController', [0]),
  createHaxeRuntimeExternalConstructorAbi('Array', [0, 1]),
  createHaxeRuntimeExternalConstructorAbi('ArrayBuffer', [1]),
  createHaxeRuntimeExternalConstructorAbi('AudioBuffer', [1]),
  createHaxeRuntimeExternalConstructorAbi('AudioContext', [0, 1]),
  createHaxeRuntimeExternalConstructorAbi('Blob', [0, 1, 2]),
  createHaxeRuntimeExternalConstructorAbi('DataView', [1, 2, 3]),
  createHaxeRuntimeExternalConstructorAbi('Date', [0, 1]),
  createHaxeRuntimeExternalConstructorAbi('Error', [0, 1]),
  createHaxeRuntimeExternalConstructorAbi('Float32Array', [0, 1, 2, 3]),
  createHaxeRuntimeExternalConstructorAbi('Float64Array', [0, 1, 2, 3]),
  createHaxeRuntimeExternalConstructorAbi('FontFace', [2, 3]),
  createHaxeRuntimeExternalConstructorAbi('Function', [1]),
  createHaxeRuntimeExternalConstructorAbi('ImageData', [2, 3]),
  createHaxeRuntimeExternalConstructorAbi('Int16Array', [0, 1, 2, 3]),
  createHaxeRuntimeExternalConstructorAbi('Int32Array', [0, 1, 2, 3]),
  createHaxeRuntimeExternalConstructorAbi('Int8Array', [0, 1, 2, 3]),
  createHaxeRuntimeExternalConstructorAbi('Intl.Collator', [0, 1, 2]),
  createHaxeRuntimeExternalConstructorAbi('Intl.DateTimeFormat', [0, 1, 2]),
  createHaxeRuntimeExternalConstructorAbi('Intl.ListFormat', [0, 1, 2]),
  createHaxeRuntimeExternalConstructorAbi('Intl.NumberFormat', [0, 1, 2]),
  createHaxeRuntimeExternalConstructorAbi('Intl.PluralRules', [0, 1, 2]),
  createHaxeRuntimeExternalConstructorAbi('Intl.RelativeTimeFormat', [0, 1, 2]),
  createHaxeRuntimeExternalConstructorAbi('Map', [0, 1]),
  createHaxeRuntimeExternalConstructorAbi('OffscreenCanvas', [2]),
  createHaxeRuntimeExternalConstructorAbi('Promise', [1]),
  createHaxeRuntimeExternalConstructorAbi('Proxy', [2]),
  createHaxeRuntimeExternalConstructorAbi('RangeError', [0, 1]),
  createHaxeRuntimeExternalConstructorAbi('RegExp', [0, 1, 2]),
  createHaxeRuntimeExternalConstructorAbi('Set', [0, 1]),
  createHaxeRuntimeExternalConstructorAbi('SharedArrayBuffer', [1]),
  createHaxeRuntimeExternalConstructorAbi('TextDecoder', [0, 1, 2]),
  createHaxeRuntimeExternalConstructorAbi('TextEncoder', [0]),
  createHaxeRuntimeExternalConstructorAbi('TypeError', [0, 1]),
  createHaxeRuntimeExternalConstructorAbi('Uint16Array', [0, 1, 2, 3]),
  createHaxeRuntimeExternalConstructorAbi('Uint32Array', [0, 1, 2, 3]),
  createHaxeRuntimeExternalConstructorAbi('Uint8Array', [0, 1, 2, 3]),
  createHaxeRuntimeExternalConstructorAbi('Uint8ClampedArray', [0, 1, 2, 3]),
  createHaxeRuntimeExternalConstructorAbi('URL', [1, 2]),
  createHaxeRuntimeExternalConstructorAbi('WeakMap', [0, 1]),
  createHaxeRuntimeExternalConstructorAbi('WeakSet', [0, 1]),
  createHaxeRuntimeExternalConstructorAbi('WebSocket', [1, 2]),
] as const;

function createHaxeRuntimeExternalConstructorAbi(sourceName: string, fixedArgumentCounts: readonly number[]) {
  return {
    dynamicArguments: false,
    externalSymbol: { sourceName, space: 'value' },
    fixedArgumentCounts,
  } as const;
}
