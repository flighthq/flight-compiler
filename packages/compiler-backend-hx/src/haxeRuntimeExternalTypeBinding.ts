import type {
  CompilerRuntimeCapabilityName,
  CompilerRuntimeExternalTypeBinding,
  CompilerRuntimeExternalTypeBindingPlan,
} from '../../compiler-types/src/index.js';

type HaxeRuntimeExternalTypeBinding =
  | Readonly<{
      kind: Extract<CompilerRuntimeExternalTypeBinding, { kind: 'native' }>['kind'];
      sourceName: string;
      targetName: string;
    }>
  | Readonly<{
      capability: CompilerRuntimeCapabilityName;
      kind: Extract<CompilerRuntimeExternalTypeBinding, { kind: 'runtime' }>['kind'];
      sourceName: string;
      targetName: string;
    }>;

export function createCompilerRuntimeExternalTypeBindingPlanHaxe(): CompilerRuntimeExternalTypeBindingPlan {
  return {
    bindings: haxeRuntimeExternalTypeBindings.map((binding) =>
      binding.kind === 'runtime'
        ? {
            capability: binding.capability,
            externalType: { sourceName: binding.sourceName },
            kind: binding.kind,
          }
        : { externalType: { sourceName: binding.sourceName }, kind: binding.kind },
    ),
    contract: 'flight-runtime-contract/1',
  };
}

export function getCompilerRuntimeExternalTypeTargetHaxe(
  sourceName: string,
  runtimeModule = 'flighthq._internal',
): string | undefined {
  const binding = haxeRuntimeExternalTypeBindings.find(
    (candidate) => candidate.sourceName === sourceName.normalize('NFC'),
  );
  if (!binding) return undefined;
  return binding.kind === 'runtime' ? `${runtimeModule}.${binding.targetName}` : binding.targetName;
}

const haxeRuntimeExternalTypeBindings = [
  { kind: 'native', sourceName: 'Array', targetName: 'Array' },
  { kind: 'native', sourceName: 'Boolean', targetName: 'Bool' },
  { capability: 'float32-array', kind: 'runtime', sourceName: 'Float32Array', targetName: '_Float32Array' },
  { capability: 'float64-array', kind: 'runtime', sourceName: 'Float64Array', targetName: '_Float64Array' },
  { capability: 'int16-array', kind: 'runtime', sourceName: 'Int16Array', targetName: '_Int16Array' },
  { capability: 'int32-array', kind: 'runtime', sourceName: 'Int32Array', targetName: '_Int32Array' },
  { capability: 'int8-array', kind: 'runtime', sourceName: 'Int8Array', targetName: '_Int8Array' },
  { capability: 'map', kind: 'runtime', sourceName: 'Map', targetName: '_Map' },
  { capability: 'task', kind: 'runtime', sourceName: 'Promise', targetName: '_Promise' },
  { capability: 'set', kind: 'runtime', sourceName: 'Set', targetName: '_Set' },
  { capability: 'uint16-array', kind: 'runtime', sourceName: 'Uint16Array', targetName: '_UInt16Array' },
  { capability: 'uint32-array', kind: 'runtime', sourceName: 'Uint32Array', targetName: '_UInt32Array' },
  { capability: 'uint8-array', kind: 'runtime', sourceName: 'Uint8Array', targetName: '_UInt8Array' },
  {
    capability: 'uint8-clamped-array',
    kind: 'runtime',
    sourceName: 'Uint8ClampedArray',
    targetName: '_UInt8ClampedArray',
  },
] as const satisfies readonly HaxeRuntimeExternalTypeBinding[];
