import type {
  CompilerRuntimeCapabilityName,
  CompilerRuntimeExternalTypeBinding,
  CompilerRuntimeExternalTypeBindingPlan,
} from '../../compiler-types/src/index.js';

type RustRuntimeExternalTypeBinding =
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

export function createCompilerRuntimeExternalTypeBindingPlanRust(): CompilerRuntimeExternalTypeBindingPlan {
  return {
    bindings: rustRuntimeExternalTypeBindings.map((binding) =>
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

export function getCompilerRuntimeExternalTypeTargetRust(sourceName: string): string | undefined {
  return rustRuntimeExternalTypeBindings.find((candidate) => candidate.sourceName === sourceName.normalize('NFC'))
    ?.targetName;
}

const rustRuntimeExternalTypeBindings = [
  { kind: 'native', sourceName: 'Array', targetName: 'Vec' },
  { kind: 'native', sourceName: 'Boolean', targetName: 'bool' },
  { kind: 'native', sourceName: 'Float32Array', targetName: 'Vec<f32>' },
  { kind: 'native', sourceName: 'Float64Array', targetName: 'Vec<f64>' },
  { kind: 'native', sourceName: 'Int16Array', targetName: 'Vec<i16>' },
  { kind: 'native', sourceName: 'Int32Array', targetName: 'Vec<i32>' },
  { kind: 'native', sourceName: 'Int8Array', targetName: 'Vec<i8>' },
  { kind: 'native', sourceName: 'Map', targetName: 'std::collections::HashMap' },
  { capability: 'task', kind: 'runtime', sourceName: 'Promise', targetName: 'FlightTask' },
  { kind: 'native', sourceName: 'Set', targetName: 'std::collections::HashSet' },
  { kind: 'native', sourceName: 'Uint16Array', targetName: 'Vec<u16>' },
  { kind: 'native', sourceName: 'Uint32Array', targetName: 'Vec<u32>' },
  { kind: 'native', sourceName: 'Uint8Array', targetName: 'Vec<u8>' },
  { kind: 'native', sourceName: 'Uint8ClampedArray', targetName: 'Vec<u8>' },
] as const satisfies readonly RustRuntimeExternalTypeBinding[];
