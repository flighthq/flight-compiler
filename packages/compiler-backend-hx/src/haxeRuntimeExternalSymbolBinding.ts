import type {
  CompilerRuntimeCapabilityName,
  CompilerRuntimeExternalSymbolBinding,
  CompilerRuntimeExternalSymbolBindingPlan,
  CompilerRuntimeExternalSymbolSpace,
} from '../../compiler-types/src/index.js';

type HaxeRuntimeExternalSymbolBinding =
  | Readonly<{
      kind: Extract<CompilerRuntimeExternalSymbolBinding, { kind: 'native' }>['kind'];
      sourceName: string;
      space: CompilerRuntimeExternalSymbolSpace;
      targetName: string;
    }>
  | Readonly<{
      capability: CompilerRuntimeCapabilityName;
      kind: Extract<CompilerRuntimeExternalSymbolBinding, { kind: 'runtime' }>['kind'];
      sourceName: string;
      space: CompilerRuntimeExternalSymbolSpace;
      targetName: string;
    }>;

export function createCompilerRuntimeExternalSymbolBindingPlanHaxe(): CompilerRuntimeExternalSymbolBindingPlan {
  return {
    bindings: haxeRuntimeExternalSymbolBindings.map((binding) =>
      binding.kind === 'runtime'
        ? {
            capability: binding.capability,
            externalSymbol: { sourceName: binding.sourceName, space: binding.space },
            kind: binding.kind,
          }
        : {
            externalSymbol: { sourceName: binding.sourceName, space: binding.space },
            kind: binding.kind,
          },
    ),
    contract: 'flight-runtime-contract/2',
  };
}

export function getCompilerRuntimeExternalSymbolTargetHaxe(
  sourceName: string,
  space: CompilerRuntimeExternalSymbolSpace,
  runtimeModule = 'flighthq._internal',
): string | undefined {
  const normalized = sourceName.normalize('NFC');
  const binding = haxeRuntimeExternalSymbolBindings.find(
    (candidate) => candidate.sourceName === normalized && candidate.space === space,
  );
  if (!binding) return undefined;
  return binding.kind === 'runtime' ? `${runtimeModule}.${binding.targetName}` : binding.targetName;
}

const haxeRuntimeExternalSymbolBindings = [
  { kind: 'native', sourceName: 'Array', space: 'type', targetName: 'Array' },
  { kind: 'native', sourceName: 'Array', space: 'value', targetName: 'Array' },
  { kind: 'native', sourceName: 'Boolean', space: 'type', targetName: 'Bool' },
  { capability: 'date', kind: 'runtime', sourceName: 'Date', space: 'type', targetName: '_Date' },
  { capability: 'date', kind: 'runtime', sourceName: 'Date', space: 'value', targetName: '_Date' },
  { kind: 'native', sourceName: 'Error', space: 'type', targetName: 'haxe.Exception' },
  { kind: 'native', sourceName: 'Error', space: 'value', targetName: 'haxe.Exception' },
  {
    capability: 'float32-array',
    kind: 'runtime',
    sourceName: 'Float32Array',
    space: 'type',
    targetName: '_Float32Array',
  },
  {
    capability: 'float32-array',
    kind: 'runtime',
    sourceName: 'Float32Array',
    space: 'value',
    targetName: '_Float32Array',
  },
  {
    capability: 'float64-array',
    kind: 'runtime',
    sourceName: 'Float64Array',
    space: 'type',
    targetName: '_Float64Array',
  },
  {
    capability: 'float64-array',
    kind: 'runtime',
    sourceName: 'Float64Array',
    space: 'value',
    targetName: '_Float64Array',
  },
  {
    capability: 'int16-array',
    kind: 'runtime',
    sourceName: 'Int16Array',
    space: 'type',
    targetName: '_Int16Array',
  },
  {
    capability: 'int16-array',
    kind: 'runtime',
    sourceName: 'Int16Array',
    space: 'value',
    targetName: '_Int16Array',
  },
  {
    capability: 'int32-array',
    kind: 'runtime',
    sourceName: 'Int32Array',
    space: 'type',
    targetName: '_Int32Array',
  },
  {
    capability: 'int32-array',
    kind: 'runtime',
    sourceName: 'Int32Array',
    space: 'value',
    targetName: '_Int32Array',
  },
  {
    capability: 'int8-array',
    kind: 'runtime',
    sourceName: 'Int8Array',
    space: 'type',
    targetName: '_Int8Array',
  },
  {
    capability: 'int8-array',
    kind: 'runtime',
    sourceName: 'Int8Array',
    space: 'value',
    targetName: '_Int8Array',
  },
  { capability: 'map', kind: 'runtime', sourceName: 'Map', space: 'type', targetName: '_Map' },
  { capability: 'map', kind: 'runtime', sourceName: 'Map', space: 'value', targetName: '_Map' },
  { kind: 'native', sourceName: 'Math', space: 'value', targetName: 'Math' },
  { capability: 'task', kind: 'runtime', sourceName: 'Promise', space: 'type', targetName: '_Promise' },
  { capability: 'task', kind: 'runtime', sourceName: 'Promise', space: 'value', targetName: '_Promise' },
  { capability: 'set', kind: 'runtime', sourceName: 'Set', space: 'type', targetName: '_Set' },
  { capability: 'set', kind: 'runtime', sourceName: 'Set', space: 'value', targetName: '_Set' },
  {
    capability: 'uint16-array',
    kind: 'runtime',
    sourceName: 'Uint16Array',
    space: 'type',
    targetName: '_UInt16Array',
  },
  {
    capability: 'uint16-array',
    kind: 'runtime',
    sourceName: 'Uint16Array',
    space: 'value',
    targetName: '_UInt16Array',
  },
  {
    capability: 'uint32-array',
    kind: 'runtime',
    sourceName: 'Uint32Array',
    space: 'type',
    targetName: '_UInt32Array',
  },
  {
    capability: 'uint32-array',
    kind: 'runtime',
    sourceName: 'Uint32Array',
    space: 'value',
    targetName: '_UInt32Array',
  },
  {
    capability: 'uint8-array',
    kind: 'runtime',
    sourceName: 'Uint8Array',
    space: 'type',
    targetName: '_UInt8Array',
  },
  {
    capability: 'uint8-array',
    kind: 'runtime',
    sourceName: 'Uint8Array',
    space: 'value',
    targetName: '_UInt8Array',
  },
  {
    capability: 'uint8-clamped-array',
    kind: 'runtime',
    sourceName: 'Uint8ClampedArray',
    space: 'type',
    targetName: '_UInt8ClampedArray',
  },
  {
    capability: 'uint8-clamped-array',
    kind: 'runtime',
    sourceName: 'Uint8ClampedArray',
    space: 'value',
    targetName: '_UInt8ClampedArray',
  },
  { capability: 'weak-map', kind: 'runtime', sourceName: 'WeakMap', space: 'type', targetName: '_WeakMap' },
  { capability: 'weak-map', kind: 'runtime', sourceName: 'WeakMap', space: 'value', targetName: '_WeakMap' },
] as const satisfies readonly HaxeRuntimeExternalSymbolBinding[];
